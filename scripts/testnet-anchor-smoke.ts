/**
 * Phase 0.5 smoke: real testnet anchor checks.
 *
 * Required env vars (set one or more chains):
 * - Base:   ATEL_BASE_RPC_URL,   ATEL_BASE_PRIVATE_KEY
 * - BSC:    ATEL_BSC_RPC_URL,    ATEL_BSC_PRIVATE_KEY
 * - Solana: ATEL_SOLANA_RPC_URL, ATEL_SOLANA_PRIVATE_KEY
 *
 * Optional:
 * - ATEL_ANCHOR_HASH: custom hash payload (default: sha256 of timestamp)
 */

import { createHash } from 'node:crypto';
import {
  AnchorManager,
  BaseAnchorProvider,
  BSCAnchorProvider,
  SolanaAnchorProvider,
} from '../src/index.js';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

async function run(): Promise<void> {
  const manager = new AnchorManager();

  const baseRpc = process.env.ATEL_BASE_RPC_URL;
  const basePk = process.env.ATEL_BASE_PRIVATE_KEY;
  if (baseRpc && basePk) {
    manager.registerProvider(new BaseAnchorProvider({ rpcUrl: baseRpc, privateKey: basePk }));
  }

  const bscRpc = process.env.ATEL_BSC_RPC_URL;
  const bscPk = process.env.ATEL_BSC_PRIVATE_KEY;
  if (bscRpc && bscPk) {
    manager.registerProvider(new BSCAnchorProvider({ rpcUrl: bscRpc, privateKey: bscPk }));
  }

  const solRpc = process.env.ATEL_SOLANA_RPC_URL;
  const solPk = process.env.ATEL_SOLANA_PRIVATE_KEY;
  if (solRpc && solPk) {
    manager.registerProvider(new SolanaAnchorProvider({ rpcUrl: solRpc, privateKey: solPk }));
  }

  const chains = manager.getProviders();
  if (chains.length === 0) {
    throw new Error('No testnet providers configured. Set env vars for at least one chain.');
  }

  const hash = process.env.ATEL_ANCHOR_HASH ?? sha256(`atel-smoke:${new Date().toISOString()}`);
  console.log('Anchoring hash:', hash);
  console.log('Target chains:', chains.join(', '));

  const records = await manager.anchorAll(hash, { purpose: 'phase-0.5-smoke' });
  for (const rec of records) {
    const check = await manager.verify(hash, rec.txHash, rec.chain);
    console.log(
      `[${rec.chain}] tx=${rec.txHash} block=${rec.blockNumber ?? '-'} verified=${check.valid}`,
    );
    if (!check.valid) {
      throw new Error(`Verification failed on ${rec.chain}: ${check.detail ?? 'unknown'}`);
    }
  }

  console.log(`Smoke completed: ${records.length} anchor(s) verified.`);
}

run().catch((err) => {
  console.error('testnet-anchor-smoke failed:', err);
  process.exit(1);
});
