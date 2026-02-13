---
name: atel
description: Use ATEL SDK to run trusted agent execution in Local Mode (default) or Network Mode (optional), with proof verification, anchor receipt checks, and trust sync status checks. Use this whenever an agent needs to execute tasks with auditable trust guarantees.
---

# ATEL Skill

Use this skill when an agent needs trusted execution with verifiable evidence.

## Quick Start Workflow

1. Run deployment acceptance first:

```bash
npm run acceptance:deploy
```

2. If status is PASS, choose mode:
- Local Mode: no network trust sync.
- Network Mode: configure `HttpTrustSyncAdapter` with your self-hosted TrustScoreService.

3. After each execution, evaluate:
- `proof` validity
- `anchor` receipt (`anchored`, `verificationPassed`)
- `trustSync` receipt (`mode`, `networkSynced`)

## Required Decision Rules

For high-risk tasks, require:
- `proofValid = true`
- `anchor.verificationPassed = true`
- if Network Mode is required by policy: `trustSync.networkSynced = true`

For low-risk tasks, allow:
- `proofValid = true`
- `anchor` optional
- `trustSync` may be local-only

## Commands

```bash
npm run doctor
npm run acceptance:deploy
npm run run:cluster
```

## References

- API: `docs/API.md`
- 5-minute onboarding: `docs/QUICKSTART-5MIN.md`
- Service deployment: `docs/SERVICE-DEPLOY.md`
- Phase 0.5 ops: `docs/PHASE-0.5.md`
