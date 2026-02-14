/**
 * Module: Agent Endpoint
 *
 * Lightweight HTTP server that exposes standard ATEL endpoints
 * for inter-agent communication with E2E encryption support.
 *
 * Security features:
 *   - Ed25519 signature verification on all messages
 *   - Nonce-based replay protection
 *   - Optional E2E encryption (XSalsa20-Poly1305 via handshake)
 *   - Rate limiting per remote DID
 *
 * Endpoints:
 *   POST /atel/v1/handshake   — Identity handshake + key exchange
 *   POST /atel/v1/task        — Receive task delegation
 *   POST /atel/v1/proof       — Receive execution proof
 *   POST /atel/v1/trust/query — Trust query
 *   GET  /atel/v1/capability  — Capability declaration
 *   GET  /atel/v1/health      — Health check
 */

import express, { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import https from 'node:https';
import type { AgentIdentity } from '../identity/index.js';
import { parseDID } from '../identity/index.js';
import {
  verifyMessage,
  NonceTracker,
  type ATELMessage,
} from '../envelope/index.js';
import {
  HandshakeManager,
  type HandshakeConfig,
  type HandshakeInitPayload,
  type HandshakeConfirmPayload,
} from '../handshake/index.js';
import type { EncryptedPayload } from '../crypto/index.js';
import type { Capability } from '../schema/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** TLS configuration for HTTPS */
export interface TlsConfig {
  /** PEM-encoded certificate */
  cert: string;
  /** PEM-encoded private key */
  key: string;
  /** PEM-encoded CA certificate (optional, for mutual TLS) */
  ca?: string;
}

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/** Configuration for the Agent Endpoint server */
export interface EndpointConfig {
  /** Port to listen on */
  port: number;
  /** Optional hostname (default: '0.0.0.0') */
  host?: string;
  /** Handshake configuration */
  handshake?: HandshakeConfig;
  /** Capability declaration for this agent */
  capability?: Capability;
  /** TLS configuration for HTTPS (strongly recommended for production) */
  tls?: TlsConfig;
  /** Rate limiting (default: 100 req/min per DID) */
  rateLimit?: RateLimitConfig;
}

/** Handler for incoming task delegations */
export type TaskHandler = (
  message: ATELMessage,
  session: import('../handshake/index.js').Session | undefined,
) => Promise<unknown>;

/** Handler for incoming proof responses */
export type ProofHandler = (
  message: ATELMessage,
  session: import('../handshake/index.js').Session | undefined,
) => Promise<void>;

/** Handler for trust queries */
export type TrustQueryHandler = (
  message: ATELMessage,
  session: import('../handshake/index.js').Session | undefined,
) => Promise<unknown>;

// ─── Custom Errors ───────────────────────────────────────────────

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointError';
  }
}

// ─── Rate Limiter ────────────────────────────────────────────────

class RateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(config?: RateLimitConfig) {
    this.maxRequests = config?.maxRequests ?? 100;
    this.windowMs = config?.windowMs ?? 60_000;
  }

  check(key: string): boolean {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || now > window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (window.count >= this.maxRequests) {
      return false;
    }

    window.count++;
    return true;
  }
}

// ─── Agent Endpoint ──────────────────────────────────────────────

/**
 * HTTP/HTTPS server for receiving ATEL messages.
 *
 * Handles handshakes, task delegations, proof responses,
 * and trust queries with automatic signature verification
 * and optional E2E encryption.
 */
export class AgentEndpoint {
  readonly app: express.Application;
  readonly identity: AgentIdentity;
  readonly handshakeManager: HandshakeManager;
  private readonly nonceTracker: NonceTracker;
  private readonly rateLimiter: RateLimiter;
  private readonly config: EndpointConfig;
  private server: Server | null = null;

  private taskHandler?: TaskHandler;
  private proofHandler?: ProofHandler;
  private trustQueryHandler?: TrustQueryHandler;
  private capability?: Capability;

  constructor(identity: AgentIdentity, config: EndpointConfig) {
    this.identity = identity;
    this.config = config;
    this.capability = config.capability;
    this.app = express();
    this.handshakeManager = new HandshakeManager(identity, config.handshake);
    this.nonceTracker = new NonceTracker();
    this.rateLimiter = new RateLimiter(config.rateLimit);

    this.app.use(express.json({ limit: '1mb' }));
    this.setupRoutes();
    this.app.use(this.errorHandler.bind(this));
  }

  // ── Handler Registration ─────────────────────────────────────

  onTask(handler: TaskHandler): void { this.taskHandler = handler; }
  onProof(handler: ProofHandler): void { this.proofHandler = handler; }
  onTrustQuery(handler: TrustQueryHandler): void { this.trustQueryHandler = handler; }
  setCapability(capability: Capability): void { this.capability = capability; }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const host = this.config.host ?? '0.0.0.0';

      if (this.config.tls) {
        this.server = https.createServer(
          { cert: this.config.tls.cert, key: this.config.tls.key, ca: this.config.tls.ca },
          this.app,
        ).listen(this.config.port, host, () => {
          console.log(`[ATEL Endpoint] ${this.identity.did} listening on ${host}:${this.config.port} (TLS)`);
          resolve();
        });
      } else {
        this.server = this.app.listen(this.config.port, host, () => {
          console.log(`[ATEL Endpoint] ${this.identity.did} listening on ${host}:${this.config.port}`);
          resolve();
        });
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = null;
    });
  }

  getEndpointUrl(): string {
    const host = this.config.host ?? 'localhost';
    const protocol = this.config.tls ? 'https' : 'http';
    return `${protocol}://${host}:${this.config.port}`;
  }

  // ── Routes ───────────────────────────────────────────────────

  private setupRoutes(): void {
    const r = express.Router();

    r.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        did: this.identity.did,
        timestamp: new Date().toISOString(),
        activeSessions: this.handshakeManager.getActiveSessions().length,
        tls: !!this.config.tls,
        encryption: true,
      });
    });

    r.get('/capability', (_req: Request, res: Response) => {
      if (!this.capability) {
        res.status(404).json({ error: 'No capability declared' });
        return;
      }
      res.json(this.capability);
    });

    // Handshake endpoint
    r.post('/handshake', (req: Request, res: Response, next: NextFunction) => {
      try {
        const message = req.body as ATELMessage;

        if (message.type === 'handshake_init') {
          const ack = this.handshakeManager.processInit(
            message as ATELMessage<HandshakeInitPayload>,
          );
          res.json(ack);
        } else if (message.type === 'handshake_confirm') {
          const initiatorPubKey = parseDID(message.from);
          const session = this.handshakeManager.processConfirm(
            message as ATELMessage<HandshakeConfirmPayload>,
            initiatorPubKey,
          );
          res.json({ status: 'ok', sessionId: session.sessionId, encrypted: session.encrypted });
        } else {
          res.status(400).json({ error: `Unexpected handshake message type: ${message.type}` });
        }
      } catch (err) {
        next(err);
      }
    });

    // Task delegation (supports encrypted payloads)
    r.post('/task', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const message = this.decryptIfNeeded(req.body as ATELMessage);

        const verifyResult = this.verifyIncoming(message);
        if (!verifyResult.valid) {
          res.status(401).json({ error: verifyResult.error });
          return;
        }

        if (!this.taskHandler) {
          res.status(501).json({ error: 'No task handler registered' });
          return;
        }

        const session = this.handshakeManager.getSession(message.from);
        const result = await this.taskHandler(message, session);
        res.json({ status: 'accepted', result });
      } catch (err) {
        next(err);
      }
    });

    // Proof response
    r.post('/proof', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const message = this.decryptIfNeeded(req.body as ATELMessage);

        const verifyResult = this.verifyIncoming(message);
        if (!verifyResult.valid) {
          res.status(401).json({ error: verifyResult.error });
          return;
        }

        if (!this.proofHandler) {
          res.status(501).json({ error: 'No proof handler registered' });
          return;
        }

        const session = this.handshakeManager.getSession(message.from);
        await this.proofHandler(message, session);
        res.json({ status: 'received' });
      } catch (err) {
        next(err);
      }
    });

    // Trust query
    r.post('/trust/query', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const message = this.decryptIfNeeded(req.body as ATELMessage);

        const verifyResult = this.verifyIncoming(message);
        if (!verifyResult.valid) {
          res.status(401).json({ error: verifyResult.error });
          return;
        }

        if (!this.trustQueryHandler) {
          res.status(501).json({ error: 'No trust query handler registered' });
          return;
        }

        const session = this.handshakeManager.getSession(message.from);
        const result = await this.trustQueryHandler(message, session);
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.use('/atel/v1', r);
  }

  // ── Message Verification ─────────────────────────────────────

  private verifyIncoming(message: ATELMessage): { valid: boolean; error?: string } {
    // Rate limiting
    if (!this.rateLimiter.check(message.from)) {
      return { valid: false, error: 'Rate limit exceeded' };
    }

    // Check nonce for replay
    if (!this.nonceTracker.check(message.nonce)) {
      return { valid: false, error: 'Replay detected (duplicate nonce)' };
    }

    // Get public key from session first, then from DID
    const session = this.handshakeManager.getSession(message.from);
    let publicKey: Uint8Array;

    if (session) {
      publicKey = session.remotePublicKey;
    } else {
      try {
        publicKey = parseDID(message.from);
      } catch {
        return { valid: false, error: 'Cannot resolve sender public key' };
      }
    }

    return verifyMessage(message, publicKey);
  }

  // ── E2E Decryption ───────────────────────────────────────────

  /**
   * If the message payload is an EncryptedPayload, decrypt it.
   */
  private decryptIfNeeded(message: ATELMessage): ATELMessage {
    const payload = message.payload as any;
    if (payload && payload.enc === 'atel.enc.v1') {
      const encryption = this.handshakeManager.encryption;
      if (!encryption.hasSession(message.from)) {
        throw new EndpointError('Received encrypted message but no encryption session exists');
      }
      const decrypted = encryption.decryptFrom(message.from, payload as EncryptedPayload);
      return { ...message, payload: JSON.parse(decrypted) };
    }
    return message;
  }

  // ── Error Handling ───────────────────────────────────────────

  private errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    console.error('[ATEL Endpoint] Error:', err.message);
    const status =
      err.name === 'HandshakeError' ? 400 :
      err.name === 'CryptoError' ? 400 :
      500;
    res.status(status).json({ error: err.message });
  }
}

// ─── Agent Client ────────────────────────────────────────────────

export interface SendOptions {
  timeoutMs?: number;
  /** Encrypt the payload using the session key */
  encrypt?: boolean;
}

/**
 * Client for sending ATEL messages to remote Agent Endpoints.
 * Supports E2E encryption when a handshake session is established.
 */
export class AgentClient {
  private readonly identity: AgentIdentity;
  private readonly defaultTimeoutMs: number;

  constructor(identity: AgentIdentity, options?: { timeoutMs?: number }) {
    this.identity = identity;
    this.defaultTimeoutMs = options?.timeoutMs ?? 30_000;
  }

  /**
   * Perform a full handshake with a remote agent.
   * Establishes both identity verification and E2E encryption.
   */
  async handshake(
    remoteEndpoint: string,
    handshakeManager: HandshakeManager,
    remoteDid: string,
  ): Promise<import('../handshake/index.js').Session> {
    const initMsg = handshakeManager.createInit(remoteDid);
    const ackResponse = await this.sendRaw(
      `${remoteEndpoint}/atel/v1/handshake`,
      initMsg,
    );
    const ackMsg = ackResponse as ATELMessage<import('../handshake/index.js').HandshakeAckPayload>;

    const { confirm, session } = handshakeManager.processAck(ackMsg);
    await this.sendRaw(`${remoteEndpoint}/atel/v1/handshake`, confirm);

    return session;
  }

  /**
   * Send a task delegation, optionally encrypted.
   */
  async sendTask(
    remoteEndpoint: string,
    message: ATELMessage,
    handshakeManager?: HandshakeManager,
  ): Promise<unknown> {
    const toSend = this.maybeEncrypt(message, handshakeManager);
    return this.sendRaw(`${remoteEndpoint}/atel/v1/task`, toSend);
  }

  /**
   * Send a proof response, optionally encrypted.
   */
  async sendProof(
    remoteEndpoint: string,
    message: ATELMessage,
    handshakeManager?: HandshakeManager,
  ): Promise<void> {
    const toSend = this.maybeEncrypt(message, handshakeManager);
    await this.sendRaw(`${remoteEndpoint}/atel/v1/proof`, toSend);
  }

  async queryCapability(remoteEndpoint: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const response = await fetch(`${remoteEndpoint}/atel/v1/capability`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new EndpointError(`Capability query failed: ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(remoteEndpoint: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const response = await fetch(`${remoteEndpoint}/atel/v1/health`, {
        signal: controller.signal,
      });
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async queryTrust(
    remoteEndpoint: string,
    message: ATELMessage,
    handshakeManager?: HandshakeManager,
  ): Promise<unknown> {
    const toSend = this.maybeEncrypt(message, handshakeManager);
    return this.sendRaw(`${remoteEndpoint}/atel/v1/trust/query`, toSend);
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * If an encryption session exists with the recipient, encrypt the payload.
   */
  private maybeEncrypt(message: ATELMessage, handshakeManager?: HandshakeManager): ATELMessage {
    if (!handshakeManager) return message;

    const encryption = handshakeManager.encryption;
    if (!encryption.hasSession(message.to)) return message;

    const plaintext = JSON.stringify(message.payload);
    const encrypted = encryption.encryptFor(message.to, plaintext);
    return { ...message, payload: encrypted };
  }

  private async sendRaw(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new EndpointError(`Request failed (${response.status}): ${text}`);
      }
      return response.json();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new EndpointError(`Request timed out after ${this.defaultTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
