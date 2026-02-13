/**
 * Base Chain Anchor Provider.
 *
 * Extends {@link EvmAnchorProvider} with Base-specific defaults.
 * Base is an EVM-compatible L2 built on the OP Stack.
 *
 * Default RPC: https://mainnet.base.org
 */

import { EvmAnchorProvider, type EvmAnchorConfig } from './evm.js';

/**
 * Anchor provider for the Base chain.
 */
export class BaseAnchorProvider extends EvmAnchorProvider {
  /** Default Base mainnet RPC URL */
  static readonly DEFAULT_RPC_URL = 'https://mainnet.base.org';

  /**
   * @param config - RPC URL and optional private key.
   *   If `rpcUrl` is omitted, the Base mainnet default is used.
   */
  constructor(config?: Partial<EvmAnchorConfig>) {
    super('Base', 'base', {
      rpcUrl: config?.rpcUrl ?? BaseAnchorProvider.DEFAULT_RPC_URL,
      privateKey: config?.privateKey,
    });
  }
}
