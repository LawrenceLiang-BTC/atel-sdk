# ATEL SDK API Guide (Phase 0.5)

This document is the detailed module-level API guide for the current SDK.

## Installation

```bash
npm install @lawreneliang/atel-sdk
```

## Modules

### 1. Identity

- `AgentIdentity`
- `generateKeyPair()`
- `createDID(publicKey)`
- `parseDID(did)`
- `sign(payload, secretKey)`
- `verify(payload, signature, publicKey)`

### 2. Schema

- `createTask(params)`
- `createSignedTask(params, secretKey)`
- `validateTask(task)`
- `createCapability(params)`
- `validateCapability(cap)`
- `matchTaskToCapability(task, capability)`

### 3. Policy

- `mintConsentToken(issuer, executor, scopes, constraints, risk, signer)`
- `verifyConsentToken(token, issuerPublicKey)`
- `PolicyEngine(token)`
  - `.evaluate(action, risk?)`
  - `.recordCall()`
  - `.getRemainingCalls()`

### 4. Gateway

- `ToolGateway(policyEngine, options?)`
  - `.registerTool(name, handler)`
  - `.callTool({ tool, input, risk_level?, data_scope? })`
  - `.getCallLog()`
- `RealHttpTool.get(url, headers?)`
- `RealHttpTool.post(url, body, headers?)`

### 5. Trace

- `ExecutionTrace(taskId, identity, options?)`
  - `.append(type, data)`
  - `.checkpoint()`
  - `.finalize(result)`
  - `.fail(error)`
  - `.verify()`
  - `.getStats()`

### 6. Proof

- `ProofGenerator(trace, identity)`
  - `.generate(policyRef, consentRef, resultRef)`
  - `.generateFromContext({ consentToken, taskResult })`
- `ProofVerifier.verify(bundle, { trace?, executorPublicKey? })`

### 7. Score

- `TrustScoreClient()`
  - `.submitExecutionSummary(summary)`
  - `.getAgentScore(agentId)`
  - `.getAllScores()`

### 8. Graph

- `TrustGraph()`
  - `.recordInteraction(record)`
  - `.directTrust(from, to, scene)`
  - `.indirectTrust(from, to, scene)`
  - `.compositeTrust(from, to, scene)`
  - `.topPartners(agentId, k)`
  - `.detectSuspiciousClusters()`

### 9. Trust Manager

- `TrustManager()`
  - `.submitResult(submission)`
  - `.queryTrust(from, to, scene)`

### 10. Rollback

- `RollbackManager()`
  - `.registerCompensation(step, fn)`
  - `.executeRollback(steps)`

### 11. Anchor

- `AnchorManager()`
  - `.registerProvider(provider)`
  - `.anchor(hash, chain)`
  - `.anchorAll(hash)`
  - `.verify(hash, txHash, chain)`
- Providers:
  - `BaseAnchorProvider`
  - `BSCAnchorProvider`
  - `SolanaAnchorProvider`
  - `MockAnchorProvider`

### 12. Orchestrator

- `ATELOrchestrator(config?)`
  - `config.trustSync?` (optional network sync adapter)
  - `.delegateTask(params)`
  - `.executeTask(params)`
  - `.verifyExecution(proof, options?)`

`executeTask()` now returns standardized anchor fields for requestor decisions:

- `anchor.anchored`
- `anchor.anchoredHash`
- `anchor.verificationPassed`
- `anchor.records[]` (`chain`, `txHash`, `blockNumber`, `anchorVerified`)
- `anchor.failedChains[]`

`executeTask()` also returns trust sync status:

- `trustSync.mode` (`local-only` | `local+network`)
- `trustSync.localUpdated`
- `trustSync.networkSynced`
- `trustSync.reference?`
- `trustSync.detail?`

### 13. Service

- `TrustScoreService({ port, dataDir })`
  - `.start()`
  - `.stop()`
- HTTP endpoints under `/api/v1/*`:
  - `/health`
  - `/summary`
  - `/score/:agentId`
  - `/scores`
  - `/graph/*`

### 14. Trust Sync Adapter

- `HttpTrustSyncAdapter({ baseUrl, timeoutMs?, bearerToken? })`
  - `.submit(trustSubmission)`

Example:

```ts
import { ATELOrchestrator, HttpTrustSyncAdapter } from '@lawreneliang/atel-sdk';

const orchestrator = new ATELOrchestrator({
  trustSync: new HttpTrustSyncAdapter({
    baseUrl: 'http://127.0.0.1:3100',
  }),
});
```

## Phase 0.5 scripts

- Real API demo: `npm run demo:real`
- Testnet anchor smoke: `npm run smoke:anchor`
- Performance baseline: `npm run test:perf`
- Multi-agent continuous run: `npm run run:cluster`
