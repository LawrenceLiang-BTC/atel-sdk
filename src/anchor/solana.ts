/**
 * Solana Anchor Provider.
 *
 * Anchors hashes on Solana using the official Memo Program
 * (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
 *
 * The memo content is formatted as `ATEL_ANCHOR:<hash>` so anchored
 * transactions are easily identifiable.
 *
 * @remarks
 * ⚠️ SECURITY: The `privateKey` (Base58-encoded) is used to sign
 * transactions. Never hard-code it — use environment variables or a vault.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { AnchorProvider, AnchorRecord, AnchorVerification, ChainId } from './index.js';

/** Configuration for the Solana anchor provider */
export interface SolanaAnchorConfig {
  /** Solana JSON-RPC endpoint URL */
  rpcUrl: string;
  /**
   * Base58-encoded private key for signing transactions.
   * Optional — if omitted the provider can only verify / lookup.
   *
   * ⚠️ SECURITY: Keep this value secret.
   */
  privateKey?: string;
}

/** Solana Memo Program address */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Prefix prepended to the hash in the memo (legacy format) */
const ANCHOR_PREFIX = 'ATEL_ANCHOR:';

/** V2 structured memo format: ATEL:1:<executorDID>:<requesterDID>:<taskId>:<trace_root> */
const ANCHOR_V2_PREFIX = 'ATEL:1:';

/** Structured anchor metadata for v2 memo */
export interface AnchorMemoV2 {
  version: 1;
  executorDid: string;
  requesterDid: string;
  taskId: string;
  traceRoot: string;
}

/**
 * Anchor provider for the Solana blockchain.
 */
export class SolanaAnchorProvider implements AnchorProvider {
  readonly name = 'Solana';
  readonly chain = 'solana';

  /** Solana RPC connection */
  private readonly connection: Connection;
  /** Keypair for signing (undefined when no private key is supplied) */
  private readonly keypair?: Keypair;

  /** Default Solana mainnet-beta RPC URL */
  static readonly DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

  /**
   * @param config - RPC URL and optional private key.
   *   If `rpcUrl` is omitted, the Solana mainnet-beta default is used.
   */
  constructor(config?: Partial<SolanaAnchorConfig>) {
    this.connection = new Connection(
      config?.rpcUrl ?? SolanaAnchorProvider.DEFAULT_RPC_URL,
      'confirmed',
    );

    if (config?.privateKey) {
      // ⚠️ SECURITY: The keypair holds the private key in memory.
      const secretKey = bs58.decode(config.privateKey);
      this.keypair = Keypair.fromSecretKey(secretKey);
    }
  }

  /**
   * Encode a hash into the memo data buffer (v2 structured format).
   * Falls back to legacy format if no metadata provided.
   */
  static encodeMemo(hash: string, meta?: { executorDid?: string; requesterDid?: string; taskId?: string }): Buffer {
    if (meta?.executorDid && meta?.requesterDid && meta?.taskId) {
      return Buffer.from(`${ANCHOR_V2_PREFIX}${meta.executorDid}:${meta.requesterDid}:${meta.taskId}:${hash}`, 'utf-8');
    }
    return Buffer.from(`${ANCHOR_PREFIX}${hash}`, 'utf-8');
  }

  /**
   * Decode a hash from memo data. Supports both v2 structured and legacy format.
   *
   * @returns The decoded hash, or `null` if the data doesn't match.
   */
  static decodeMemo(data: Buffer | Uint8Array | string): string | null {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
    // V2 structured format
    if (text.startsWith(ANCHOR_V2_PREFIX)) {
      const parts = text.slice(ANCHOR_V2_PREFIX.length).split(':');
      if (parts.length >= 4) return parts[parts.length - 1]; // last part is trace_root
    }
    // Legacy format
    if (text.startsWith(ANCHOR_PREFIX)) {
      return text.slice(ANCHOR_PREFIX.length);
    }
    return null;
  }

  /**
   * Decode full structured memo (v2 only).
   * Returns null for legacy format memos.
   */
  static decodeMemoV2(data: Buffer | Uint8Array | string): AnchorMemoV2 | null {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
    if (!text.startsWith(ANCHOR_V2_PREFIX)) return null;
    const rest = text.slice(ANCHOR_V2_PREFIX.length);
    // Format: executorDID:requesterDID:taskId:traceRoot
    // DIDs contain colons (did:atel:ed25519:xxx), so we need smart parsing
    // Split by ':' and reconstruct DIDs
    const parts = rest.split(':');
    // Minimum: did:atel:ed25519:key : did:atel:ed25519:key : taskId : traceRoot = 4+4+1+1 = 10 parts
    if (parts.length < 10) return null;
    // Each DID is 4 parts: did:atel:ed25519:base58
    const executorDid = parts.slice(0, 4).join(':');
    const requesterDid = parts.slice(4, 8).join(':');
    const taskId = parts[8];
    const traceRoot = parts.slice(9).join(':');
    if (!executorDid.startsWith('did:atel:') || !requesterDid.startsWith('did:atel:')) return null;
    return { version: 1, executorDid, requesterDid, taskId, traceRoot };
  }

  /** @inheritdoc */
  async anchor(hash: string, metadata?: Record<string, unknown>): Promise<AnchorRecord> {
    if (!this.keypair) {
      throw new Error('Solana: Cannot anchor without a private key');
    }

    const memoData = SolanaAnchorProvider.encodeMemo(hash, metadata as any);

    const instruction = new TransactionInstruction({
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM_ID,
      data: memoData,
    });

    const transaction = new Transaction().add(instruction);

    try {
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.keypair],
        { commitment: 'confirmed' },
      );

      // Fetch the confirmed transaction to get slot/block info
      let blockNumber: number | undefined;
      try {
        const txInfo = await this.connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        blockNumber = txInfo?.slot;
      } catch {
        // Non-critical
      }

      return {
        hash,
        txHash: signature,
        chain: 'solana' as ChainId,
        timestamp: Date.now(),
        blockNumber,
        metadata,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Solana anchor failed: ${message}`);
    }
  }

  /** @inheritdoc */
  async verify(hash: string, txHash: string): Promise<AnchorVerification> {
    try {
      const txInfo = await this.connection.getTransaction(txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!txInfo) {
        return {
          valid: false,
          hash,
          txHash,
          chain: this.chain,
          detail: 'Transaction not found',
        };
      }

      // Search through instructions for a memo matching our hash
      const message = txInfo.transaction.message;

      let foundHash: string | null = null;

      for (let i = 0; i < message.compiledInstructions.length; i++) {
        const ix = message.compiledInstructions[i];
        const keys = message.getAccountKeys();
        const programId = keys.get(ix.programIdIndex);

        if (programId?.equals(MEMO_PROGRAM_ID)) {
          foundHash = SolanaAnchorProvider.decodeMemo(Buffer.from(ix.data));
          if (foundHash) break;
        }
      }

      // Fallback: check log messages for memo content
      if (!foundHash && txInfo.meta?.logMessages) {
        for (const log of txInfo.meta.logMessages) {
          if (log.includes(ANCHOR_PREFIX)) {
            const idx = log.indexOf(ANCHOR_PREFIX);
            foundHash = log.slice(idx + ANCHOR_PREFIX.length);
            break;
          }
        }
      }

      if (foundHash === null) {
        return {
          valid: false,
          hash,
          txHash,
          chain: this.chain,
          detail: 'No anchor memo found in transaction',
        };
      }

      const valid = foundHash === hash;
      const blockTimestamp = txInfo.blockTime ? txInfo.blockTime * 1000 : undefined;

      return {
        valid,
        hash,
        txHash,
        chain: this.chain,
        blockTimestamp,
        detail: valid
          ? 'Hash matches on-chain memo'
          : `Hash mismatch: expected "${hash}", found "${foundHash}"`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        hash,
        txHash,
        chain: this.chain,
        detail: `Verification error: ${message}`,
      };
    }
  }

  /** @inheritdoc */
  async lookup(hash: string): Promise<AnchorRecord[]> {
    // On-chain lookup without an indexer is not feasible for Solana.
    // In production, integrate with a Solana indexer or Helius API.
    return [];
  }

  /** @inheritdoc */
  async isAvailable(): Promise<boolean> {
    try {
      await this.connection.getSlot();
      return true;
    } catch {
      return false;
    }
  }
}
