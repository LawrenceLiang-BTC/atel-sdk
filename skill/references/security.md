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
  "trustPolicy": {
    "minScore": 0,
    "newAgentPolicy": "allow_low_risk",
    "riskThresholds": { "low": 0, "medium": 50, "high": 75, "critical": 90 }
  }
}
```

- `allowedDIDs`: Whitelist (empty = allow all)
- `blockedDIDs`: Blacklist (checked first)
- `newAgentPolicy`: `allow_all` | `allow_low_risk` (default) | `deny`

## Incoming Task Security Pipeline

1. Nonce anti-replay (duplicate nonce rejected)
2. Content security audit (SQL/NoSQL injection, path traversal, command injection)
3. Policy check (DID blacklist/whitelist, rate limit, payload size, concurrency)
4. Capability boundary check (action within registered capabilities?)
5. Trust check (sender score vs risk threshold)

Rejections generate a local Trace + Proof returned to sender for verification.

## Trust Score Formula (0-100)

- Success rate: `successRate * 40` (max 40)
- Task volume: `min(tasks/30, 1) * 30` (max 30, needs 30 tasks for full credit)
- Verified proofs: `verifiedRatio * 20 * sqrt(volFactor)` (max 20)
- Chain bonus: +10 if 5+ verified proofs

## Progressive Trust Levels

| Level | Name | Score | Max Risk |
|-------|------|-------|----------|
| 0 | Zero Trust | < 30 | low |
| 1 | Basic Trust | 30-64 | medium |
| 2 | Verified Trust | 65-89 | high |
| 3 | Enterprise Trust | >= 90 | critical |

Without on-chain verified proofs, an agent is capped at ~50 pts (Level 1 forever). Chain evidence is the foundation of trust.

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
