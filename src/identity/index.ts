import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { v4 as uuidv4 } from 'uuid';

// ─── Custom Errors ───────────────────────────────────────────────

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

// ─── Types ───────────────────────────────────────────────────────

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface AgentIdentityData {
  agent_id: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  did: string;
}

/** Optional metadata for an agent identity */
export interface AgentMetadata {
  /** Human-readable name */
  name?: string;
  /** Description of the agent's purpose */
  description?: string;
  /** List of capabilities the agent supports */
  capabilities?: string[];
  /** Agent version string */
  version?: string;
  /** Additional custom metadata */
  [key: string]: unknown;
}

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Generate an Ed25519 key pair using tweetnacl.
 * @returns A KeyPair containing 32-byte publicKey and 64-byte secretKey.
 */
export function generateKeyPair(): KeyPair {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Create a DID (Decentralized Identifier) from a public key.
 * Format: "did:atel:ed25519:<base58(publicKey)>"
 * @param publicKey - The 32-byte Ed25519 public key.
 * @returns The DID string.
 */
export function createDID(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new IdentityError(`Invalid public key length: expected 32, got ${publicKey.length}`);
  }
  const encoded = bs58.encode(publicKey);
  return `did:atel:ed25519:${encoded}`;
}

/**
 * Parse a DID string and extract the public key bytes.
 * Supports both formats:
 *   - "did:atel:ed25519:<base58>" (current)
 *   - "did:atel:<base58>" (legacy, for backward compatibility)
 * @param did - A DID string.
 * @returns The decoded 32-byte public key.
 */
export function parseDID(did: string): Uint8Array {
  const parts = did.split(':');
  let base58Part: string;

  if (parts.length === 4 && parts[0] === 'did' && parts[1] === 'atel' && parts[2] === 'ed25519') {
    // New format: did:atel:ed25519:<base58>
    base58Part = parts[3];
  } else if (parts.length === 3 && parts[0] === 'did' && parts[1] === 'atel') {
    // Legacy format: did:atel:<base58>
    base58Part = parts[2];
  } else {
    throw new IdentityError(`Invalid DID format: ${did}`);
  }

  try {
    const decoded = bs58.decode(base58Part);
    if (decoded.length !== 32) {
      throw new IdentityError(`Invalid public key in DID: expected 32 bytes, got ${decoded.length}`);
    }
    return decoded;
  } catch (e) {
    if (e instanceof IdentityError) throw e;
    throw new IdentityError(`Failed to decode DID: ${(e as Error).message}`);
  }
}

/**
 * Deterministic JSON serialization — keys sorted recursively.
 * Ensures identical payloads produce identical byte sequences for signing.
 * @param obj - The object to serialize.
 * @returns A deterministic JSON string.
 */
export function serializePayload(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * Sign a payload with an Ed25519 secret key.
 * The payload is first deterministically serialized, then signed.
 * @param payload - The object or string to sign.
 * @param secretKey - The 64-byte Ed25519 secret key.
 * @returns A base64-encoded detached signature.
 */
export function sign(payload: unknown, secretKey: Uint8Array): string {
  if (secretKey.length !== 64) {
    throw new SignatureError(`Invalid secret key length: expected 64, got ${secretKey.length}`);
  }
  const message = typeof payload === 'string' ? payload : serializePayload(payload);
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return Buffer.from(signature).toString('base64');
}

/**
 * Verify a detached Ed25519 signature against a payload.
 * @param payload - The original object or string that was signed.
 * @param signature - The base64-encoded signature to verify.
 * @param publicKey - The 32-byte Ed25519 public key.
 * @returns True if the signature is valid.
 */
export function verify(payload: unknown, signature: string, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) {
    throw new SignatureError(`Invalid public key length: expected 32, got ${publicKey.length}`);
  }
  try {
    const message = typeof payload === 'string' ? payload : serializePayload(payload);
    const messageBytes = new TextEncoder().encode(message);
    const sigBytes = Uint8Array.from(Buffer.from(signature, 'base64'));
    return nacl.sign.detached.verify(messageBytes, sigBytes, publicKey);
  } catch {
    return false;
  }
}

// ─── AgentIdentity Class ─────────────────────────────────────────

/**
 * Encapsulates an agent's cryptographic identity.
 * Provides key generation, DID creation, signing, and verification.
 */
export class AgentIdentity {
  public readonly agent_id: string;
  public readonly publicKey: Uint8Array;
  public readonly secretKey: Uint8Array;
  public readonly did: string;
  /** Optional metadata describing the agent */
  public readonly metadata?: AgentMetadata;

  /**
   * Create an AgentIdentity from an existing key pair.
   * @param params - Optional agent_id, key pair, and metadata. Generates new keys if omitted.
   */
  constructor(params?: {
    agent_id?: string;
    publicKey?: Uint8Array;
    secretKey?: Uint8Array;
    metadata?: AgentMetadata;
  }) {
    if (params?.publicKey && params?.secretKey) {
      this.publicKey = params.publicKey;
      this.secretKey = params.secretKey;
    } else {
      const kp = generateKeyPair();
      this.publicKey = kp.publicKey;
      this.secretKey = kp.secretKey;
    }
    this.agent_id = params?.agent_id ?? uuidv4();
    this.did = createDID(this.publicKey);
    this.metadata = params?.metadata;
  }

  /**
   * Sign a payload using this agent's secret key.
   * @param payload - The data to sign.
   * @returns Base64-encoded signature.
   */
  sign(payload: unknown): string {
    return sign(payload, this.secretKey);
  }

  /**
   * Verify a signature against this agent's public key.
   * @param payload - The original data.
   * @param signature - The base64 signature to verify.
   * @returns True if valid.
   */
  verify(payload: unknown, signature: string): boolean {
    return verify(payload, signature, this.publicKey);
  }

  /**
   * Export identity data (excluding secret key) for sharing.
   */
  toPublic(): { agent_id: string; did: string; publicKey: string; metadata?: AgentMetadata } {
    const pub: { agent_id: string; did: string; publicKey: string; metadata?: AgentMetadata } = {
      agent_id: this.agent_id,
      did: this.did,
      publicKey: Buffer.from(this.publicKey).toString('base64'),
    };
    if (this.metadata) {
      pub.metadata = this.metadata;
    }
    return pub;
  }
}

// ─── Key Rotation ────────────────────────────────────────────────

/**
 * Proof of key rotation: signed by both old and new keys.
 * This allows verifiers to confirm the rotation was authorized by the original identity.
 */
export interface KeyRotationProof {
  /** The agent's original DID (old key) */
  oldDid: string;
  /** The agent's new DID (new key) */
  newDid: string;
  /** New public key (base64) */
  newPublicKey: string;
  /** ISO 8601 timestamp of rotation */
  timestamp: string;
  /** Signature of {oldDid, newDid, newPublicKey, timestamp} by OLD secret key */
  oldSignature: string;
  /** Signature of {oldDid, newDid, newPublicKey, timestamp} by NEW secret key */
  newSignature: string;
}

/**
 * Rotate an agent's identity key pair.
 * Generates a new key pair and produces a rotation proof signed by both old and new keys.
 * The proof can be anchored on-chain and submitted to the Registry.
 *
 * @param oldIdentity - The current identity (with secret key).
 * @returns The new identity and the rotation proof.
 */
export function rotateKey(oldIdentity: AgentIdentity): {
  newIdentity: AgentIdentity;
  proof: KeyRotationProof;
} {
  const newKp = generateKeyPair();
  const newIdentity = new AgentIdentity({
    agent_id: oldIdentity.agent_id,
    publicKey: newKp.publicKey,
    secretKey: newKp.secretKey,
    metadata: oldIdentity.metadata,
  });

  const rotationData = {
    oldDid: oldIdentity.did,
    newDid: newIdentity.did,
    newPublicKey: Buffer.from(newKp.publicKey).toString('base64'),
    timestamp: new Date().toISOString(),
  };

  const signable = serializePayload(rotationData);
  const oldSignature = sign(signable, oldIdentity.secretKey);
  const newSignature = sign(signable, newIdentity.secretKey);

  return {
    newIdentity,
    proof: {
      ...rotationData,
      oldSignature,
      newSignature,
    },
  };
}

/**
 * Verify a key rotation proof.
 * Checks that both old and new keys signed the rotation data.
 *
 * @param proof - The rotation proof to verify.
 * @returns True if both signatures are valid.
 */
export function verifyKeyRotation(proof: KeyRotationProof): boolean {
  try {
    const oldPk = parseDID(proof.oldDid);
    const newPk = parseDID(proof.newDid);

    const rotationData = {
      oldDid: proof.oldDid,
      newDid: proof.newDid,
      newPublicKey: proof.newPublicKey,
      timestamp: proof.timestamp,
    };
    const signable = serializePayload(rotationData);

    const oldValid = verify(signable, proof.oldSignature, oldPk);
    const newValid = verify(signable, proof.newSignature, newPk);

    return oldValid && newValid;
  } catch {
    return false;
  }
}
