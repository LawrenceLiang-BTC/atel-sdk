# Security & Trust Model

## Security Policy

`atel init` creates `.atel/policy.json`:

```json
{
  "rateLimit": 60,
  "maxPayloadBytes": 1048576,
  "maxConcurrent": 10,
  "allowedDIDs": [],
  "blockedDIDs": [],
  "taskMode": "auto",
  "autoAcceptPlatform": true,
  "autoAcceptP2P": true,
  "trustPolicy": {
    "minScore": 0,
    "newAgentPolicy": "allow_low_risk",
    "riskThresholds": { "low": 0, "medium": 50, "high": 75, "critical": 90 }
  }
}
```

- `allowedDIDs`: Whitelist (empty = allow all)
- `blockedDIDs`: Blacklist (checked first)
- `taskMode`: `auto` (execute immediately) | `confirm` (queue for approval) | `off` (reject all tasks)
- `autoAcceptPlatform`: Auto-accept Platform orders (only applies when taskMode is `auto`)
- `autoAcceptP2P`: Auto-execute P2P tasks (only applies when taskMode is `auto`)
- `newAgentPolicy`: `allow_all` | `allow_low_risk` (default) | `deny`

## Incoming Task Security Pipeline

1. Nonce anti-replay (duplicate nonce rejected)
2. Content security audit (SQL/NoSQL injection, path traversal, command injection)
3. Policy check (DID blacklist/whitelist, rate limit, payload size, concurrency)
4. Capability boundary check (action within registered capabilities?)
5. Trust check (sender score vs risk threshold)

Rejections generate a local Trace + Proof returned to sender for verification.

## Trust Score Formula (0-100)

Four components:

| Component | Formula | Max | Description |
|-----------|---------|-----|-------------|
| Success Rate | `successRate * 60` | 60 | Core metric — task completion reliability |
| Task Volume | `min(totalTasks / 100, 1) * 15` | 15 | More tasks = more data = more confidence |
| Risk Bonus | `(highRiskSuccesses / total) * 15` | 15 | Successfully handling high/critical risk tasks |
| Consistency | `(1 - violationRate) * 10` | 10 | Low policy violations = reliable behavior |

Additional modifiers:
- **Verification penalty**: If < 50% of proofs are on-chain verified (and total > 5 tasks), score is multiplied by 0.8 (20% penalty)
- Without on-chain verified proofs, an agent's effective score is capped at ~80% of its raw score

## Risk Thresholds (Policy-Based Access Control)

Default thresholds in `.atel/policy.json`:

| Risk Level | Min Trust Score | Use Case |
|------------|----------------|----------|
| low | 0 | Basic queries, public info |
| medium | 50 | Standard tasks |
| high | 75 | Sensitive operations |
| critical | 90 | Financial, destructive actions |

Agents below the threshold for a given risk level are rejected. Chain-verified proofs are essential for reaching high trust scores.

## Dual Trust Assessment

```bash
# Local-only (default, uses .atel/trust-history.json)
atel check <did> medium

# Chain-verified (queries Solana/Base/BSC RPC)
atel check <did> medium --chain
```

## Risk-Based Task Control

```bash
# Specify risk level in payload
atel task "did:atel:xxx" '{"action":"payment","amount":100,"_risk":"critical"}'

# Force send, bypassing trust check
atel task "did:atel:xxx" '{"action":"payment","_risk":"critical","_force":true}'
```

## Key Rotation

```bash
atel rotate
```

Generates new keypair, backs up old identity, produces dual-signed rotation proof, anchors on-chain, updates Registry.
