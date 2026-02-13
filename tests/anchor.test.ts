/**
 * Tests for the on-chain anchor module.
 *
 * Uses MockAnchorProvider so no real blockchain connection is needed.
 * Also tests static encoding/decoding helpers for EVM and Solana providers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AnchorManager,
  MockAnchorProvider,
  EvmAnchorProvider,
  SolanaAnchorProvider,
} from '../src/anchor/index.js';

// ─── MockAnchorProvider ──────────────────────────────────────────

describe('MockAnchorProvider', () => {
  let mock: MockAnchorProvider;

  beforeEach(() => {
    mock = new MockAnchorProvider();
  });

  it('should anchor a hash and return a record', async () => {
    const record = await mock.anchor('abc123');
    expect(record.hash).toBe('abc123');
    expect(record.txHash).toMatch(/^0xmock_/);
    expect(record.chain).toBe('mock');
    expect(record.timestamp).toBeGreaterThan(0);
    expect(record.blockNumber).toBeDefined();
  });

  it('should anchor with metadata', async () => {
    const record = await mock.anchor('hash1', { source: 'test' });
    expect(record.metadata).toEqual({ source: 'test' });
  });

  it('should verify a valid anchor', async () => {
    const record = await mock.anchor('hash1');
    const result = await mock.verify('hash1', record.txHash);
    expect(result.valid).toBe(true);
    expect(result.hash).toBe('hash1');
    expect(result.txHash).toBe(record.txHash);
    expect(result.chain).toBe('mock');
    expect(result.blockTimestamp).toBeDefined();
  });

  it('should fail verification for wrong hash', async () => {
    const record = await mock.anchor('hash1');
    const result = await mock.verify('wrong_hash', record.txHash);
    expect(result.valid).toBe(false);
    expect(result.detail).toContain('mismatch');
  });

  it('should fail verification for unknown txHash', async () => {
    const result = await mock.verify('hash1', '0xnonexistent');
    expect(result.valid).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('should look up records by hash', async () => {
    await mock.anchor('hash1');
    await mock.anchor('hash2');
    await mock.anchor('hash1');

    const results = await mock.lookup('hash1');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.hash === 'hash1')).toBe(true);
  });

  it('should return empty array for unknown hash lookup', async () => {
    const results = await mock.lookup('unknown');
    expect(results).toHaveLength(0);
  });

  it('should report availability', async () => {
    expect(await mock.isAvailable()).toBe(true);
    mock.setAvailable(false);
    expect(await mock.isAvailable()).toBe(false);
  });

  it('should throw when anchoring while unavailable', async () => {
    mock.setAvailable(false);
    await expect(mock.anchor('hash1')).rejects.toThrow('unavailable');
  });

  it('should support custom chain id', () => {
    const custom = new MockAnchorProvider('testnet');
    expect(custom.chain).toBe('testnet');
  });

  it('should clear records', async () => {
    await mock.anchor('hash1');
    expect(mock.getRecords()).toHaveLength(1);
    mock.clear();
    expect(mock.getRecords()).toHaveLength(0);
  });

  it('should complete a full anchor → verify → lookup cycle', async () => {
    const record = await mock.anchor('full_cycle_hash', { step: 1 });

    // Verify
    const verification = await mock.verify('full_cycle_hash', record.txHash);
    expect(verification.valid).toBe(true);

    // Lookup
    const found = await mock.lookup('full_cycle_hash');
    expect(found).toHaveLength(1);
    expect(found[0].txHash).toBe(record.txHash);
    expect(found[0].metadata).toEqual({ step: 1 });
  });
});

// ─── AnchorManager ───────────────────────────────────────────────

describe('AnchorManager', () => {
  let manager: AnchorManager;
  let mockProvider: MockAnchorProvider;

  beforeEach(() => {
    manager = new AnchorManager();
    mockProvider = new MockAnchorProvider();
  });

  it('should register a provider', () => {
    manager.registerProvider(mockProvider);
    expect(manager.getProviders()).toEqual(['mock']);
  });

  it('should reject duplicate chain registration', () => {
    manager.registerProvider(mockProvider);
    expect(() => manager.registerProvider(new MockAnchorProvider())).toThrow(
      'already registered',
    );
  });

  it('should anchor a hash to a specific chain', async () => {
    manager.registerProvider(mockProvider);
    const record = await manager.anchor('hash1', 'mock');
    expect(record.hash).toBe('hash1');
    expect(record.chain).toBe('mock');
  });

  it('should throw when anchoring to unregistered chain', async () => {
    await expect(manager.anchor('hash1', 'unknown')).rejects.toThrow(
      'No anchor provider',
    );
  });

  it('should verify an anchor', async () => {
    manager.registerProvider(mockProvider);
    const record = await manager.anchor('hash1', 'mock');
    const result = await manager.verify('hash1', record.txHash, 'mock');
    expect(result.valid).toBe(true);
  });

  it('should fail verification for invalid hash', async () => {
    manager.registerProvider(mockProvider);
    const record = await manager.anchor('hash1', 'mock');
    const result = await manager.verify('wrong', record.txHash, 'mock');
    expect(result.valid).toBe(false);
  });

  it('should look up records by hash', async () => {
    manager.registerProvider(mockProvider);
    await manager.anchor('hash1', 'mock');
    await manager.anchor('hash1', 'mock');

    const results = await manager.lookup('hash1');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('should get all local records', async () => {
    manager.registerProvider(mockProvider);
    await manager.anchor('a', 'mock');
    await manager.anchor('b', 'mock');

    const records = manager.getRecords();
    expect(records).toHaveLength(2);
  });

  it('should anchor to all registered chains (anchorAll)', async () => {
    const mock1 = new MockAnchorProvider('chain_a');
    const mock2 = new MockAnchorProvider('chain_b');
    manager.registerProvider(mock1);
    manager.registerProvider(mock2);

    const results = await manager.anchorAll('multi_hash');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.chain).sort()).toEqual(['chain_a', 'chain_b']);
    expect(manager.getRecords()).toHaveLength(2);
  });

  it('should handle partial failures in anchorAll', async () => {
    const good = new MockAnchorProvider('good');
    const bad = new MockAnchorProvider('bad');
    bad.setAvailable(false);

    manager.registerProvider(good);
    manager.registerProvider(bad);

    const results = await manager.anchorAll('partial_hash');
    expect(results).toHaveLength(1);
    expect(results[0].chain).toBe('good');
  });

  it('should throw when all providers fail in anchorAll', async () => {
    const bad = new MockAnchorProvider('bad');
    bad.setAvailable(false);
    manager.registerProvider(bad);

    await expect(manager.anchorAll('fail_hash')).rejects.toThrow(
      'All anchor providers failed',
    );
  });

  it('should export and import records', async () => {
    manager.registerProvider(mockProvider);
    await manager.anchor('export_hash', 'mock');

    const json = manager.exportRecords();
    expect(json).toContain('export_hash');

    // Import into a fresh manager
    const manager2 = new AnchorManager();
    manager2.importRecords(json);
    expect(manager2.getRecords()).toHaveLength(1);
    expect(manager2.getRecords()[0].hash).toBe('export_hash');
  });

  it('should reject invalid JSON on import', () => {
    expect(() => manager.importRecords('not json')).toThrow();
  });

  it('should reject non-array JSON on import', () => {
    expect(() => manager.importRecords('{"a":1}')).toThrow('expects a JSON array');
  });
});

// ─── EvmAnchorProvider encoding ──────────────────────────────────

describe('EvmAnchorProvider encoding', () => {
  it('should encode a hash into hex data', () => {
    const data = EvmAnchorProvider.encodeData('abc123');
    expect(data).toMatch(/^0x/);
    // Decode it back
    const decoded = EvmAnchorProvider.decodeData(data);
    expect(decoded).toBe('abc123');
  });

  it('should round-trip arbitrary hashes', () => {
    const hashes = [
      'sha256:abcdef1234567890',
      'proof_id_12345',
      '0xdeadbeef',
      'a'.repeat(64),
    ];
    for (const hash of hashes) {
      const encoded = EvmAnchorProvider.encodeData(hash);
      const decoded = EvmAnchorProvider.decodeData(encoded);
      expect(decoded).toBe(hash);
    }
  });

  it('should return null for data without anchor prefix', () => {
    const { ethers } = require('ethers');
    const data = ethers.hexlify(ethers.toUtf8Bytes('random data'));
    expect(EvmAnchorProvider.decodeData(data)).toBeNull();
  });

  it('should return null for invalid hex data', () => {
    expect(EvmAnchorProvider.decodeData('0xZZZZ')).toBeNull();
  });
});

// ─── SolanaAnchorProvider encoding ───────────────────────────────

describe('SolanaAnchorProvider encoding', () => {
  it('should encode a hash into memo buffer', () => {
    const buf = SolanaAnchorProvider.encodeMemo('solana_hash_123');
    expect(Buffer.isBuffer(buf)).toBe(true);
    const text = buf.toString('utf-8');
    expect(text).toContain('ATEL_ANCHOR:');
    expect(text).toContain('solana_hash_123');
  });

  it('should decode a memo buffer back to hash', () => {
    const buf = SolanaAnchorProvider.encodeMemo('my_hash');
    const decoded = SolanaAnchorProvider.decodeMemo(buf);
    expect(decoded).toBe('my_hash');
  });

  it('should decode from string', () => {
    const decoded = SolanaAnchorProvider.decodeMemo('ATEL_ANCHOR:from_string');
    expect(decoded).toBe('from_string');
  });

  it('should return null for non-anchor memo', () => {
    const decoded = SolanaAnchorProvider.decodeMemo('just a random memo');
    expect(decoded).toBeNull();
  });

  it('should round-trip arbitrary hashes', () => {
    const hashes = ['abc', 'proof_xyz', '0'.repeat(64)];
    for (const hash of hashes) {
      const encoded = SolanaAnchorProvider.encodeMemo(hash);
      const decoded = SolanaAnchorProvider.decodeMemo(encoded);
      expect(decoded).toBe(hash);
    }
  });
});
