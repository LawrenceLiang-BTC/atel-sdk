/**
 * EVM Anchor Provider — shared base class for EVM-compatible chains.
 *
 * Anchors a hash by sending a zero-value transaction to the signer's
 * own address with the hash encoded in the `data` field. This is the
 * simplest on-chain timestamping approach — no contract deployment needed.
 *
 * Both {@link BaseAnchorProvider} and {@link BSCAnchorProvider} extend this class.
 *
 * @remarks
 * ⚠️ SECURITY: The `privateKey` is used to sign transactions.
 * Never hard-code private keys in source code. Use environment variables
 * or a secure vault in production.
 */

import { ethers } from 'ethers';
import type { AnchorProvider, AnchorRecord, AnchorVerification, ChainId } from './index.js';

/** Configuration for an EVM-based anchor provider */
export interface EvmAnchorConfig {
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
  /**
   * Hex-encoded private key for signing transactions.
   * Optional — if omitted the provider can only verify / lookup.
   *
   * ⚠️ SECURITY: Keep this value secret. Load from env vars or a vault.
   */
  privateKey?: string;
}

/**
 * Prefix prepended to the hash in the transaction data field (legacy)
 * so anchored transactions are easily identifiable.
 */
const ANCHOR_PREFIX = 'ATEL_ANCHOR:';

/** V2 structured format: ATEL:1:<executorDID>:<requesterDID>:<taskId>:<trace_root> */
const ANCHOR_V2_PREFIX = 'ATEL:1:';

/** Structured anchor metadata for v2 */
export interface EvmAnchorMemoV2 {
  version: 1;
  executorDid: string;
  requesterDid: string;
  taskId: string;
  traceRoot: string;
}

/**
 * Abstract EVM anchor provider.
 *
 * Subclasses only need to supply `name`, `chain`, and a default RPC URL.
 */
export class EvmAnchorProvider implements AnchorProvider {
  readonly name: string;
  readonly chain: string;

  /** Ethers JSON-RPC provider (read-only access) */
  protected readonly provider: ethers.JsonRpcProvider;
  /** Wallet for signing (undefined when no private key is supplied) */
  protected readonly wallet?: ethers.Wallet;

  /**
   * @param name - Human-readable provider name.
   * @param chain - Chain identifier.
   * @param config - RPC URL and optional private key.
   */
  constructor(name: string, chain: string, config: EvmAnchorConfig) {
    this.name = name;
    this.chain = chain;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    if (config.privateKey) {
      // ⚠️ SECURITY: The wallet holds the private key in memory.
      this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    }
  }

  /**
   * Encode a hash string into the hex data payload for a transaction.
   * Uses v2 structured format if metadata provided, legacy otherwise.
   */
  static encodeData(hash: string, meta?: { executorDid?: string; requesterDid?: string; taskId?: string }): string {
    if (meta?.executorDid && meta?.requesterDid && meta?.taskId) {
      return ethers.hexlify(ethers.toUtf8Bytes(`${ANCHOR_V2_PREFIX}${meta.executorDid}:${meta.requesterDid}:${meta.taskId}:${hash}`));
    }
    return ethers.hexlify(ethers.toUtf8Bytes(`${ANCHOR_PREFIX}${hash}`));
  }

  /**
   * Decode the hash from a transaction data field. Supports v2 and legacy.
   *
   * @returns The decoded hash, or `null` if the data doesn't match the expected format.
   */
  static decodeData(data: string): string | null {
    try {
      const text = ethers.toUtf8String(data);
      if (text.startsWith(ANCHOR_V2_PREFIX)) {
        const parts = text.slice(ANCHOR_V2_PREFIX.length).split(':');
        if (parts.length >= 4) return parts[parts.length - 1];
      }
      if (text.startsWith(ANCHOR_PREFIX)) {
        return text.slice(ANCHOR_PREFIX.length);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Decode full structured data (v2 only).
   * Returns null for legacy format.
   */
  static decodeDataV2(data: string): EvmAnchorMemoV2 | null {
    try {
      const text = ethers.toUtf8String(data);
      if (!text.startsWith(ANCHOR_V2_PREFIX)) return null;
      const rest = text.slice(ANCHOR_V2_PREFIX.length);
      const parts = rest.split(':');
      if (parts.length < 10) return null;
      const executorDid = parts.slice(0, 4).join(':');
      const requesterDid = parts.slice(4, 8).join(':');
      const taskId = parts[8];
      const traceRoot = parts.slice(9).join(':');
      if (!executorDid.startsWith('did:atel:') || !requesterDid.startsWith('did:atel:')) return null;
      return { version: 1, executorDid, requesterDid, taskId, traceRoot };
    } catch {
      return null;
    }
  }

  /** @inheritdoc */
  async anchor(hash: string, metadata?: Record<string, unknown>): Promise<AnchorRecord> {
    if (!this.wallet) {
      throw new Error(`${this.name}: Cannot anchor without a private key`);
    }

    const data = EvmAnchorProvider.encodeData(hash, metadata as any);

    try {
      const tx = await this.wallet.sendTransaction({
        to: this.wallet.address,
        value: 0n,
        data,
      });

      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error('Transaction receipt is null — tx may have been dropped');
      }

      return {
        hash,
        txHash: receipt.hash,
        chain: this.chain as ChainId,
        timestamp: Date.now(),
        blockNumber: receipt.blockNumber,
        metadata,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${this.name} anchor failed: ${message}`);
    }
  }

  /** @inheritdoc */
  async verify(hash: string, txHash: string): Promise<AnchorVerification> {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) {
        return {
          valid: false,
          hash,
          txHash,
          chain: this.chain,
          detail: 'Transaction not found',
        };
      }

      const decoded = EvmAnchorProvider.decodeData(tx.data);
      if (decoded === null) {
        return {
          valid: false,
          hash,
          txHash,
          chain: this.chain,
          detail: 'Transaction data does not contain a valid anchor',
        };
      }

      const valid = decoded === hash;

      // Try to get block timestamp
      let blockTimestamp: number | undefined;
      if (tx.blockNumber) {
        try {
          const block = await this.provider.getBlock(tx.blockNumber);
          blockTimestamp = block ? block.timestamp * 1000 : undefined;
        } catch {
          // Non-critical — skip timestamp
        }
      }

      return {
        valid,
        hash,
        txHash,
        chain: this.chain,
        blockTimestamp,
        detail: valid
          ? 'Hash matches on-chain data'
          : `Hash mismatch: expected "${hash}", found "${decoded}"`,
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
    // On-chain lookup without an indexer is not feasible for EVM chains.
    // In production, integrate with a subgraph or event indexer.
    // For now, return an empty array — local records are managed by AnchorManager.
    return [];
  }

  /** @inheritdoc */
  async isAvailable(): Promise<boolean> {
    try {
      await this.provider.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Query ATEL anchor transactions for a wallet address using Etherscan-compatible API.
   *
   * @param walletAddress - EVM wallet address (0x...)
   * @param explorerApiUrl - Etherscan/Basescan/BSCscan API base URL
   * @param apiKey - Explorer API key (optional, rate-limited without)
   * @param options - limit, filterDid
   * @returns Array of parsed v2 anchor records
   */
  async queryByWallet(
    walletAddress: string,
    explorerApiUrl: string,
    apiKey?: string,
    options?: { limit?: number; filterDid?: string },
  ): Promise<Array<EvmAnchorMemoV2 & { txHash: string; blockTime?: number }>> {
    const results: Array<EvmAnchorMemoV2 & { txHash: string; blockTime?: number }> = [];
    const limit = options?.limit ?? 100;

    try {
      // Query normal transactions from this address
      let url = `${explorerApiUrl}?module=account&action=txlist&address=${walletAddress}&sort=desc&page=1&offset=${limit}`;
      if (apiKey) url += `&apikey=${apiKey}`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await resp.json() as any;
      if (data.status !== '1' || !Array.isArray(data.result)) return results;

      for (const tx of data.result) {
        // Only self-transactions (to === from) with data
        if (!tx.input || tx.input === '0x') continue;
        if (tx.from?.toLowerCase() !== walletAddress.toLowerCase()) continue;

        try {
          const text = ethers.toUtf8String(tx.input);
          if (!text.startsWith(ANCHOR_V2_PREFIX)) continue;

          const parsed = EvmAnchorProvider.decodeDataV2(tx.input);
          if (!parsed) continue;

          if (options?.filterDid && parsed.executorDid !== options.filterDid && parsed.requesterDid !== options.filterDid) continue;

          results.push({
            ...parsed,
            txHash: tx.hash,
            blockTime: tx.timeStamp ? parseInt(tx.timeStamp) * 1000 : undefined,
          });
        } catch {
          // Not UTF-8 decodable, skip
        }
      }
    } catch {
      // Query failed
    }

    return results;
  }
}
