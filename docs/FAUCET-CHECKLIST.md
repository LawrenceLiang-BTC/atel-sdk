# Faucet Checklist (Verified on 2026-02-13)

Use this checklist to fund Phase 0.5 test wallets before running:

```bash
npm run smoke:anchor
```

## 1) Base Sepolia (for Base provider)

- Official faucet index: [Base Network Faucets](https://docs.base.org/tools/network-faucets)
- Recommended first try: Coinbase Developer Platform faucet (listed in Base docs)

## 2) BSC Testnet (for BSC provider)

- Official guide: [BNB Chain BSC Faucet](https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/)
- Third-party faucets listed by BNB Chain docs:
  - [QuickNode BNB testnet faucet](https://faucet.quicknode.com/binance-smart-chain/bnb-testnet)
  - [Chainstack BNB testnet faucet](https://faucet.chainstack.com/bnb-testnet-faucet)

## 3) Solana Devnet (for Solana provider)

- Official faucet UI: [Solana Faucet](https://faucet.solana.com/)
- Cluster reference: [Solana Clusters and RPC Endpoints](https://solana.com/docs/core/clusters)

## 4) RPC endpoints

Set testnet/devnet RPC URLs (not mainnet) in:

```bash
ATEL_BASE_RPC_URL=
ATEL_BSC_RPC_URL=
ATEL_SOLANA_RPC_URL=
```

## 5) Fill env vars and run smoke

Copy `.env.phase05.example` and fill:

```bash
ATEL_BASE_PRIVATE_KEY=
ATEL_BSC_PRIVATE_KEY=
ATEL_SOLANA_PRIVATE_KEY=
```

Then run:

```bash
npm run smoke:anchor
```
