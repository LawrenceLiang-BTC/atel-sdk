/**
 * Module: Message Envelope
 *
 * Standardized message format for ATEL inter-agent communication.
 * Every message is signed by the sender and verified by the receiver.
 * Includes nonce + timestamp for replay protection.
 */

import { v4 as uuidv4 } from 'uuid';
import { sign, verify, serializePayload } from '../identity/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** All recognized ATEL message types */
export type MessageType =
  | 'handshake_init'
  | 'handshake_ack'
  | 'handshake_confirm'
  | 'task_delegate'
  | 'proof_response'
  | 'trust_query'
  | 'trust_response'
  | 'capability_query'
  | 'capability_response'
  | 'error';

/** The standard ATEL message envelope */
export interface ATELMessage<T = unknown> {
  /** Envelope format version */
  envelope: 'atel.msg.v1';
  /** Message type */
  type: MessageType;
  /** Sender DID */
  from: string;
  /** Receiver DID */
  to: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unique nonce for replay protection */
  nonce: string;
  /** Message payload */
  payload: T;
  /** Ed25519 signature over the envelope (excluding sig field) */
  signature: string;
}

/** Options for creating a message */
export interface CreateMessageOptions<T = unknown> {
  type: MessageType;
  from: string;
  to: string;
  payload: T;
  secretKey: Uint8Array;
}

/** Result of message verification */
export interface VerifyMessageResult {
  valid: boolean;
  error?: string;
}

// ─── Custom Errors ───────────────────────────────────────────────

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

// ─── Constants ───────────────────────────────────────────────────

/** Maximum age of a message before it's considered expired (5 minutes) */
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Create and sign an ATEL message.
 *
 * @param options - Message creation options.
 * @returns A signed ATELMessage.
 */
export function createMessage<T = unknown>(options: CreateMessageOptions<T>): ATELMessage<T> {
  const { type, from, to, payload, secretKey } = options;

  const unsigned = {
    envelope: 'atel.msg.v1' as const,
    type,
    from,
    to,
    timestamp: new Date().toISOString(),
    nonce: uuidv4(),
    payload,
  };

  const signable = serializePayload(unsigned);
  const signature = sign(signable, secretKey);

  return { ...unsigned, signature };
}

/**
 * Verify an ATEL message's signature and freshness.
 *
 * Checks:
 * 1. Envelope version is supported
 * 2. Required fields are present
 * 3. Timestamp is not too old (replay protection)
 * 4. Signature is valid against sender's public key
 *
 * @param message - The message to verify.
 * @param senderPublicKey - The sender's 32-byte Ed25519 public key.
 * @param options - Optional verification settings.
 * @returns Verification result.
 */
export function verifyMessage(
  message: ATELMessage,
  senderPublicKey: Uint8Array,
  options?: { maxAgeMs?: number; skipTimestampCheck?: boolean },
): VerifyMessageResult {
  // Check envelope version
  if (message.envelope !== 'atel.msg.v1') {
    return { valid: false, error: `Unsupported envelope version: ${message.envelope}` };
  }

  // Check required fields
  if (!message.from || !message.to || !message.type || !message.nonce) {
    return { valid: false, error: 'Missing required fields' };
  }

  // Check timestamp freshness (replay protection)
  if (!options?.skipTimestampCheck) {
    const maxAge = options?.maxAgeMs ?? MAX_MESSAGE_AGE_MS;
    const messageTime = new Date(message.timestamp).getTime();
    const now = Date.now();

    if (isNaN(messageTime)) {
      return { valid: false, error: 'Invalid timestamp format' };
    }

    if (now - messageTime > maxAge) {
      return { valid: false, error: 'Message expired (timestamp too old)' };
    }

    if (messageTime > now + 30_000) {
      return { valid: false, error: 'Message timestamp is in the future' };
    }
  }

  // Verify signature
  const { signature, ...unsigned } = message;
  const signable = serializePayload(unsigned);

  if (!verify(signable, signature, senderPublicKey)) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * Serialize an ATEL message to JSON string for transmission.
 *
 * @param message - The message to serialize.
 * @returns JSON string.
 */
export function serializeMessage(message: ATELMessage): string {
  return JSON.stringify(message);
}

/**
 * Deserialize a JSON string into an ATEL message.
 *
 * @param json - The JSON string to parse.
 * @returns The parsed ATELMessage.
 * @throws EnvelopeError if parsing fails.
 */
export function deserializeMessage(json: string): ATELMessage {
  try {
    const parsed = JSON.parse(json);
    if (!parsed.envelope || !parsed.type || !parsed.from) {
      throw new EnvelopeError('Invalid ATEL message structure');
    }
    return parsed as ATELMessage;
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    throw new EnvelopeError(`Failed to parse ATEL message: ${(e as Error).message}`);
  }
}

// ─── Nonce Tracker (Replay Protection) ───────────────────────────

/**
 * Tracks seen nonces to prevent replay attacks.
 * Automatically evicts expired entries.
 */
export class NonceTracker {
  private seen: Map<string, number> = new Map();
  private readonly maxAgeMs: number;

  constructor(maxAgeMs: number = MAX_MESSAGE_AGE_MS * 2) {
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Check if a nonce has been seen before. If not, record it.
   *
   * @param nonce - The nonce to check.
   * @returns True if the nonce is new (not a replay).
   */
  check(nonce: string): boolean {
    this.evict();

    if (this.seen.has(nonce)) {
      return false; // Replay detected
    }

    this.seen.set(nonce, Date.now());
    return true;
  }

  /** Remove expired nonces. */
  private evict(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [nonce, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(nonce);
      }
    }
  }

  /** Get the number of tracked nonces. */
  get size(): number {
    return this.seen.size;
  }
}
