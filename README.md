# ATEL SDK

**Agent Trust & Exchange Layer** — A protocol SDK and CLI for trustworthy, auditable multi-agent collaboration.

## Core Capabilities

ATEL provides the cryptographic primitives and protocol building blocks that enable secure AI agent collaboration:

- **🔐 Identity & Verification** — Ed25519 keypairs, DID creation, signing & verification
- **📋 Policy Enforcement** — Scoped consent tokens, call tracking, deterministic hashing
- **🔍 Execution Tracing** — Tamper-evident, hash-chained audit logs with auto-checkpoints
- **✅ Proof Generation** — Merkle-tree proof bundles with multi-check verification
- **⚓ On-Chain Anchoring** — Multi-chain proof anchoring (Solana/Base/BSC)
- **📊 Trust Scoring** — Local trust computation based on execution history
- **🔔 Notification & Callback Runtime** — Local notify, callback, inbox, and recovery flow
- **👥 P2P Access Control** — Relationship-based friend system with temporary sessions

## Key Features

### Runtime Model
- ATEL handles DID identity, relay, inbox, callback, notification, and paid order state
- OpenClaw or your own runtime handles reasoning and tool use
- Cross-platform CLI (Linux/macOS/Windows)
- Paid Platform orders currently support two settlement chains:
  - `Base`
  - `BSC`
- For paid orders, the chain truth source is always `order.chain`

### P2P Friend System
- Relationship-based access control (friends-only mode)
- Friend request workflow with approval
- Temporary sessions for non-friends (time & task limits)
- DID alias system (@alias syntax)
- Rate limiting and security validation

### Trust & Verification
- Tamper-evident execution traces
- Merkle-tree proof generation
- On-chain anchoring (Solana/Base/BSC)
- Local trust score computation
- Callback-driven execution and recovery

### Developer Experience
- Comprehensive CLI with detailed help
- Unified output format (human/json/quiet)
- Status commands for system overview
- Confirmation prompts for destructive operations
- Skill-first onboarding path

## Quick Start

### Installation

```bash
npm install -g @lawrenceliang-btc/atel-sdk
```

### Initialize Your Agent

```bash
atel init my-agent
atel register "My Agent" "assistant,research"
atel start 3100
```

If you want to support paid Platform orders on EVM chains, configure at least one paid-order chain key before or after registering:

```bash
export ATEL_BASE_PRIVATE_KEY=...
# or
export ATEL_BSC_PRIVATE_KEY=...
```

### Recommended Runtime

ATEL is not a built-in general-purpose LLM executor. The recommended setup is:

- OpenClaw handles agent reasoning and tool execution
- `atel start` handles endpoint, relay, callback, inbox, and notifications
- the provided `SKILL.md` handles setup and runtime conventions

For OpenClaw, enable `sessions_spawn` in Gateway and start the ATEL runtime:

```bash
openclaw gateway restart
atel start 3100
```

For custom runtimes, point `ATEL_EXECUTOR_URL` at your own service.

For paid orders, do not hardcode Base as the only chain. Runtime actions that touch escrow, release, refund, milestone anchoring, chain-record inspection, or balance interpretation must follow `order.chain`.

## Architecture

ATEL is organized into protocol and runtime layers:

```
┌──────────────────────────────────────────────────────────────┐
│                         ATEL CLI / SDK                       │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Identity │ Registry │  Policy  │  Relay   │      Trace      │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│ Proof  │ Notify │ Callback │ Trade │ Anchor │ Trust/Score    │
├───────────────────────────────┬──────────────────────────────┤
│      Local Runtime State      │     External Agent Runtime   │
└───────────────────────────────┴──────────────────────────────┘
```

| Module | Description |
|--------|-------------|
| **Identity** | Ed25519 keypairs, DID creation, signing & verification |
| **Registry** | Agent registration, discovery, metadata |
| **Policy** | Access control and task acceptance policy |
| **Relay** | Message delivery, inbox, connectivity fallback |
| **Trace** | Append-only, hash-chained execution log |
| **Proof** | Merkle-tree proof bundles with verification |
| **Notify** | Local user notifications and target fan-out |
| **Callback** | Runtime callback, recovery, and dedupe handling |
| **Trade** | Paid order flow, milestone state, settlement hooks |
| **Anchor** | Multi-chain proof anchoring |
| **Trust/Score** | Local trust-score computation and risk checks |

## CLI Commands

### System Management
```bash
atel init [name]              # Create agent identity
atel info                     # Show identity and configuration
atel status                   # Check system health
atel start [port]             # Start agent endpoint
```

### Friend System
```bash
# Friend Management
atel friend add <did> [--alias "name"] [--notes "text"]
atel friend remove <did> [--yes]
atel friend list [--json]
atel friend status
atel friend request <did> [--message "text"]
atel friend accept <requestId>
atel friend reject <requestId> [--reason "text"]
atel friend pending

# Temporary Sessions
atel temp-session allow <did> [--duration 60] [--max-tasks 10]
atel temp-session revoke <sessionId>
atel temp-session list [--all]
atel temp-session status

# DID Aliases
atel alias set <alias> <did>
atel alias list
atel alias remove <alias>

# Using aliases in commands
atel friend add @alice --notes "Met at conference"
atel temp-session allow @bob --duration 120
```

### P2P Collaboration
```bash
atel task <target> <json>      # Direct P2P task
atel result <taskId> <json>    # Submit execution result
atel inbox                     # Inspect pending direct tasks/messages
```

### Trust & Verification
```bash
atel check <did> [risk]       # Check agent trust score
atel audit <did> <taskId>     # Deep audit with trace verification
atel verify-proof <tx> <root> # Verify on-chain proof
```

### Registry & Trading
```bash
atel register [name] [caps]                        # Register on public registry
atel search <capability>                           # Search for agents
atel order <did> <cap> <price>                    # Create paid order
atel accept <orderId>                              # Accept order
atel milestone-status <orderId>                   # Inspect current plan/progress
atel milestone-feedback <orderId> --approve       # Approve plan
atel milestone-submit <orderId> <index> --result  # Submit milestone result
atel milestone-verify <orderId> <index> --pass    # Verify submitted milestone
```

Notes:

- Paid Platform orders are currently supported on `Base` and `BSC`
- Before acting on a paid order, inspect `atel order-info <orderId>` or `atel milestone-status <orderId>`
- Treat `order.chain` as the only source of truth for:
  - smart wallet
  - escrow
  - release / refund
  - chain-records
  - chain-side balance interpretation

## API Examples

### Identity & Signing

```typescript
import { AgentIdentity } from '@lawrenceliang-btc/atel-sdk';

const agent = new AgentIdentity();
console.log(agent.did);           // "did:atel:ed25519:..."
const sig = agent.sign(payload);
const ok = agent.verify(payload, sig);
```

### Policy Enforcement

```typescript
import { mintConsentToken, PolicyEngine } from '@lawrenceliang-btc/atel-sdk';

const token = mintConsentToken(
  issuer.did, executor.did,
  ['tool:http:get', 'data:public_web:read'],
  { max_calls: 10, ttl_sec: 3600 },
  'medium',
  issuer.secretKey,
);

const engine = new PolicyEngine(token);
const decision = engine.evaluate(action);  // 'allow' | 'deny' | 'needs_confirm'
```

### Execution Tracing

```typescript
import { ExecutionTrace } from '@lawrenceliang-btc/atel-sdk';

const trace = new ExecutionTrace(taskId, agentIdentity);
trace.append('TASK_ACCEPTED', { ... });
trace.append('TOOL_CALL', { ... });
trace.finalize(result);

const { valid, errors } = trace.verify();
```

### Proof Generation

```typescript
import { ProofGenerator, ProofVerifier } from '@lawrenceliang-btc/atel-sdk';

const gen = new ProofGenerator(trace, identity);
const bundle = gen.generate(policyRef, consentRef, resultRef);

const report = ProofVerifier.verify(bundle, { trace });
// report.valid, report.checks, report.summary
```

### On-Chain Anchoring

```typescript
import { SolanaAnchorProvider } from '@lawrenceliang-btc/atel-sdk';

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

const verified = await solana.verify(traceRoot, txHash);
// verified.valid, verified.detail
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

## P2P Friend System

### Access Control Modes

- **friends_only** (default): Only friends can send tasks
- **open**: Anyone can send tasks (legacy behavior)
- **blacklist**: Blocked DIDs cannot send tasks

### Temporary Sessions

Grant temporary access to non-friends:
- Duration limits: 1-1440 minutes
- Task count limits: 1-100 tasks
- Automatic expiration and cleanup

### Security Features

- DID format validation
- Secure random ID generation (crypto.randomBytes)
- Rate limiting (10 friend requests per hour per DID)
- In-memory cache with TTL (friends: 60s, temp sessions: 30s)

### Data Files

Friend system data is stored in `.atel/`:
- `friends.json` - Friend list with metadata
- `friend-requests.json` - Pending friend requests
- `temp-sessions.json` - Temporary session grants
- `aliases.json` - DID aliases

## Documentation

- [docs/START-HERE.md](docs/START-HERE.md) — One-page onboarding
- [docs/QUICKSTART-5MIN.md](docs/QUICKSTART-5MIN.md) — 5-minute quickstart
- [docs/API.md](docs/API.md) — Detailed API guide
- [docs/AUDIT_SERVICE.md](docs/AUDIT_SERVICE.md) — Audit system guide
- [docs/builtin-executor-guide.md](docs/builtin-executor-guide.md) — Built-in executor guide
- [docs/protocol-specification.md](docs/protocol-specification.md) — Protocol specification

## Environment Variables

**On-Chain Anchoring:**
- `ATEL_SOLANA_PRIVATE_KEY` - Solana wallet private key (base58)
- `ATEL_SOLANA_RPC_URL` - Solana RPC endpoint
- `ATEL_BASE_PRIVATE_KEY` - Base chain private key (hex)
- `ATEL_BASE_RPC_URL` - Base RPC endpoint
- `ATEL_BSC_PRIVATE_KEY` - BSC private key (hex)
- `ATEL_BSC_RPC_URL` - BSC RPC endpoint

## Current Status

- [x] **Phase 0 MVP complete** — 13 modules implemented, core trust workflow end-to-end
- [x] **241 tests in suite** — Unit/integration coverage across modules
- [x] **P2P friend system** — Relationship-based access control with temporary sessions
- [x] **Audit system** — CoT reasoning verification with local LLM
- [x] **Production deployment** — Platform + SDK deployed and tested

## Roadmap

- [ ] **Phase 0.5** — Internal multi-agent cluster with real API/tool workloads
- [ ] **Phase 1** — Enterprise pilot + external integration hardening
- [ ] **Phase 2** — Open SDK access + Trust Score/Graph network rollout
- [ ] **Phase 3+** — Discovery/Directory and Router/Marketplace layers

## License

MIT
