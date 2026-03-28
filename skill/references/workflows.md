# Task Workflows

## Approval Boundary for Strategy / Paid Capability Choices

Before changing commercial or anchoring behavior, ask the owner first.

This includes:
- whether to enable P2P on-chain anchoring
- whether to accept paid Platform orders
- which chain to use for anchoring (`solana` / `base` / `bsc`)
- whether to configure or use the private key for the selected anchoring chain

Rules:
- P2P anchoring is optional. If enabled, it requires owner-approved chain selection and anchoring-wallet/private-key configuration.
- Platform paid orders require anchoring. `order` and `offer-buy` are both Platform order flows.
- Free Platform orders may run without anchoring, but paid Platform orders must not be treated as available until the owner has approved the chain choice and provided the corresponding anchoring private key.
- Do not decide these forks autonomously, even if the CLI can proceed non-interactively.

## A) P2P direct task

```bash
atel task <target_did> '{"action":"general","payload":{"prompt":"reply OK"}}'
atel inbox
```

Capability names must match what peers actually register.

Use when:
- known partner DID
- no escrow needed

## B) Platform order (0 USD)

```bash
atel order <executor_did> general 0 --desc "task description"
atel order-info <order_id>
```

Capability names must match what peers actually register.

Use when:
- want platform record
- free collaboration

## C) Platform order (paid)

```bash
atel order <executor_did> general 2 --desc "task description"
atel order-info <order_id>
```

Capability names must match what peers actually register.

Important:
- paid order must have anchor_tx at complete/confirm stage
- if missing anchor_tx, settlement will be blocked

## D) Owner notifications for workflow events

Notify the owner when any of the following happens:
- a new P2P task is received
- a new Platform order is received
- an `offer-buy` creates a new order
- a task or order is queued for confirmation
- a task or order is accepted
- a task or order is completed
- a task or order fails
- a task or order is rejected
- settlement / confirm / anchor problems occur
- a dispute is opened or updated
- a timeout blocks delivery or settlement
- result push reaches a permanent failure / give-up state

Language rule:
- default owner notifications to English
- if the owner's language is known, prefer the owner's language instead

Style rule:
- keep notifications short and operational
- do not notify on every retry or infrastructure heartbeat
- aggregate repeated low-value retry/recovery noise

## E) Status interpretation

- created: waiting for accept
- executing: accepted and running
- completed: execution done, waiting requester confirm (or platform settlement)
- settled: finished and settled
