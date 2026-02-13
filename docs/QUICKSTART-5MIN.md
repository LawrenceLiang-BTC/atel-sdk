# ATEL 5-Minute Quickstart

Goal: run one full trusted execution in 5 minutes.

## 1) Install and build

```bash
npm install
npm run build
```

## 2) Run deploy acceptance (recommended first run)

This starts a local trust service and verifies:
- identity/signature
- execution trace + proof verify
- standardized anchor receipt
- local + network trust sync

```bash
npm run acceptance:deploy
```

Expected output includes:
- `"status": "PASS"`
- `"proofValid": true`
- `"anchor.verificationPassed": true`
- `"trustSync.networkSynced": true`

## 3) Run basic doctor check

```bash
npm run doctor
```

This verifies local flow and optional connectivity checks.

## 4) Local Mode (no network service)

Use SDK directly without `trustSync`:

```ts
import { ATELOrchestrator } from '@lawreneliang/atel-sdk';
const orchestrator = new ATELOrchestrator();
```

Or run the minimal demo:

```bash
npm run quickstart:local
```

## 5) Network Mode (self-hosted trust service)

Start service:

```bash
ATEL_PORT=3100 ATEL_DATA_DIR=./data npm run serve
```

Use sync adapter:

```ts
import { ATELOrchestrator, HttpTrustSyncAdapter } from '@lawreneliang/atel-sdk';

const orchestrator = new ATELOrchestrator({
  trustSync: new HttpTrustSyncAdapter({ baseUrl: 'http://127.0.0.1:3100' }),
});
```

Or run the minimal demo:

```bash
npm run quickstart:network
```

Done. You now have a deployable baseline for both local-only and local+network trust workflows.
