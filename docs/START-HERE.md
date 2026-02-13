# START HERE: Integrate ATEL in 5 Minutes

This is the single-page entrypoint for external teams.

## 0) Install

```bash
npm install @lawreneliang/atel-sdk
```

If you are evaluating from source:

```bash
npm install
npm run build
```

## 1) Choose Mode

Use this decision rule:

- Use `Local Mode` if you want zero infrastructure and fast validation.
- Use `Network Mode` if multiple agents/teams need a shared trust view.

## 2A) Local Mode (no server required)

Run:

```bash
npx tsx demo/quickstart-local.ts
```

Expected:

- execution success
- proof valid
- anchor receipt available

## 2B) Network Mode (self-hosted trust service)

Start service:

```bash
ATEL_PORT=3100 ATEL_DATA_DIR=./data npm run serve
```

In another terminal:

```bash
npx tsx demo/quickstart-network.ts
```

Expected:

- local execution success
- trust sync `networkSynced=true`
- service receives summary updates

## 3) Run one-command deployment acceptance

```bash
npm run acceptance:deploy
```

Expected final status:

```json
{ "status": "PASS" }
```

## 4) Run doctor self-check

```bash
npm run doctor
```

Expected final status:

```json
{ "status": "PASS" }
```

## 5) Verify readiness for pilot

Run:

```bash
npm run run:cluster
```

Output report:

- `reports/cluster-run-latest.json`

## 6) What to check before production

- `proofValid == true`
- `anchor.verificationPassed == true` for high-risk tasks
- `trustSync.networkSynced == true` if network mode is required by policy

## References

- API: `docs/API.md`
- Quickstart detail: `docs/QUICKSTART-5MIN.md`
- Service deploy: `docs/SERVICE-DEPLOY.md`
- Phase 0.5 runbook: `docs/PHASE-0.5.md`
- Skill: `skills/atel/SKILL.md`
