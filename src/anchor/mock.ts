/**
 * Mock Anchor Provider — in-memory implementation for testing.
 *
 * Simulates on-chain anchoring without any real blockchain connection.
 * All records are stored in memory and lost when the provider is discarded.
 */

import { randomUUID } from 'node:crypto';
import type { AnchorProvider, AnchorRecord, AnchorVerification, ChainId } from './index.js';

/**
 * In-memory anchor provider for testing and development.
 */
export class MockAnchorProvider implements AnchorProvider {
  readonly name = 'Mock';
  readonly chain: string;

  /** In-memory record store */
  private records: AnchorRecord[] = [];
  /** Whether the mock provider should simulate being available */
  private available = true;

  /**
   * @param chain - Chain identifier to use (defaults to `'mock'`).
   */
  constructor(chain?: string) {
    this.chain = chain ?? 'mock';
  }

  /**
   * Control whether {@link isAvailable} returns true or false.
   * Useful for testing error paths.
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** @inheritdoc */
  async anchor(hash: string, metadata?: Record<string, unknown>): Promise<AnchorRecord> {
    if (!this.available) {
      throw new Error('Mock provider is unavailable');
    }

    const record: AnchorRecord = {
      hash,
      txHash: `0xmock_${randomUUID().replace(/-/g, '')}`,
      chain: this.chain as ChainId,
      timestamp: Date.now(),
      blockNumber: Math.floor(Math.random() * 1_000_000),
      metadata,
    };

    this.records.push(record);
    return record;
  }

  /** @inheritdoc */
  async verify(hash: string, txHash: string): Promise<AnchorVerification> {
    if (!this.available) {
      return {
        valid: false,
        hash,
        txHash,
        chain: this.chain,
        detail: 'Mock provider is unavailable',
      };
    }

    const record = this.records.find((r) => r.txHash === txHash);
    if (!record) {
      return {
        valid: false,
        hash,
        txHash,
        chain: this.chain,
        detail: 'Transaction not found in mock store',
      };
    }

    const valid = record.hash === hash;
    return {
      valid,
      hash,
      txHash,
      chain: this.chain,
      blockTimestamp: record.timestamp,
      detail: valid
        ? 'Hash matches mock record'
        : `Hash mismatch: expected "${hash}", found "${record.hash}"`,
    };
  }

  /** @inheritdoc */
  async lookup(hash: string): Promise<AnchorRecord[]> {
    return this.records.filter((r) => r.hash === hash);
  }

  /** @inheritdoc */
  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  /**
   * Get all records stored in this mock provider.
   */
  getRecords(): AnchorRecord[] {
    return [...this.records];
  }

  /**
   * Clear all stored records.
   */
  clear(): void {
    this.records = [];
  }
}
