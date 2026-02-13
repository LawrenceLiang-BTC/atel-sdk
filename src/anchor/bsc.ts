/**
 * BSC (BNB Smart Chain) Anchor Provider.
 *
 * Extends {@link EvmAnchorProvider} with BSC-specific defaults.
 *
 * Default RPC: https://bsc-dataseed.binance.org
 */

import { EvmAnchorProvider, type EvmAnchorConfig } from './evm.js';

/**
 * Anchor provider for the BSC chain.
 */
export class BSCAnchorProvider extends EvmAnchorProvider {
  /** Default BSC mainnet RPC URL */
  static readonly DEFAULT_RPC_URL = 'https://bsc-dataseed.binance.org';

  /**
   * @param config - RPC URL and optional private key.
   *   If `rpcUrl` is omitted, the BSC mainnet default is used.
   */
  constructor(config?: Partial<EvmAnchorConfig>) {
    super('BSC', 'bsc', {
      rpcUrl: config?.rpcUrl ?? BSCAnchorProvider.DEFAULT_RPC_URL,
      privateKey: config?.privateKey,
    });
  }
}
