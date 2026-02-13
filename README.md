# ATEL SDK

**Agent Trust & Economics Layer** — a TypeScript protocol SDK for building trustworthy, auditable multi-agent systems.

ATEL provides the cryptographic primitives and protocol building blocks that let AI agents collaborate safely: identity verification, scoped consent, policy enforcement, tamper-evident execution traces, Merkle-tree proofs, and reputation scoring.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run the end-to-end demo
npx tsx demo/full-demo.ts
```

Phase 0.5 commands:

```bash
# Real external API e2e demo
npm run demo:real

# Testnet anchoring smoke (requires chain env vars)
npm run smoke:anchor

# Performance baseline
npm run test:perf

# 5-10 agent continuous run (Phase 0.5)
npm run run:cluster

# deploy acceptance (service + sync + proof + anchor)
npm run acceptance:deploy
```

The demo simulates two agents collaborating on a flight search task, exercising the end-to-end trust workflow.

## Architecture

ATEL is organized into 13 composable modules:

```
┌──────────────────────────────────────────────────────────────┐
│                         ATEL SDK                             │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Identity │  Schema  │  Policy  │ Gateway  │      Trace      │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│ Proof  │ Score │ Graph │ TrustManager │ Rollback │ Anchor    │
├───────────────────────────────┬──────────────────────────────┤
│          Orchestrator         │      Trust Score Service     │
└───────────────────────────────┴──────────────────────────────┘
```

| Module | Description |
|--------|-------------|
| **Identity** | Ed25519 key pairs, DID creation (`did:atel:*`), signing & verification |
| **Schema** | Task and Capability JSON schemas, validation, factory functions, matching |
| **Policy** | Consent tokens (scoped, time-limited), policy engine with call tracking |
| **Gateway** | Central tool invocation gateway with policy enforcement and deterministic hashing |
| **Trace** | Append-only, hash-chained execution log with auto-checkpoints |
| **Proof** | Merkle-tree proof bundles with multi-check verification |
| **Score** | Local trust-score computation based on execution history |
| **Graph** | Multi-dimensional trust graph, direct/indirect/composite trust |
| **TrustManager** | Unified score + graph submission and trust query API |
| **Rollback** | Compensation and rollback execution manager |
| **Anchor** | Multi-chain proof anchoring (Base/BSC/Solana/Mock) |
| **Orchestrator** | High-level API wiring task delegation/execution/verify |
| **Service** | HTTP API for score + graph queries with JSON persistence |

## Trust Modes

ATEL supports two deployment modes that can coexist:

- `Local Mode` (default): execute, prove, verify, and score locally with no network dependency.
- `Network Mode` (optional): keep local trust updates, and additionally sync summaries to a shared trust service.

This means local capability is never removed when network trust is enabled.

## API Reference

Detailed API guide: `docs/API.md`  
Start here (one-page onboarding): `docs/START-HERE.md`  
5-minute quickstart: `docs/QUICKSTART-5MIN.md`  
Phase 0.5 runbook: `docs/PHASE-0.5.md`
Service deployment: `docs/SERVICE-DEPLOY.md`

ATEL skill package: `skills/atel/SKILL.md`

### Module 1: Identity

```typescript
import { AgentIdentity, generateKeyPair, createDID, sign, verify } from '@atel/sdk';

const agent = new AgentIdentity();
console.log(agent.did);           // "did:atel:..."
const sig = agent.sign(payload);
const ok = agent.verify(payload, sig);
```

### Module 2: Schema

```typescript
import { createTask, createCapability, matchTaskToCapability } from '@atel/sdk';

const task = createTask({
  issuer: agent.did,
  intent: { type: 'flight_search', goal: 'Find flights SIN→HND' },
  risk: { level: 'medium' },
});

const cap = createCapability({
  provider: executor.did,
  capabilities: [{ type: 'flight_search', description: '...' }],
});

const match = matchTaskToCapability(task, cap);
```

### Module 3: Policy

```typescript
import { mintConsentToken, verifyConsentToken, PolicyEngine } from '@atel/sdk';

const token = mintConsentToken(
  issuer.did, executor.did,
  ['tool:http:get', 'data:public_web:read'],
  { max_calls: 10, ttl_sec: 3600 },
  'medium',
  issuer.secretKey,
);

verifyConsentToken(token, issuer.publicKey);

const engine = new PolicyEngine(token);
const decision = engine.evaluate(action);  // 'allow' | 'deny' | 'needs_confirm'
```

### Module 4: Gateway

```typescript
import { ToolGateway } from '@atel/sdk';

const gateway = new ToolGateway(policyEngine);
gateway.registerTool('http.get', async (input) => { /* ... */ });

const result = await gateway.callTool({
  tool: 'http.get',
  input: { url: '...' },
  consentToken: '...',
});
// result.output, result.input_hash, result.output_hash
```

### Module 5: Trace

```typescript
import { ExecutionTrace } from '@atel/sdk';

const trace = new ExecutionTrace(taskId, agentIdentity);
trace.append('TASK_ACCEPTED', { ... });
trace.append('TOOL_CALL', { ... });
trace.finalize(result);

const { valid, errors } = trace.verify();
```

### Module 6: Proof

```typescript
import { ProofGenerator, ProofVerifier } from '@atel/sdk';

const gen = new ProofGenerator(trace, identity);
const bundle = gen.generate(policyRef, consentRef, resultRef);

const report = ProofVerifier.verify(bundle, { trace });
// report.valid, report.checks, report.summary
```

### Module 7: Score

```typescript
import { TrustScoreClient } from '@atel/sdk';

const client = new TrustScoreClient();
client.submitExecutionSummary({ executor: did, task_id, success: true, ... });

const report = client.getAgentScore(did);
// report.trust_score (0-100), report.risk_flags, etc.
```

## Trust Score Formula

```
base        = success_rate × 60
volume      = min(total_tasks / 100, 1) × 15
risk_bonus  = (high_risk_successes / total) × 15
consistency = (1 − violation_rate) × 10
─────────────────────────────────────────
score       = base + volume + risk_bonus + consistency   (clamped 0–100)
```

## Current Status (2026-02-13)

- [x] **Phase 0 MVP complete** — 13 modules implemented, core trust workflow end-to-end
- [x] **241 tests in suite** — unit/integration coverage across modules
- [x] **Demo coverage** — success path + failure scenarios
- [ ] **Phase 0.5 validation** — real agents + real external tools + real testnet anchoring

## Roadmap

- [ ] **Phase 0.5** — Internal multi-agent cluster with real API/tool workloads
- [ ] **Phase 1** — Enterprise pilot + external integration hardening
- [ ] **Phase 2** — Open SDK access + Trust Score/Graph network rollout
- [ ] **Phase 3+** — Discovery/Directory and Router/Marketplace layers

## License

MIT
