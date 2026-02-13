/**
 * Generate test wallet addresses for Phase 0.5.
 *
 * Output:
 * - Base (EVM) address
 * - BSC (EVM) address
 * - Solana address
 *
 * By default, only addresses are printed.
 * To print private keys too, set ATEL_SHOW_PRIVATE_KEYS=1.
 */

import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function main(): void {
  const showSecrets = process.env.ATEL_SHOW_PRIVATE_KEYS === '1';

  const baseWallet = Wallet.createRandom();
  const bscWallet = Wallet.createRandom();
  const solanaWallet = Keypair.generate();

  console.log('ATEL Phase 0.5 Test Wallets');
  console.log('===========================');
  console.log(`Base (EVM) address:   ${baseWallet.address}`);
  console.log(`BSC (EVM) address:    ${bscWallet.address}`);
  console.log(`Solana address:       ${solanaWallet.publicKey.toBase58()}`);
  console.log('');

  if (showSecrets) {
    console.log('Private keys (keep secret):');
    console.log(`ATEL_BASE_PRIVATE_KEY=${baseWallet.privateKey}`);
    console.log(`ATEL_BSC_PRIVATE_KEY=${bscWallet.privateKey}`);
    console.log(`ATEL_SOLANA_PRIVATE_KEY=${bs58.encode(solanaWallet.secretKey)}`);
    console.log('');
  } else {
    console.log('Private keys are hidden.');
    console.log('To print them for one-time setup, run:');
    console.log('ATEL_SHOW_PRIVATE_KEYS=1 npm run wallets:generate');
    console.log('');
  }

  console.log('Env template:');
  console.log('ATEL_BASE_RPC_URL=');
  console.log(`ATEL_BASE_PRIVATE_KEY=${showSecrets ? baseWallet.privateKey : '<fill-me>'}`);
  console.log('ATEL_BSC_RPC_URL=');
  console.log(`ATEL_BSC_PRIVATE_KEY=${showSecrets ? bscWallet.privateKey : '<fill-me>'}`);
  console.log('ATEL_SOLANA_RPC_URL=');
  console.log(`ATEL_SOLANA_PRIVATE_KEY=${showSecrets ? bs58.encode(solanaWallet.secretKey) : '<fill-me>'}`);
}

main();
