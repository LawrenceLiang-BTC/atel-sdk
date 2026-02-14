/**
 * Module: Handshake Protocol
 *
 * Mutual identity verification + encrypted session establishment.
 * Uses challenge-response with Ed25519 signatures and X25519 key exchange.
 *
 * Flow:
 *   A → B: handshake_init  {did_a, pubkey_a, enc_pubkey_a, challenge_a}
 *   B → A: handshake_ack   {did_b, pubkey_b, enc_pubkey_b, challenge_b, sign(challenge_a)}
 *   A → B: handshake_confirm {sign(challenge_b)}
 *   ✅ Encrypted session established (X25519 shared secret derived)
 */

import { randomUUID, randomBytes } from 'node:crypto';
import type { AgentIdentity } from '../identity/index.js';
import { verify, parseDID } from '../identity/index.js';
import {
  createMessage,
  verifyMessage,
  type ATELMessage,
} from '../envelope/index.js';
import {
  generateEncryptionKeyPair,
  deriveSharedKey,
  EncryptionManager,
  type EncryptionKeyPair,
} from '../crypto/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** Handshake init payload */
export interface HandshakeInitPayload {
  did: string;
  publicKey: string; // Ed25519 identity key, base64
  encPublicKey: string; // X25519 encryption key, base64
  challenge: string;
  capabilities?: string[];
  /** Wallet addresses for on-chain trust verification */
  wallets?: { solana?: string; base?: string; bsc?: string };
}

/** Handshake ack payload */
export interface HandshakeAckPayload {
  did: string;
  publicKey: string; // Ed25519 identity key, base64
  encPublicKey: string; // X25519 encryption key, base64
  challenge: string;
  challengeResponse: string; // sign(their_challenge, my_sk)
  capabilities?: string[];
  /** Wallet addresses for on-chain trust verification */
  wallets?: { solana?: string; base?: string; bsc?: string };
}

/** Handshake confirm payload */
export interface HandshakeConfirmPayload {
  challengeResponse: string; // sign(their_challenge, my_sk)
}

/** An established session between two agents */
export interface Session {
  /** Unique session identifier */
  sessionId: string;
  /** Local agent DID */
  localDid: string;
  /** Remote agent DID */
  remoteDid: string;
  /** Remote agent's Ed25519 public key */
  remotePublicKey: Uint8Array;
  /** Whether E2E encryption is active for this session */
  encrypted: boolean;
  /** Remote agent's capabilities (if provided) */
  remoteCapabilities?: string[];
  /** Remote agent's wallet addresses (if provided) */
  remoteWallets?: { solana?: string; base?: string; bsc?: string };
  /** Session creation timestamp */
  createdAt: string;
  /** Session expiry timestamp */
  expiresAt: string;
  /** Session state */
  state: 'active' | 'expired';
}

/** Handshake configuration */
export interface HandshakeConfig {
  /** Session TTL in seconds (default: 3600 = 1 hour) */
  sessionTtlSec?: number;
  /** Challenge length in bytes (default: 32) */
  challengeBytes?: number;
  /** Enable E2E encryption (default: true) */
  enableEncryption?: boolean;
}

// ─── Custom Errors ───────────────────────────────────────────────

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeError';
  }
}

// ─── Handshake Manager ───────────────────────────────────────────

/**
 * Manages handshake flows, active sessions, and encryption.
 *
 * Supports both initiator and responder roles.
 * Automatically establishes E2E encryption during handshake.
 */
export class HandshakeManager {
  private readonly identity: AgentIdentity;
  private readonly sessionTtlSec: number;
  private readonly challengeBytes: number;
  private readonly enableEncryption: boolean;
  private readonly sessions: Map<string, Session> = new Map();
  private readonly pendingChallenges: Map<string, string> = new Map();
  private readonly pendingEncKeys: Map<string, EncryptionKeyPair> = new Map();

  /** Encryption manager for E2E encrypted communication */
  readonly encryption: EncryptionManager;

  constructor(identity: AgentIdentity, config?: HandshakeConfig) {
    this.identity = identity;
    this.sessionTtlSec = config?.sessionTtlSec ?? 3600;
    this.challengeBytes = config?.challengeBytes ?? 32;
    this.enableEncryption = config?.enableEncryption ?? true;
    this.encryption = new EncryptionManager();
  }

  // ── Initiator Side ───────────────────────────────────────────

  /**
   * Create a handshake_init message (Step 1).
   */
  createInit(remoteDid: string, wallets?: { solana?: string; base?: string; bsc?: string }): ATELMessage<HandshakeInitPayload> {
    const challenge = randomBytes(this.challengeBytes).toString('hex');
    this.pendingChallenges.set(remoteDid, challenge);

    // Generate ephemeral X25519 key pair for this handshake
    const encKeyPair = generateEncryptionKeyPair();
    this.pendingEncKeys.set(remoteDid, encKeyPair);

    return createMessage<HandshakeInitPayload>({
      type: 'handshake_init',
      from: this.identity.did,
      to: remoteDid,
      payload: {
        did: this.identity.did,
        publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
        encPublicKey: Buffer.from(encKeyPair.publicKey).toString('base64'),
        challenge,
        wallets,
      },
      secretKey: this.identity.secretKey,
    });
  }

  /**
   * Process a handshake_ack message and create handshake_confirm (Step 3).
   */
  processAck(ackMessage: ATELMessage<HandshakeAckPayload>): {
    confirm: ATELMessage<HandshakeConfirmPayload>;
    session: Session;
  } {
    const payload = ackMessage.payload;

    // Verify the ack message signature
    const remotePubKey = Uint8Array.from(Buffer.from(payload.publicKey, 'base64'));
    const msgResult = verifyMessage(ackMessage, remotePubKey, { skipTimestampCheck: false });
    if (!msgResult.valid) {
      throw new HandshakeError(`Handshake ack verification failed: ${msgResult.error}`);
    }

    // Verify the challenge response
    const ourChallenge = this.pendingChallenges.get(payload.did);
    if (!ourChallenge) {
      throw new HandshakeError(`No pending handshake with ${payload.did}`);
    }

    if (!verify(ourChallenge, payload.challengeResponse, remotePubKey)) {
      throw new HandshakeError('Challenge response verification failed');
    }

    this.pendingChallenges.delete(payload.did);

    // Establish E2E encryption
    let encrypted = false;
    if (this.enableEncryption && payload.encPublicKey) {
      const remoteEncPubKey = Uint8Array.from(Buffer.from(payload.encPublicKey, 'base64'));
      this.encryption.createSession(payload.did, remoteEncPubKey);

      // Override with our pending key pair for correct DH
      const ourEncKeyPair = this.pendingEncKeys.get(payload.did);
      if (ourEncKeyPair) {
        // Re-derive using our actual ephemeral key
        const sharedKey = deriveSharedKey(ourEncKeyPair.secretKey, remoteEncPubKey);
        this.encryption.destroySession(payload.did);
        // Manually create session with correct keys
        this.encryption.createSessionWithKeys(payload.did, ourEncKeyPair, remoteEncPubKey, sharedKey);
        this.pendingEncKeys.delete(payload.did);
        encrypted = true;
      }
    }

    // Sign their challenge
    const challengeResponse = this.identity.sign(payload.challenge);

    const confirm = createMessage<HandshakeConfirmPayload>({
      type: 'handshake_confirm',
      from: this.identity.did,
      to: payload.did,
      payload: { challengeResponse },
      secretKey: this.identity.secretKey,
    });

    const session = this.createSession(payload.did, remotePubKey, encrypted, payload.capabilities, payload.wallets);

    return { confirm, session };
  }

  // ── Responder Side ───────────────────────────────────────────

  /**
   * Process a handshake_init message and create handshake_ack (Step 2).
   */
  processInit(initMessage: ATELMessage<HandshakeInitPayload>, wallets?: { solana?: string; base?: string; bsc?: string }): ATELMessage<HandshakeAckPayload> {
    const payload = initMessage.payload;

    // Verify the init message signature
    const remotePubKey = Uint8Array.from(Buffer.from(payload.publicKey, 'base64'));
    const msgResult = verifyMessage(initMessage, remotePubKey, { skipTimestampCheck: false });
    if (!msgResult.valid) {
      throw new HandshakeError(`Handshake init verification failed: ${msgResult.error}`);
    }

    // Verify DID matches public key
    const didPubKey = parseDID(payload.did);
    if (Buffer.from(didPubKey).toString('base64') !== payload.publicKey) {
      throw new HandshakeError('DID does not match provided public key');
    }

    // Generate our challenge
    const ourChallenge = randomBytes(this.challengeBytes).toString('hex');
    this.pendingChallenges.set(payload.did, ourChallenge);

    // Generate ephemeral X25519 key pair and set up encryption
    const encKeyPair = generateEncryptionKeyPair();
    if (this.enableEncryption && payload.encPublicKey) {
      const remoteEncPubKey = Uint8Array.from(Buffer.from(payload.encPublicKey, 'base64'));
      const sharedKey = deriveSharedKey(encKeyPair.secretKey, remoteEncPubKey);
      this.encryption.createSessionWithKeys(payload.did, encKeyPair, remoteEncPubKey, sharedKey);
    }

    // Sign their challenge
    const challengeResponse = this.identity.sign(payload.challenge);

    return createMessage<HandshakeAckPayload>({
      type: 'handshake_ack',
      from: this.identity.did,
      to: payload.did,
      payload: {
        did: this.identity.did,
        publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
        encPublicKey: Buffer.from(encKeyPair.publicKey).toString('base64'),
        challenge: ourChallenge,
        challengeResponse,
        wallets,
      },
      secretKey: this.identity.secretKey,
    });
  }

  /**
   * Process a handshake_confirm message (Step 3, responder side).
   */
  processConfirm(
    confirmMessage: ATELMessage<HandshakeConfirmPayload>,
    initiatorPublicKey: Uint8Array,
    initiatorCapabilities?: string[],
    initiatorWallets?: { solana?: string; base?: string; bsc?: string },
  ): Session {
    const payload = confirmMessage.payload;

    const msgResult = verifyMessage(confirmMessage, initiatorPublicKey, { skipTimestampCheck: false });
    if (!msgResult.valid) {
      throw new HandshakeError(`Handshake confirm verification failed: ${msgResult.error}`);
    }

    const ourChallenge = this.pendingChallenges.get(confirmMessage.from);
    if (!ourChallenge) {
      throw new HandshakeError(`No pending handshake with ${confirmMessage.from}`);
    }

    if (!verify(ourChallenge, payload.challengeResponse, initiatorPublicKey)) {
      throw new HandshakeError('Challenge response verification failed');
    }

    this.pendingChallenges.delete(confirmMessage.from);

    const encrypted = this.encryption.hasSession(confirmMessage.from);
    return this.createSession(confirmMessage.from, initiatorPublicKey, encrypted, initiatorCapabilities, initiatorWallets);
  }

  // ── Session Management ───────────────────────────────────────

  getSession(remoteDid: string): Session | undefined {
    const session = this.sessions.get(remoteDid);
    if (!session) return undefined;

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      session.state = 'expired';
      this.sessions.delete(remoteDid);
      this.encryption.destroySession(remoteDid);
      return undefined;
    }

    return session;
  }

  hasActiveSession(remoteDid: string): boolean {
    return this.getSession(remoteDid) !== undefined;
  }

  getActiveSessions(): Session[] {
    const now = Date.now();
    const active: Session[] = [];
    for (const [did, session] of this.sessions) {
      if (new Date(session.expiresAt).getTime() < now) {
        session.state = 'expired';
        this.sessions.delete(did);
        this.encryption.destroySession(did);
      } else {
        active.push(session);
      }
    }
    return active;
  }

  terminateSession(remoteDid: string): void {
    this.sessions.delete(remoteDid);
    this.encryption.destroySession(remoteDid);
  }

  // ── Private ──────────────────────────────────────────────────

  private createSession(
    remoteDid: string,
    remotePublicKey: Uint8Array,
    encrypted: boolean,
    remoteCapabilities?: string[],
    remoteWallets?: { solana?: string; base?: string; bsc?: string },
  ): Session {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlSec * 1000);

    const session: Session = {
      sessionId: randomUUID(),
      localDid: this.identity.did,
      remoteDid,
      remotePublicKey,
      encrypted,
      remoteCapabilities,
      remoteWallets,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      state: 'active',
    };

    this.sessions.set(remoteDid, session);
    return session;
  }
}
