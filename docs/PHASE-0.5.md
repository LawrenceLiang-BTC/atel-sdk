# Phase 0.5 Runbook

Phase 0.5 target: validate ATEL in real environments instead of mock-only flows.

## Exit Criteria

1. Real API workflow is passing end-to-end.
2. At least one successful testnet anchor per configured chain.
3. Baseline performance tests are passing.
4. Package can be built and published.
5. Docs are sufficient for external pilot teams.

## 1) Real API workflow

Command:

```bash
npm run demo:real
```

Expected:

- execution succeeds
- proof verifies
- trust score updates

## 2) Testnet anchor smoke

Set environment variables for one or more chains:

- Base:
  - `ATEL_BASE_RPC_URL`
  - `ATEL_BASE_PRIVATE_KEY`
- BSC:
  - `ATEL_BSC_RPC_URL`
  - `ATEL_BSC_PRIVATE_KEY`
- Solana:
  - `ATEL_SOLANA_RPC_URL`
  - `ATEL_SOLANA_PRIVATE_KEY`

Run:

```bash
npm run smoke:anchor
```

Expected:

- transaction submitted
- tx hash printed
- verify result is true

## 3) Performance baseline

Run:

```bash
npm run test:perf
```

Current baseline:

- 200 concurrent gateway calls
- 4,001-event trace verify

## 4) Publish readiness

Run:

```bash
npm run clean
npm run build
npm test
npm pack
```

Then publish:

```bash
npm publish --access public
```

## 5) Pilot rollout checklist

- Choose 3 real tasks (search, retrieval, transaction simulation).
- Run 5-10 internal agents for 7 consecutive days.
- Persist proofs and anchor records for audit.
- Track failure categories and rollback outcomes.

