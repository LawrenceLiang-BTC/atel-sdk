/**
 * Module: Crypto
 *
 * End-to-end encryption for ATEL inter-agent communication.
 * Uses X25519 key exchange + XSalsa20-Poly1305 symmetric encryption.
 *
 * Flow:
 *   1. During handshake, agents exchange X25519 public keys
 *   2. Both derive a shared secret via Diffie-Hellman
 *   3. All subsequent messages are encrypted with the shared key
 *
 * Also provides key rotation utilities.
 */

import nacl from 'tweetnacl';
import { randomBytes, createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────

/** X25519 key pair for Diffie-Hellman key exchange */
export interface EncryptionKeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes
}

/** An encrypted payload with nonce */
export interface EncryptedPayload {
  /** Encryption version marker */
  enc: 'atel.enc.v1';
  /** Base64-encoded encrypted ciphertext */
  ciphertext: string;
  /** Base64-encoded 24-byte nonce */
  nonce: string;
  /** Sender's ephemeral X25519 public key (base64), for forward secrecy */
  ephemeralPubKey?: string;
}

/** Session encryption state */
export interface EncryptionSession {
  /** Remote agent DID */
  remoteDid: string;
  /** Shared secret derived from DH exchange */
  sharedKey: Uint8Array; // 32 bytes
  /** Our X25519 key pair for this session */
  localKeyPair: EncryptionKeyPair;
  /** Remote agent's X25519 public key */
  remotePublicKey: Uint8Array;
  /** Session creation time */
  createdAt: number;
  /** Key rotation counter */
  rotationCount: number;
}

/** Key rotation event */
export interface KeyRotationEvent {
  /** New X25519 public key (base64) */
  newPublicKey: string;
  /** Signature over the new key using Ed25519 identity key */
  signature: string;
  /** Rotation sequence number */
  rotationSeq: number;
  /** Timestamp */
  timestamp: string;
}

// ─── Custom Errors ───────────────────────────────────────────────

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

// ─── Key Generation ──────────────────────────────────────────────

/**
 * Generate an X25519 key pair for Diffie-Hellman key exchange.
 */
export function generateEncryptionKeyPair(): EncryptionKeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Derive a shared secret from local secret key and remote public key.
 * Uses X25519 Diffie-Hellman + SHA-256 key derivation.
 *
 * @param localSecretKey - Our X25519 secret key (32 bytes).
 * @param remotePublicKey - Their X25519 public key (32 bytes).
 * @returns 32-byte shared secret.
 */
export function deriveSharedKey(
  localSecretKey: Uint8Array,
  remotePublicKey: Uint8Array,
): Uint8Array {
  const rawShared = nacl.box.before(remotePublicKey, localSecretKey);

  // KDF: SHA-256 over the raw shared secret + context string
  const kdf = createHash('sha256');
  kdf.update(Buffer.from('atel-session-key-v1'));
  kdf.update(Buffer.from(rawShared));
  return new Uint8Array(kdf.digest());
}

// ─── Encryption / Decryption ─────────────────────────────────────

/**
 * Encrypt a plaintext message using a shared key.
 * Uses XSalsa20-Poly1305 (NaCl secretbox).
 *
 * @param plaintext - The message to encrypt (UTF-8 string).
 * @param sharedKey - 32-byte shared secret.
 * @returns EncryptedPayload with ciphertext and nonce.
 */
export function encrypt(plaintext: string, sharedKey: Uint8Array): EncryptedPayload {
  if (sharedKey.length !== 32) {
    throw new CryptoError(`Invalid shared key length: expected 32, got ${sharedKey.length}`);
  }

  const nonce = nacl.randomBytes(24);
  const messageBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(messageBytes, nonce, sharedKey);

  if (!ciphertext) {
    throw new CryptoError('Encryption failed');
  }

  return {
    enc: 'atel.enc.v1',
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}

/**
 * Decrypt an encrypted payload using a shared key.
 *
 * @param payload - The encrypted payload.
 * @param sharedKey - 32-byte shared secret.
 * @returns The decrypted plaintext string.
 * @throws CryptoError if decryption fails (wrong key, tampered data).
 */
export function decrypt(payload: EncryptedPayload, sharedKey: Uint8Array): string {
  if (sharedKey.length !== 32) {
    throw new CryptoError(`Invalid shared key length: expected 32, got ${sharedKey.length}`);
  }

  if (payload.enc !== 'atel.enc.v1') {
    throw new CryptoError(`Unsupported encryption version: ${payload.enc}`);
  }

  const ciphertext = Uint8Array.from(Buffer.from(payload.ciphertext, 'base64'));
  const nonce = Uint8Array.from(Buffer.from(payload.nonce, 'base64'));

  const plaintext = nacl.secretbox.open(ciphertext, nonce, sharedKey);

  if (!plaintext) {
    throw new CryptoError('Decryption failed: invalid key or tampered ciphertext');
  }

  return new TextDecoder().decode(plaintext);
}

// ─── Encryption Session Manager ──────────────────────────────────

/**
 * Manages encryption sessions with remote agents.
 * Handles key exchange, encryption/decryption, and key rotation.
 */
export class EncryptionManager {
  private sessions: Map<string, EncryptionSession> = new Map();

  /**
   * Create an encryption session with a remote agent.
   *
   * @param remoteDid - The remote agent's DID.
   * @param remoteEncPubKey - The remote agent's X25519 public key.
   * @returns The local X25519 public key to send to the remote agent.
   */
  createSession(remoteDid: string, remoteEncPubKey: Uint8Array): Uint8Array {
    const localKeyPair = generateEncryptionKeyPair();
    const sharedKey = deriveSharedKey(localKeyPair.secretKey, remoteEncPubKey);

    this.sessions.set(remoteDid, {
      remoteDid,
      sharedKey,
      localKeyPair,
      remotePublicKey: remoteEncPubKey,
      createdAt: Date.now(),
      rotationCount: 0,
    });

    return localKeyPair.publicKey;
  }

  /**
   * Create an encryption session with pre-computed keys.
   * Used by HandshakeManager when keys are already exchanged.
   *
   * @param remoteDid - The remote agent's DID.
   * @param localKeyPair - Our X25519 key pair.
   * @param remotePublicKey - Their X25519 public key.
   * @param sharedKey - Pre-derived shared secret.
   */
  createSessionWithKeys(
    remoteDid: string,
    localKeyPair: EncryptionKeyPair,
    remotePublicKey: Uint8Array,
    sharedKey: Uint8Array,
  ): void {
    this.sessions.set(remoteDid, {
      remoteDid,
      sharedKey,
      localKeyPair,
      remotePublicKey,
      createdAt: Date.now(),
      rotationCount: 0,
    });
  }

  /**
   * Encrypt a message for a remote agent.
   *
   * @param remoteDid - The remote agent's DID.
   * @param plaintext - The message to encrypt.
   * @returns The encrypted payload.
   * @throws CryptoError if no session exists.
   */
  encryptFor(remoteDid: string, plaintext: string): EncryptedPayload {
    const session = this.getSessionOrThrow(remoteDid);
    return encrypt(plaintext, session.sharedKey);
  }

  /**
   * Decrypt a message from a remote agent.
   *
   * @param remoteDid - The remote agent's DID.
   * @param payload - The encrypted payload.
   * @returns The decrypted plaintext.
   * @throws CryptoError if no session exists or decryption fails.
   */
  decryptFrom(remoteDid: string, payload: EncryptedPayload): string {
    const session = this.getSessionOrThrow(remoteDid);
    return decrypt(payload, session.sharedKey);
  }

  /**
   * Rotate the encryption key for a session.
   * Generates a new key pair and re-derives the shared secret.
   *
   * @param remoteDid - The remote agent's DID.
   * @param newRemotePublicKey - The remote agent's new X25519 public key.
   * @returns The new local X25519 public key.
   */
  rotateKey(remoteDid: string, newRemotePublicKey: Uint8Array): Uint8Array {
    const session = this.getSessionOrThrow(remoteDid);

    const newLocalKeyPair = generateEncryptionKeyPair();
    const newSharedKey = deriveSharedKey(newLocalKeyPair.secretKey, newRemotePublicKey);

    // Zero out old keys
    session.sharedKey.fill(0);
    session.localKeyPair.secretKey.fill(0);

    session.sharedKey = newSharedKey;
    session.localKeyPair = newLocalKeyPair;
    session.remotePublicKey = newRemotePublicKey;
    session.rotationCount++;

    return newLocalKeyPair.publicKey;
  }

  /**
   * Check if an encryption session exists.
   */
  hasSession(remoteDid: string): boolean {
    return this.sessions.has(remoteDid);
  }

  /**
   * Get session info (without exposing the shared key).
   */
  getSessionInfo(remoteDid: string): { remoteDid: string; createdAt: number; rotationCount: number } | undefined {
    const session = this.sessions.get(remoteDid);
    if (!session) return undefined;
    return {
      remoteDid: session.remoteDid,
      createdAt: session.createdAt,
      rotationCount: session.rotationCount,
    };
  }

  /**
   * Destroy a session and zero out all key material.
   */
  destroySession(remoteDid: string): void {
    const session = this.sessions.get(remoteDid);
    if (session) {
      session.sharedKey.fill(0);
      session.localKeyPair.secretKey.fill(0);
      this.sessions.delete(remoteDid);
    }
  }

  /**
   * Destroy all sessions.
   */
  destroyAll(): void {
    for (const [did] of this.sessions) {
      this.destroySession(did);
    }
  }

  private getSessionOrThrow(remoteDid: string): EncryptionSession {
    const session = this.sessions.get(remoteDid);
    if (!session) {
      throw new CryptoError(`No encryption session with ${remoteDid}`);
    }
    return session;
  }
}
