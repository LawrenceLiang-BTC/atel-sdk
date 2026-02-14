/**
 * Module: On-Chain Anchor
 *
 * Provides multi-chain proof anchoring — permanently recording hashes
 * (proof_id, trace_root, etc.) on public blockchains for tamper-evident
 * timestamping and auditability.
 *
 * Supported chains: Base (EVM), BSC (EVM), Solana.
 * A MockAnchorProvider is included for testing without real chain access.
 */

// ─── Types ───────────────────────────────────────────────────────

/** Supported chain identifiers */
export type ChainId = 'base' | 'solana' | 'bsc' | 'mock';

/**
 * A record of a hash anchored on-chain.
 */
export interface AnchorRecord {
  /** The hash that was anchored (typically a proof_id or trace_root) */
  hash: string;
  /** On-chain transaction hash */
  txHash: string;
  /** Chain the anchor lives on */
  chain: ChainId;
  /** Unix timestamp (ms) when the anchor was created */
  timestamp: number;
  /** Block number (if available) */
  blockNumber?: number;
  /** Arbitrary metadata attached to the anchor */
  metadata?: Record<string, unknown>;
}

/**
 * Result of verifying an on-chain anchor.
 */
export interface AnchorVerification {
  /** Whether the anchor is valid */
  valid: boolean;
  /** The hash that was checked */
  hash: string;
  /** The transaction hash that was checked */
  txHash: string;
  /** Chain identifier */
  chain: string;
  /** On-chain block timestamp (if available) */
  blockTimestamp?: number;
  /** Human-readable detail */
  detail?: string;
}

/**
 * Abstract interface for chain-specific anchor providers.
 *
 * Each provider knows how to anchor, verify, and look up hashes
 * on a single blockchain.
 */
export interface AnchorProvider {
  /** Human-readable provider name */
  readonly name: string;
  /** Chain identifier */
  readonly chain: string;

  /**
   * Anchor a hash on-chain.
   *
   * @param hash - The hash to anchor.
   * @param metadata - Optional metadata to attach.
   * @returns The anchor record with tx details.
   */
  anchor(hash: string, metadata?: Record<string, unknown>): Promise<AnchorRecord>;

  /**
   * Verify that a hash is correctly anchored in a given transaction.
   *
   * @param hash - The expected hash.
   * @param txHash - The transaction to inspect.
   * @returns Verification result.
   */
  verify(hash: string, txHash: string): Promise<AnchorVerification>;

  /**
   * Look up all anchor records for a given hash.
   *
   * @param hash - The hash to search for.
   * @returns Array of matching anchor records.
   */
  lookup(hash: string): Promise<AnchorRecord[]>;

  /**
   * Check whether this provider is available (network reachable, etc.).
   *
   * @returns True if the provider can accept requests.
   */
  isAvailable(): Promise<boolean>;
}

// ─── AnchorManager ───────────────────────────────────────────────

/**
 * Manages multiple {@link AnchorProvider}s and provides a unified API
 * for anchoring hashes across chains, with local record keeping.
 */
export class AnchorManager {
  /** Registered providers keyed by chain id */
  private providers: Map<string, AnchorProvider> = new Map();
  /** Local record store */
  private records: AnchorRecord[] = [];

  /**
   * Register an anchor provider.
   *
   * @param provider - The provider to register.
   * @throws If a provider for the same chain is already registered.
   */
  registerProvider(provider: AnchorProvider): void {
    if (this.providers.has(provider.chain)) {
      throw new Error(`Provider for chain "${provider.chain}" is already registered`);
    }
    this.providers.set(provider.chain, provider);
  }

  /**
   * Get the chain ids of all registered providers.
   */
  getProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Anchor a hash to a specific chain.
   *
   * @param hash - The hash to anchor.
   * @param chain - Target chain identifier.
   * @param metadata - Optional metadata.
   * @returns The anchor record.
   * @throws If no provider is registered for the given chain.
   */
  async anchor(
    hash: string,
    chain: ChainId | string,
    metadata?: Record<string, unknown>,
  ): Promise<AnchorRecord> {
    const provider = this.getProvider(chain);
    const record = await provider.anchor(hash, metadata);
    this.records.push(record);
    return record;
  }

  /**
   * Anchor a hash to all registered chains (multi-chain redundancy).
   *
   * Failures on individual chains are collected; the method throws only
   * if *all* chains fail.
   *
   * @param hash - The hash to anchor.
   * @param metadata - Optional metadata.
   * @returns Array of successful anchor records.
   * @throws If every provider fails.
   */
  async anchorAll(
    hash: string,
    metadata?: Record<string, unknown>,
  ): Promise<AnchorRecord[]> {
    const results: AnchorRecord[] = [];
    const errors: Array<{ chain: string; error: Error }> = [];

    for (const [chain, provider] of this.providers) {
      try {
        const record = await provider.anchor(hash, metadata);
        this.records.push(record);
        results.push(record);
      } catch (err) {
        errors.push({ chain, error: err as Error });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      const details = errors.map((e) => `${e.chain}: ${e.error.message}`).join('; ');
      throw new Error(`All anchor providers failed: ${details}`);
    }

    return results;
  }

  /**
   * Verify an anchor on a specific chain.
   *
   * @param hash - The expected hash.
   * @param txHash - The transaction hash.
   * @param chain - The chain to verify on.
   * @returns Verification result.
   */
  async verify(
    hash: string,
    txHash: string,
    chain: ChainId | string,
  ): Promise<AnchorVerification> {
    const provider = this.getProvider(chain);
    return provider.verify(hash, txHash);
  }

  /**
   * Look up all anchor records for a hash across all registered chains,
   * combining on-chain lookups with local records.
   *
   * @param hash - The hash to search for.
   * @returns Combined anchor records.
   */
  async lookup(hash: string): Promise<AnchorRecord[]> {
    const results: AnchorRecord[] = [];

    for (const provider of this.providers.values()) {
      try {
        const records = await provider.lookup(hash);
        results.push(...records);
      } catch {
        // Skip providers that fail during lookup
      }
    }

    // Also include local records that match
    for (const record of this.records) {
      if (record.hash === hash && !results.some((r) => r.txHash === record.txHash)) {
        results.push(record);
      }
    }

    return results;
  }

  /**
   * Get all locally stored anchor records.
   */
  getRecords(): AnchorRecord[] {
    return [...this.records];
  }

  /**
   * Export all local records as a JSON string for persistence.
   */
  exportRecords(): string {
    return JSON.stringify(this.records, null, 2);
  }

  /**
   * Import records from a JSON string (e.g. previously exported).
   *
   * @param json - JSON string of AnchorRecord[].
   * @throws If the JSON is invalid.
   */
  importRecords(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('importRecords expects a JSON array');
    }
    this.records.push(...(parsed as AnchorRecord[]));
  }

  /**
   * Resolve a provider by chain id.
   *
   * @throws If no provider is registered for the chain.
   */
  private getProvider(chain: string): AnchorProvider {
    const provider = this.providers.get(chain);
    if (!provider) {
      throw new Error(`No anchor provider registered for chain "${chain}"`);
    }
    return provider;
  }
}

// ─── Re-exports ──────────────────────────────────────────────────

export { EvmAnchorProvider, type EvmAnchorConfig } from './evm.js';
export { BaseAnchorProvider } from './base.js';
export { BSCAnchorProvider } from './bsc.js';
export { SolanaAnchorProvider, type SolanaAnchorConfig, type AnchorMemoV2 } from './solana.js';
export { MockAnchorProvider } from './mock.js';
