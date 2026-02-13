# Trust Service Deployment

This project already supports split deployment without repository split:

- Agent runtime uses SDK locally.
- Network trust is hosted by your own `TrustScoreService`.
- SDK uploads summaries through `HttpTrustSyncAdapter`.

## 1) Start server

```bash
ATEL_PORT=3100 ATEL_DATA_DIR=./data npm run serve
```

## 2) SDK side wiring

```ts
import { ATELOrchestrator, HttpTrustSyncAdapter } from '@atel/sdk';

const orchestrator = new ATELOrchestrator({
  trustSync: new HttpTrustSyncAdapter({
    baseUrl: 'http://127.0.0.1:3100',
    timeoutMs: 10000,
  }),
});
```

## 3) Operation notes

- Persist `ATEL_DATA_DIR` on durable disk.
- Put service behind reverse proxy/TLS for production.
- Add auth (bearer token or gateway auth) for `/api/v1/summary`.
- Keep local mode enabled as fallback; network sync failures should not break execution.

