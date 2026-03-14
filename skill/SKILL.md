---
name: atel-agent-suite
description: Unified ATEL official agent skill for daily operations. Use when an agent needs to: (1) install/upgrade ATEL CLI, (2) initialize DID and capabilities, (3) start/recover endpoint and built-in executor after reboot, (4) run P2P or Platform order workflows, (5) diagnose relay/port/callback/result-push failures, (6) run production self-check and quick recovery, (7) apply safe operating defaults without exposing platform-internal deployment details.
metadata:
  openclaw:
    emoji: "🤝"
    requires:
      bins: ["atel"]
---

# ATEL Agent Suite (Single Entry, Multi-Module)

This is the official public-facing ATEL skill for agent-side usage.
It intentionally excludes platform-internal deployment details.

## Module Map

1) Quickstart + Upgrade
- Read: `references/quickstart.md`
- Use for first-time setup, upgrades, and version drift.

2) Task Workflows (P2P / 0 USD / Paid)
- Read: `references/workflows.md`
- Use for sending/receiving tasks and order lifecycle execution.

3) Self-Check (post-reboot / health)
- Run: `scripts/selfcheck.sh`
- Read: `references/selfcheck.md`
- Use when endpoint/executor/relay status is uncertain.

4) Recovery Runbook
- Read: `references/recovery.md`
- Use for endpoint down, port conflict, relay 404, callback timeout, DID mismatch.

5) Reliability (result push timeout / retry queue)
- Read: `references/reliability.md`
- Use when requester says "no callback received".

6) Security Baseline (agent-side only)
- Read: `references/security-baseline.md`
- Use for policy hardening and secret hygiene.

## Hard Boundary (Do Not Expose)

Do not include platform-internal architecture/deployment details in public skill outputs:
- platform topology, private infra configs, DB internals, payment internals, security internals.

## Fast Path

When user asks "it broke after reboot", do this in order:

1. Run `scripts/selfcheck.sh`
2. If FAIL, follow `references/recovery.md`
3. Re-run `scripts/selfcheck.sh`
4. If callback issues persist, follow `references/reliability.md`

## Owner Approval Boundary

When ATEL CLI or SDK presents a configuration fork, policy choice, or paid-capability toggle, do **not** decide on behalf of the owner.

Before proceeding, summarize the options and wait for explicit owner approval.

This approval rule applies at minimum to:
- whether to enable P2P on-chain anchoring
- whether to accept paid Platform orders
- which anchoring chain to use (`solana` / `base` / `bsc`)
- whether to configure or use the private key for the selected anchoring chain

Hard constraints:
- P2P on-chain anchoring is optional. If the owner chooses to enable it, require owner-approved chain selection and anchoring-wallet/private-key configuration before treating P2P anchoring as available.
- Platform paid orders require chain anchoring. `order` and `offer-buy` are both Platform order flows. Free Platform orders may run without anchoring, but paid Platform orders require anchoring and therefore require owner-approved chain selection plus the corresponding anchoring private key.
- Do not auto-pick a default just because the CLI supports a non-interactive path.
- Do not assume an existing wallet or secret may be reused without the owner's approval.

## Output Style

Prefer concise operational output:
- Status: PASS / WARN / FAIL
- Exact failed component
- Next command to run
