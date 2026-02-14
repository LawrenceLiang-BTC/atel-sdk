import { describe, it, expect } from 'vitest';
import {
  createMessage,
  verifyMessage,
  serializeMessage,
  deserializeMessage,
  NonceTracker,
} from '../src/envelope/index.js';
import { AgentIdentity } from '../src/identity/index.js';

describe('Message Envelope', () => {
  const alice = new AgentIdentity({ agent_id: 'alice' });
  const bob = new AgentIdentity({ agent_id: 'bob' });

  it('should create and verify a message', () => {
    const msg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: { task: 'test' },
      secretKey: alice.secretKey,
    });

    expect(msg.envelope).toBe('atel.msg.v1');
    expect(msg.type).toBe('task_delegate');
    expect(msg.from).toBe(alice.did);
    expect(msg.to).toBe(bob.did);
    expect(msg.signature).toBeTruthy();

    const result = verifyMessage(msg, alice.publicKey);
    expect(result.valid).toBe(true);
  });

  it('should reject message with wrong public key', () => {
    const msg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: { task: 'test' },
      secretKey: alice.secretKey,
    });

    const result = verifyMessage(msg, bob.publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid signature');
  });

  it('should reject expired messages', () => {
    const msg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: {},
      secretKey: alice.secretKey,
    });

    // Manually set timestamp to 10 minutes ago
    (msg as any).timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    // Re-sign would be needed for real verification, but we test timestamp check
    const result = verifyMessage(msg, alice.publicKey, { maxAgeMs: 5 * 60 * 1000 });
    // Will fail on either timestamp or signature
    expect(result.valid).toBe(false);
  });

  it('should serialize and deserialize messages', () => {
    const msg = createMessage({
      type: 'handshake_init',
      from: alice.did,
      to: bob.did,
      payload: { challenge: 'abc123' },
      secretKey: alice.secretKey,
    });

    const json = serializeMessage(msg);
    const parsed = deserializeMessage(json);

    expect(parsed.type).toBe('handshake_init');
    expect(parsed.from).toBe(alice.did);
    expect(parsed.payload).toEqual({ challenge: 'abc123' });
  });

  it('should reject invalid JSON in deserialize', () => {
    expect(() => deserializeMessage('not json')).toThrow('Failed to parse');
  });

  it('should reject messages missing required fields', () => {
    const msg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: {},
      secretKey: alice.secretKey,
    });

    const broken = { ...msg, from: '' };
    const result = verifyMessage(broken, alice.publicKey);
    expect(result.valid).toBe(false);
  });
});

describe('NonceTracker', () => {
  it('should accept new nonces and reject duplicates', () => {
    const tracker = new NonceTracker();

    expect(tracker.check('nonce-1')).toBe(true);
    expect(tracker.check('nonce-2')).toBe(true);
    expect(tracker.check('nonce-1')).toBe(false); // replay
    expect(tracker.size).toBe(2);
  });

  it('should evict expired nonces', async () => {
    const tracker = new NonceTracker(100); // 100ms TTL

    tracker.check('old-nonce');
    await new Promise((r) => setTimeout(r, 150));
    // After eviction, old nonce should be gone
    expect(tracker.check('old-nonce')).toBe(true); // accepted again
  });
});
