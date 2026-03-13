# ATEL SDK

**Agent Trust & Economics Layer** — a TypeScript protocol SDK for building trustworthy, auditable multi-agent systems.

ATEL provides the cryptographic primitives and protocol building blocks that let AI agents collaborate safely: identity verification, scoped consent, policy enforcement, tamper-evident execution traces, Merkle-tree proofs, and reputation scoring.

## ✨ What's New in v0.10.0

- **🤖 Zero-Config Deployment** — No external dependencies required (no Ollama installation)
- **📦 Auto Model Download** — Automatic download of audit model on first run (~400MB)
- **🔍 CoT Reasoning Requirement** — Agents are informed about CoT reasoning requirements during handshake
- **⚡ Pure Node.js** — Uses node-llama-cpp for local inference (cross-platform)
- **🎯 Improved Error Messages** — Clear hints when CoT reasoning capability is missing

## Quick Start

### For End Users (CLI)

Install the ATEL CLI globally:

```bash
npm install -g @lawrenceliang-btc/atel-sdk
atel init my-agent
atel register "My Agent" "assistant,research"
atel start 3100
```

**First run** (downloads audit model automatically):
```bash
atel start 3100
# 📦 Downloading model (first time only, ~400MB)...
#    Progress: 100% (408.9/408.9 MB)
# ✅ Model ready
# 🚀 Agent started on port 3100
```

**Subsequent runs** (model already downloaded):
```bash
atel start 3100
# 🔄 Loading model...
# ✅ Model ready
# 🚀 Agent started on port 3100
```

**Check system status:**
```bash
atel status
# Shows: Identity, Agent, Executor, Gateway, Audit, Network
```

See [docs/START-HERE.md](docs/START-HERE.md) for detailed setup instructions.

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
| **Audit** | CoT reasoning verification with local LLM (node-llama-cpp) |

## Audit System

ATEL includes a comprehensive audit system for verifying agent CoT (Chain-of-Thought) reasoning:

### Zero-Config Deployment

```
┌─────────────────────────────────────────────┐
│           Audit System                      │
├─────────────────────────────────────────────┤
│  ✅ No Ollama installation required         │
│  ✅ No Docker required                      │
│  ✅ Pure Node.js (node-llama-cpp)           │
│  ✅ Auto-download model on first run        │
│  ✅ Cross-platform (Linux/Mac/Windows)      │
└─────────────────────────────────────────────┘
```

**Features:**
- **Zero external dependencies**: Uses node-llama-cpp for local inference
- **Auto model download**: Downloads `qwen2.5-0.5b-instruct-q4_0.gguf` (~400MB) on first run
- **Non-blocking**: Audit runs asynchronously, never blocks task completion
- **Graceful degradation**: Skips audit if model unavailable (doesn't fail tasks)
- **CoT requirement notification**: Informs remote agents during handshake

**Performance:**
- First run: ~90s (download + load + inference)
- Subsequent runs: ~30s (load + inference)
- Audit confidence: 0.85

**Handshake Response:**
```json
{
  "...": "...",
  "requirements": {
    "cot_reasoning": {
      "required": true,
      "reason": "This agent uses CoT reasoning audit for task verification"
    }
  }
}
```

See [docs/AUDIT_SERVICE.md](docs/AUDIT_SERVICE.md) for implementation details.

## Trust Modes

ATEL supports two deployment modes that can coexist:

- `Local Mode` (default): execute, prove, verify, and score locally with no network dependency.
- `Network Mode` (optional): keep local trust updates, and additionally sync summaries to a shared trust service.

This means local capability is never removed when network trust is enabled.

## API Reference

**Documentation:**
- [docs/START-HERE.md](docs/START-HERE.md) — One-page onboarding
- [docs/QUICKSTART-5MIN.md](docs/QUICKSTART-5MIN.md) — 5-minute quickstart
- [docs/API.md](docs/API.md) — Detailed API guide
- [docs/AUDIT_SERVICE.md](docs/AUDIT_SERVICE.md) — Audit system guide
- [docs/builtin-executor-guide.md](docs/builtin-executor-guide.md) — Built-in executor guide
- [docs/protocol-specification.md](docs/protocol-specification.md) — Protocol specification

### CLI Commands

**System Management:**
```bash
atel init [name]              # Create agent identity
atel info                     # Show identity and configuration
atel status                   # Check system health
atel status --json            # JSON output for monitoring
```

**Network Setup:**
```bash
atel setup [port]             # Configure network (IP, UPnP, verify)
atel verify                   # Verify port reachability
atel start [port]             # Start agent endpoint (auto-download model)
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
- [x] **Audit system** — CoT reasoning verification with local LLM (node-llama-cpp)
- [x] **v0.10.0 released** — Zero-config deployment, auto model download, CoT requirement notification
- [x] **Production deployment** — Platform + SDK deployed and tested

## Recent Updates

### v0.10.0 (2026-03-13)
- ✅ Replaced Ollama with node-llama-cpp for zero-config deployment
- ✅ Auto-download audit model on first run (~400MB)
- ✅ Added CoT reasoning requirement notification in handshake
- ✅ Improved error messages with helpful hints
- ✅ Pure Node.js solution (no external dependencies)
- ✅ Cross-platform support (Linux/Mac/Windows)

### v0.9.0 (2026-03-12)
- ✅ Audit system refactoring (Thinking → CoT Reasoning)
- ✅ Removed endpoint parameter (always use local)
- ✅ Security fixes (shell injection, promise rejection handling)
- ✅ Repository cleanup (removed sensitive data)

## Roadmap

- [ ] **Phase 0.5** — Internal multi-agent cluster with real API/tool workloads
- [ ] **Phase 1** — Enterprise pilot + external integration hardening
- [ ] **Phase 2** — Open SDK access + Trust Score/Graph network rollout
- [ ] **Phase 3+** — Discovery/Directory and Router/Marketplace layers

## License

MIT
