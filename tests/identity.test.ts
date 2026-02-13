import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  createDID,
  parseDID,
  serializePayload,
  sign,
  verify,
  AgentIdentity,
  IdentityError,
  SignatureError,
} from '../src/identity/index.js';

describe('identity', () => {
  describe('generateKeyPair', () => {
    it('should generate a key pair with correct lengths', () => {
      const kp = generateKeyPair();
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.secretKey).toBeInstanceOf(Uint8Array);
      expect(kp.publicKey.length).toBe(32);
      expect(kp.secretKey.length).toBe(64);
    });

    it('should generate unique key pairs each time', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(Buffer.from(kp1.publicKey).toString('hex')).not.toBe(
        Buffer.from(kp2.publicKey).toString('hex')
      );
    });
  });

  describe('createDID', () => {
    it('should create a DID with correct format', () => {
      const kp = generateKeyPair();
      const did = createDID(kp.publicKey);
      expect(did).toMatch(/^did:atel:.+$/);
    });

    it('should throw on invalid public key length', () => {
      expect(() => createDID(new Uint8Array(16))).toThrow(IdentityError);
    });
  });

  describe('parseDID', () => {
    it('should round-trip with createDID', () => {
      const kp = generateKeyPair();
      const did = createDID(kp.publicKey);
      const decoded = parseDID(did);
      expect(Buffer.from(decoded).toString('hex')).toBe(
        Buffer.from(kp.publicKey).toString('hex')
      );
    });

    it('should throw on invalid DID format', () => {
      expect(() => parseDID('invalid')).toThrow(IdentityError);
      expect(() => parseDID('did:other:abc')).toThrow(IdentityError);
    });
  });

  describe('sign and verify', () => {
    it('should verify a correct signature', () => {
      const kp = generateKeyPair();
      const payload = { action: 'test', value: 42 };
      const sig = sign(payload, kp.secretKey);
      expect(verify(payload, sig, kp.publicKey)).toBe(true);
    });

    it('should reject an incorrect signature', () => {
      const kp = generateKeyPair();
      const payload = { action: 'test', value: 42 };
      // Sign with one key, verify with another
      const kp2 = generateKeyPair();
      const sig = sign(payload, kp.secretKey);
      expect(verify(payload, sig, kp2.publicKey)).toBe(false);
    });

    it('should reject when payload is tampered', () => {
      const kp = generateKeyPair();
      const payload = { action: 'test', value: 42 };
      const sig = sign(payload, kp.secretKey);
      const tampered = { action: 'test', value: 99 };
      expect(verify(tampered, sig, kp.publicKey)).toBe(false);
    });

    it('should sign and verify string payloads', () => {
      const kp = generateKeyPair();
      const payload = 'hello world';
      const sig = sign(payload, kp.secretKey);
      expect(verify(payload, sig, kp.publicKey)).toBe(true);
    });

    it('should throw on invalid secret key length', () => {
      expect(() => sign('test', new Uint8Array(32))).toThrow(SignatureError);
    });

    it('should throw on invalid public key length for verify', () => {
      expect(() => verify('test', 'abc', new Uint8Array(16))).toThrow(SignatureError);
    });
  });

  describe('serializePayload (deterministic serialization)', () => {
    it('should produce the same result regardless of key order', () => {
      const obj1 = { b: 2, a: 1 };
      const obj2 = { a: 1, b: 2 };
      expect(serializePayload(obj1)).toBe(serializePayload(obj2));
    });

    it('should handle nested objects deterministically', () => {
      const obj1 = { outer: { z: 3, a: 1 }, name: 'test' };
      const obj2 = { name: 'test', outer: { a: 1, z: 3 } };
      expect(serializePayload(obj1)).toBe(serializePayload(obj2));
    });
  });

  describe('AgentIdentity class', () => {
    it('should create an instance with auto-generated keys', () => {
      const agent = new AgentIdentity();
      expect(agent.agent_id).toBeTruthy();
      expect(agent.did).toMatch(/^did:atel:.+$/);
      expect(agent.publicKey.length).toBe(32);
      expect(agent.secretKey.length).toBe(64);
    });

    it('should create an instance with provided keys', () => {
      const kp = generateKeyPair();
      const agent = new AgentIdentity({
        agent_id: 'test-agent',
        publicKey: kp.publicKey,
        secretKey: kp.secretKey,
      });
      expect(agent.agent_id).toBe('test-agent');
      expect(Buffer.from(agent.publicKey).toString('hex')).toBe(
        Buffer.from(kp.publicKey).toString('hex')
      );
    });

    it('should sign and verify in a complete flow', () => {
      const agent = new AgentIdentity();
      const payload = { task: 'do-something', priority: 'high' };
      const sig = agent.sign(payload);
      expect(agent.verify(payload, sig)).toBe(true);
    });

    it('should export public identity without secret key', () => {
      const agent = new AgentIdentity();
      const pub = agent.toPublic();
      expect(pub.agent_id).toBe(agent.agent_id);
      expect(pub.did).toBe(agent.did);
      expect(pub.publicKey).toBeTruthy();
      // Should not contain secretKey
      expect((pub as any).secretKey).toBeUndefined();
    });
  });
});
