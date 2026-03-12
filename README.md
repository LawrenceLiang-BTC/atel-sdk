# ATEL SDK

**Agent Trust & Economics Layer** — a TypeScript protocol SDK for building trustworthy, auditable multi-agent systems.

ATEL provides the cryptographic primitives and protocol building blocks that let AI agents collaborate safely: identity verification, scoped consent, policy enforcement, tamper-evident execution traces, Merkle-tree proofs, and reputation scoring.

## ✨ What's New in v0.9.0

- **🔍 System Status Command** — Check agent health with `atel status`
- **🤖 Ollama Auto-Init** — Automatic Ollama service startup and model download
- **📊 Visual Health Indicators** — Clear ✅/❌/⚠️ status display
- **🔐 Enhanced Security** — Improved audit verification with local LLM fallback

See [docs/STATUS_AND_OLLAMA_FEATURE.md](docs/STATUS_AND_OLLAMA_FEATURE.md) for details.

## Quick Start

### For End Users (CLI)

Install the ATEL CLI globally:

```bash
npm install -g @lawrenceliang-btc/atel-sdk
atel init my-agent
atel register "My Agent" "assistant,research"
atel start 3100
```

**Check system status:**
```bash
atel status
# Shows: Identity, Agent, Executor, Gateway, Ollama, Audit, Network
```

See [skill/references/quickstart.md](skill/references/quickstart.md) for detailed setup and upgrade instructions.

### For Developers (SDK)

Clone and build from source:

```bash
git clone https://github.com/LawrenceLiang-BTC/atel-sdk.git
cd atel-sdk
npm install
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
| **Audit** | Thinking verification with tiered strategy (Gateway → Ollama → Rule) |

## Audit System

ATEL includes a comprehensive audit system for verifying agent thinking processes:

### Tiered Verification Strategy

```
┌─────────────────────────────────────────────┐
│           Audit Verification                │
├─────────────────────────────────────────────┤
│  1. Gateway (OpenClaw)  ← Primary           │
│  2. Ollama (Local LLM)  ← Fallback          │
│  3. Rule-Based          ← Last Resort       │
└─────────────────────────────────────────────┘
```

**Features:**
- **Auto-initialization**: Ollama service starts automatically on agent startup
- **Model management**: Automatic download of `qwen2.5:0.5b` (397MB) if missing
- **Non-blocking**: Audit runs asynchronously, never blocks task completion
- **Graceful degradation**: Falls back to simpler verification if advanced methods fail

**Verification Levels:**
1. **Gateway**: Uses OpenClaw Gateway to call large language models
2. **Ollama**: Local LLM inference for offline verification
3. **Rule**: Keyword-based pattern matching (always available)

See [docs/AUDIT_SERVICE.md](docs/AUDIT_SERVICE.md) for implementation details.

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
Status & Ollama features: `docs/STATUS_AND_OLLAMA_FEATURE.md`

ATEL skill package: `skills/atel/SKILL.md`

### CLI Commands

**System Management:**
```bash
atel init [name]              # Create agent identity
atel info                     # Show identity and configuration
atel status                   # Check system health (NEW in v0.9.0)
atel status --json            # JSON output for monitoring
```

**Network Setup:**
```bash
atel setup [port]             # Configure network (IP, UPnP, verify)
atel verify                   # Verify port reachability
atel start [port]             # Start agent endpoint (auto-init Ollama)
```

**Registry:**
```bash
atel register [name] [caps]   # Register on public registry
atel search <capability>      # Search for agents
```

**Task Execution:**
```bash
atel task <target> <json>     # Delegate task to agent
atel result <taskId> <json>   # Submit execution result
```

**Trust & Verification:**
```bash
atel check <did> [risk]       # Check agent trust score
atel audit <did> <taskId>     # Deep audit with trace verification
atel verify-proof <tx> <root> # Verify on-chain proof
```

**Account & Trading:**
```bash
atel balance                  # Show account balance
atel order <did> <cap> <price> # Create trade order
atel accept <orderId>         # Accept order
atel complete <orderId>       # Mark complete
atel confirm <orderId>        # Confirm and settle
```

### Status Command Output

```
=== ATEL Agent Status ===

Identity: ✅ did:atel:ed25519:Huqt3hpi...
Agent:    ✅ Running (port 14002)
Executor: ✅ Available (http://127.0.0.1:14004)
Gateway:  ✅ Connected (http://localhost:18789)
Ollama:   ✅ Running (1 models)
  Models: qwen2.5:0.5b
Audit:    ✅ Enabled (Gateway → Ollama → Rule)
Registry: http://47.251.8.19:8200
Network:  ✅ http://43.160.230.129:14002
```

### Module 1: Identity

```typescript
import { AgentIdentity, generateKeyPair, createDID, sign, verify } from '@lawrenceliang-btc/atel-sdk';

const agent = new AgentIdentity();
console.log(agent.did);           // "did:atel:..."
const sig = agent.sign(payload);
const ok = agent.verify(payload, sig);
```

### Module 2: Schema

```typescript
import { createTask, createCapability, matchTaskToCapability } from '@lawrenceliang-btc/atel-sdk';

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
import { mintConsentToken, verifyConsentToken, PolicyEngine } from '@lawrenceliang-btc/atel-sdk';

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
import { ToolGateway } from '@lawrenceliang-btc/atel-sdk';

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
import { ExecutionTrace } from '@lawrenceliang-btc/atel-sdk';

const trace = new ExecutionTrace(taskId, agentIdentity);
trace.append('TASK_ACCEPTED', { ... });
trace.append('TOOL_CALL', { ... });
trace.finalize(result);

const { valid, errors } = trace.verify();
```

### Module 6: Proof

```typescript
import { ProofGenerator, ProofVerifier } from '@lawrenceliang-btc/atel-sdk';

const gen = new ProofGenerator(trace, identity);
const bundle = gen.generate(policyRef, consentRef, resultRef);

const report = ProofVerifier.verify(bundle, { trace });
// report.valid, report.checks, report.summary
```

### Module 7: On-Chain Anchoring

```typescript
import { SolanaAnchorProvider, BaseAnchorProvider, BSCAnchorProvider } from '@lawrenceliang-btc/atel-sdk';

// Anchor proof to Solana
const solana = new SolanaAnchorProvider({ 
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  privateKey: process.env.ATEL_SOLANA_PRIVATE_KEY 
});
const result = await solana.anchor(traceRoot, {
  executorDid: 'did:atel:ed25519:...',
  requesterDid: 'did:atel:ed25519:...',
  taskId: 'task-123'
});
// result.txHash, result.blockNumber

// Verify on-chain anchor
const verified = await solana.verify(traceRoot, txHash);
// verified.valid, verified.detail
```

**Supported Chains:**
- Solana (Memo Program)
- Base (L2)
- BSC (Binance Smart Chain)

**On-Chain Format (v2):**
```
ATEL:1:executorDID:requesterDID:taskId:traceRoot
```

Example:
```
ATEL:1:did:atel:ed25519:ABC...:did:atel:ed25519:XYZ...:task-123:6776dd40b1aa3e1cc8d4f713c83d13ecb6b92aade817c9ef073a7607c6fe63d0
```

**Environment Variables:**
- `ATEL_SOLANA_PRIVATE_KEY` - Solana wallet private key (base58)
- `ATEL_SOLANA_RPC_URL` - Solana RPC endpoint (default: mainnet-beta)
- `ATEL_BASE_PRIVATE_KEY` - Base chain private key (hex)
- `ATEL_BASE_RPC_URL` - Base RPC endpoint (default: https://mainnet.base.org)
- `ATEL_BSC_PRIVATE_KEY` - BSC private key (hex)
- `ATEL_BSC_RPC_URL` - BSC RPC endpoint (default: https://bsc-dataseed.binance.org)

### Module 8: Score

```typescript
import { TrustScoreClient } from '@lawrenceliang-btc/atel-sdk';

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

## Current Status (2026-03-13)

- [x] **Phase 0 MVP complete** — 13 modules implemented, core trust workflow end-to-end
- [x] **241 tests in suite** — unit/integration coverage across modules
- [x] **Demo coverage** — success path + failure scenarios
- [x] **Audit system** — Thinking verification with tiered strategy (Gateway → Ollama → Rule)
- [x] **v0.9.0 released** — Status command, Ollama auto-init, enhanced monitoring
- [x] **Production deployment** — Platform + SDK deployed and tested
- [ ] **Phase 0.5 validation** — real agents + real external tools + real testnet anchoring

## Recent Updates

### v0.9.0 (2026-03-13)
- ✅ Added `atel status` command for system health monitoring
- ✅ Automatic Ollama service initialization on agent startup
- ✅ Auto-download of `qwen2.5:0.5b` model (397MB)
- ✅ Visual status indicators (✅/❌/⚠️)
- ✅ JSON output support for programmatic monitoring
- ✅ Repository cleanup (removed sensitive data and internal reports)

### v0.8.x (2026-03-12)
- ✅ Implemented comprehensive audit system
- ✅ Tiered verification strategy (Gateway → Ollama → Rule)
- ✅ Async audit queue with retry mechanism
- ✅ Security fixes (shell injection, promise rejection handling)
- ✅ Platform integration with thinking verification

## Roadmap

- [ ] **Phase 0.5** — Internal multi-agent cluster with real API/tool workloads
- [ ] **Phase 1** — Enterprise pilot + external integration hardening
- [ ] **Phase 2** — Open SDK access + Trust Score/Graph network rollout
- [ ] **Phase 3+** — Discovery/Directory and Router/Marketplace layers

## License

MIT
