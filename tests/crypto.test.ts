import { describe, it, expect } from 'vitest';
import {
  generateEncryptionKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  EncryptionManager,
  CryptoError,
} from '../src/crypto/index.js';

describe('Crypto Module', () => {
  describe('Key Exchange', () => {
    it('should generate valid X25519 key pairs', () => {
      const kp = generateEncryptionKeyPair();
      expect(kp.publicKey.length).toBe(32);
      expect(kp.secretKey.length).toBe(32);
    });

    it('should derive the same shared key from both sides', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();

      const sharedA = deriveSharedKey(alice.secretKey, bob.publicKey);
      const sharedB = deriveSharedKey(bob.secretKey, alice.publicKey);

      expect(Buffer.from(sharedA).toString('hex')).toBe(
        Buffer.from(sharedB).toString('hex'),
      );
    });

    it('should derive different keys for different pairs', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const eve = generateEncryptionKeyPair();

      const sharedAB = deriveSharedKey(alice.secretKey, bob.publicKey);
      const sharedAE = deriveSharedKey(alice.secretKey, eve.publicKey);

      expect(Buffer.from(sharedAB).toString('hex')).not.toBe(
        Buffer.from(sharedAE).toString('hex'),
      );
    });
  });

  describe('Encrypt / Decrypt', () => {
    it('should encrypt and decrypt a message', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);

      const plaintext = 'Hello, this is a secret message!';
      const encrypted = encrypt(plaintext, sharedKey);

      expect(encrypted.enc).toBe('atel.enc.v1');
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.nonce).toBeTruthy();

      const decrypted = decrypt(encrypted, sharedKey);
      expect(decrypted).toBe(plaintext);
    });

    it('should fail to decrypt with wrong key', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const eve = generateEncryptionKeyPair();

      const sharedAB = deriveSharedKey(alice.secretKey, bob.publicKey);
      const sharedAE = deriveSharedKey(alice.secretKey, eve.publicKey);

      const encrypted = encrypt('secret', sharedAB);

      expect(() => decrypt(encrypted, sharedAE)).toThrow(CryptoError);
    });

    it('should fail to decrypt tampered ciphertext', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);

      const encrypted = encrypt('secret', sharedKey);

      // Tamper with ciphertext
      const tampered = { ...encrypted };
      const bytes = Buffer.from(tampered.ciphertext, 'base64');
      bytes[0] ^= 0xff;
      tampered.ciphertext = bytes.toString('base64');

      expect(() => decrypt(tampered, sharedKey)).toThrow(CryptoError);
    });

    it('should handle large messages', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);

      const largeMessage = 'x'.repeat(100_000);
      const encrypted = encrypt(largeMessage, sharedKey);
      const decrypted = decrypt(encrypted, sharedKey);
      expect(decrypted).toBe(largeMessage);
    });

    it('should handle unicode messages', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);

      const message = '你好世界 🌍 こんにちは';
      const encrypted = encrypt(message, sharedKey);
      const decrypted = decrypt(encrypted, sharedKey);
      expect(decrypted).toBe(message);
    });
  });

  describe('EncryptionManager', () => {
    it('should manage encryption sessions', () => {
      const manager = new EncryptionManager();
      const bob = generateEncryptionKeyPair();

      manager.createSession('did:atel:bob', bob.publicKey);
      expect(manager.hasSession('did:atel:bob')).toBe(true);
      expect(manager.hasSession('did:atel:unknown')).toBe(false);
    });

    it('should encrypt and decrypt via session', () => {
      const aliceManager = new EncryptionManager();
      const bobManager = new EncryptionManager();

      const aliceKp = generateEncryptionKeyPair();
      const bobKp = generateEncryptionKeyPair();

      const sharedKey = deriveSharedKey(aliceKp.secretKey, bobKp.publicKey);

      aliceManager.createSessionWithKeys('did:atel:bob', aliceKp, bobKp.publicKey, sharedKey);
      bobManager.createSessionWithKeys('did:atel:alice', bobKp, aliceKp.publicKey,
        deriveSharedKey(bobKp.secretKey, aliceKp.publicKey));

      const encrypted = aliceManager.encryptFor('did:atel:bob', 'secret task data');
      const decrypted = bobManager.decryptFrom('did:atel:alice', encrypted);
      expect(decrypted).toBe('secret task data');
    });

    it('should rotate keys', () => {
      const manager = new EncryptionManager();
      const bobKp = generateEncryptionKeyPair();

      manager.createSession('did:atel:bob', bobKp.publicKey);

      const info1 = manager.getSessionInfo('did:atel:bob');
      expect(info1?.rotationCount).toBe(0);

      const newBobKp = generateEncryptionKeyPair();
      manager.rotateKey('did:atel:bob', newBobKp.publicKey);

      const info2 = manager.getSessionInfo('did:atel:bob');
      expect(info2?.rotationCount).toBe(1);
    });

    it('should destroy sessions and zero keys', () => {
      const manager = new EncryptionManager();
      const bobKp = generateEncryptionKeyPair();

      manager.createSession('did:atel:bob', bobKp.publicKey);
      manager.destroySession('did:atel:bob');

      expect(manager.hasSession('did:atel:bob')).toBe(false);
      expect(() => manager.encryptFor('did:atel:bob', 'test')).toThrow(CryptoError);
    });
  });
});
