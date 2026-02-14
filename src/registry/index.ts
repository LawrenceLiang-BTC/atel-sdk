/**
 * Module: Agent Registry Client (Discovery / Yellow Pages)
 *
 * Client for interacting with the ATEL Registry Service.
 * All mutations require DID signature authentication.
 *
 * The RegistryService (server) is maintained separately
 * and is NOT included in the SDK distribution.
 */

import { verify as verifySig, parseDID, serializePayload } from '../identity/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** A registered agent entry in the registry */
export interface RegistryEntry {
  did: string;
  name: string;
  description?: string;
  capabilities: RegistryCapability[];
  endpoint: string;
  trustScore: number;
  registeredAt: string;
  lastSeen: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
}

/** Capability entry in the registry */
export interface RegistryCapability {
  type: string;
  description: string;
  maxRiskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

/** Signed request body for authenticated operations */
export interface SignedRequest<T = unknown> {
  /** The request payload */
  payload: T;
  /** Signer's DID */
  did: string;
  /** ISO 8601 timestamp (for freshness check) */
  timestamp: string;
  /** Ed25519 signature over {payload, did, timestamp} */
  signature: string;
}

/** Search parameters for finding agents */
export interface RegistrySearchParams {
  type?: string;
  minScore?: number;
  verifiedOnly?: boolean;
  limit?: number;
  sortBy?: 'score' | 'recent';
}

/** Registry client configuration */
export interface RegistryClientConfig {
  registryUrl: string;
  timeoutMs?: number;
}

// ─── Registry Client ─────────────────────────────────────────────

/**
 * Client for interacting with the ATEL Registry Service.
 * Supports authenticated operations via DID signatures.
 */
export class RegistryClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: RegistryClientConfig) {
    this.baseUrl = config.registryUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * Create a signed request body.
   */
  private createSignedRequest<T>(
    payload: T,
    identity: import('../identity/index.js').AgentIdentity,
  ): SignedRequest<T> {
    const timestamp = new Date().toISOString();
    const signable = serializePayload({ payload, did: identity.did, timestamp });
    const signature = identity.sign(signable);
    return { payload, did: identity.did, timestamp, signature };
  }

  /**
   * Register this agent (authenticated).
   */
  async register(
    entry: Omit<RegistryEntry, 'did' | 'trustScore' | 'registeredAt' | 'lastSeen' | 'verified'>,
    identity: import('../identity/index.js').AgentIdentity,
  ): Promise<RegistryEntry> {
    const signed = this.createSignedRequest(entry, identity);
    return this.post('/registry/v1/register', signed);
  }

  /**
   * Search for agents (public, no auth).
   */
  async search(params: RegistrySearchParams): Promise<{ count: number; agents: RegistryEntry[] }> {
    const query = new URLSearchParams();
    if (params.type) query.set('type', params.type);
    if (params.minScore !== undefined) query.set('minScore', String(params.minScore));
    if (params.verifiedOnly) query.set('verifiedOnly', 'true');
    if (params.limit) query.set('limit', String(params.limit));
    if (params.sortBy) query.set('sortBy', params.sortBy);
    return this.get(`/registry/v1/search?${query.toString()}`);
  }

  /**
   * Get a specific agent's registry entry (public).
   */
  async getAgent(did: string): Promise<RegistryEntry> {
    return this.get(`/registry/v1/agent/${encodeURIComponent(did)}`);
  }

  /**
   * Send a heartbeat (authenticated).
   */
  async heartbeat(identity: import('../identity/index.js').AgentIdentity): Promise<void> {
    const signed = this.createSignedRequest({ did: identity.did }, identity);
    await this.post('/registry/v1/heartbeat', signed);
  }

  /**
   * Unregister an agent (authenticated).
   */
  async unregister(identity: import('../identity/index.js').AgentIdentity): Promise<void> {
    const signed = this.createSignedRequest({}, identity);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await fetch(`${this.baseUrl}/registry/v1/agent/${encodeURIComponent(identity.did)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get registry statistics (public).
   */
  async stats(): Promise<{ totalAgents: number; verifiedAgents: number; capabilityTypes: string[] }> {
    return this.get('/registry/v1/stats');
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Registry request failed (${response.status}): ${text}`);
      }
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Registry request failed (${response.status}): ${text}`);
      }
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeout);
    }
  }
}
