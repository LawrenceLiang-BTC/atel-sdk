# ATEL Protocol Specification

**Agent Trust & Exchange Layer — Protocol Specification v1.0**

| Field | Value |
|-------|-------|
| Status | Draft |
| Version | 1.0 |
| Date | 2026-02-15 |
| Authors | ATEL Protocol Team |
| License | Apache 2.0 |

---

## Abstract

This document specifies the Agent Trust & Exchange Layer (ATEL) protocol, a
trust infrastructure for autonomous AI agent collaboration. ATEL provides
decentralized identity, authenticated messaging, mutual handshake with
end-to-end encryption, verifiable task execution with cryptographic proofs,
multi-chain on-chain anchoring, and a progressive trust assessment system.

ATEL is designed to complement existing agent communication protocols (such as
Google A2A and ANP) by adding the missing trust layer — enabling agents to
verify each other's identity, audit execution history, and make risk-based
collaboration decisions backed by on-chain evidence.

This specification defines the wire formats, algorithms, message types,
security requirements, and error handling for all ATEL protocol components.

---

## Table of Contents

- [Abstract](#abstract)
- [1. Introduction](#1-introduction)
- [2. DID Identity](#2-did-identity)
- [3. Message Envelope](#3-message-envelope)
- [4. Handshake Protocol](#4-handshake-protocol)
- [5. Connection Establishment](#5-connection-establishment)
- [6. Task Protocol](#6-task-protocol)
- [7. Trust Assessment](#7-trust-assessment)
- [8. On-Chain Anchoring](#8-on-chain-anchoring)
- [9. Proof System](#9-proof-system)
- [10. Security](#10-security)
- [11. Registry Protocol](#11-registry-protocol)
- [12. Relay Protocol](#12-relay-protocol)
- [13. SKILL Protocol](#13-skill-protocol)
- [14. Commercial Transaction Protocol](#14-commercial-transaction-protocol)
- [15. Security Considerations](#15-security-considerations)
- [Appendix A: Data Types](#appendix-a-data-types)
- [Appendix B: Example Flows](#appendix-b-example-flows)

---

## 1. Introduction

### 1.1 Purpose

ATEL (Agent Trust & Exchange Layer) is a protocol that enables autonomous AI
agents to establish trust, exchange verifiable proofs of execution, and make
risk-based collaboration decisions. It operates as a trust layer above
transport, complementing communication protocols like A2A and ANP.

### 1.2 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119).

| Term | Definition |
|------|-----------|
| Agent | An autonomous software entity with a cryptographic identity |
| DID | Decentralized Identifier — a self-sovereign, globally unique identifier |
| Envelope | The standard signed message wrapper for all ATEL messages |
| Handshake | Three-step mutual authentication and key exchange protocol |
| Trace | An append-only, hash-chained log of execution events |
| Proof Bundle | A Merkle-tree-based cryptographic attestation of execution |
| Anchor | An on-chain record linking a proof hash to a blockchain transaction |
| Trust Score | A numeric assessment (0–100) of an agent's reliability |
| Trust Level | A categorical classification (L0–L3) derived from Trust Score |
| Session | An authenticated, optionally encrypted channel between two agents |
| Candidate | A network address (with type and priority) where an agent is reachable |
| Registry | A discovery service (yellow pages) for agent lookup |
| Relay | A message forwarding service for NAT-blocked agents |
| Executor | The agent's task processing backend |
| Consent Token | A scoped authorization from requester to executor |

### 1.3 Design Goals

1. **Decentralized Identity**: Agents generate their own key pairs; no central authority required.
2. **Verifiable Execution**: Every task execution produces a tamper-evident trace and cryptographic proof.
3. **Progressive Trust**: Trust is earned through verified collaboration history, not self-declared.
4. **Chain-Agnostic Anchoring**: Proofs can be anchored on multiple blockchains (Solana, Base, BSC).
5. **End-to-End Encryption**: All inter-agent communication can be encrypted after handshake.
6. **Minimal Overhead**: Protocol messages are compact JSON; on-chain data is hash-only.
7. **Incremental Adoption**: Each protocol component can be adopted independently.

### 1.4 Protocol Stack Overview

```
┌─────────────────────────────────────────────────┐
│  Application Layer                              │
│  Task Protocol · SKILL Protocol · Trust Query   │
├─────────────────────────────────────────────────┤
│  Session Layer                                  │
│  Handshake · E2E Encryption · Session Mgmt      │
├─────────────────────────────────────────────────┤
│  Message Layer                                  │
│  Envelope (atel.msg.v1) · Signing · Nonce       │
├─────────────────────────────────────────────────┤
│  Identity Layer                                 │
│  DID (did:atel:ed25519:*) · Key Rotation        │
├─────────────────────────────────────────────────┤
│  Verification Layer                             │
│  Trace · Proof · Merkle Tree · On-Chain Anchor  │
├─────────────────────────────────────────────────┤
│  Transport Layer                                │
│  HTTP/HTTPS · Relay · Candidate Resolution      │
└─────────────────────────────────────────────────┘
```

---

## 2. DID Identity

### 2.1 DID Format

Every ATEL agent MUST possess a Decentralized Identifier (DID). The DID format is:

```
did:atel:ed25519:<base58(public_key)>
```

Where:
- `did` — fixed scheme prefix
- `atel` — method identifier for the ATEL protocol
- `ed25519` — key type identifier
- `<base58(public_key)>` — Base58-encoded 32-byte Ed25519 public key

Example:
```
did:atel:ed25519:GCjHvt6FRCBVGAX6DVdXrGyZtVXjD5vzV7rC7Q1jbL2x
```

A legacy format `did:atel:<base58>` (without the `ed25519` segment) MUST also
be accepted by parsers for backward compatibility.

### 2.2 Key Generation

Agents MUST use the Ed25519 signature scheme (as defined in [RFC 8032](https://tools.ietf.org/html/rfc8032)).

- **Public key**: 32 bytes
- **Secret key**: 64 bytes (seed + public key, per NaCl convention)
- **Implementation**: `tweetnacl.sign.keyPair()`

The agent_id is a UUID v4 generated at identity creation time. It is an
internal identifier and MUST NOT be used for authentication; only the DID
(derived from the public key) is authoritative.

### 2.3 Deterministic Serialization

All objects to be signed MUST be serialized using deterministic JSON: keys are
sorted lexicographically at every nesting level, arrays preserve order.

```
function serializePayload(obj):
  if obj is null/undefined → JSON.stringify(obj)
  if obj is not object    → JSON.stringify(obj)
  if obj is array         → "[" + map(serializePayload) + "]"
  if obj is object        → sort keys → "{" + pairs + "}"
```

### 2.4 Signing and Verification

**Signing**:
1. Serialize the payload using deterministic JSON.
2. Encode the resulting string as UTF-8 bytes.
3. Compute an Ed25519 detached signature using the agent's 64-byte secret key.
4. Encode the 64-byte signature as Base64.

**Verification**:
1. Serialize the payload using the same deterministic JSON.
2. Encode as UTF-8 bytes.
3. Decode the Base64 signature to 64 bytes.
4. Verify using `nacl.sign.detached.verify(message, signature, publicKey)`.

### 2.5 Key Rotation

An agent MAY rotate its key pair without changing its agent_id. Key rotation
produces a `KeyRotationProof`:

```json
{
  "oldDid": "did:atel:ed25519:<old_base58>",
  "newDid": "did:atel:ed25519:<new_base58>",
  "newPublicKey": "<base64(new_public_key)>",
  "timestamp": "<ISO 8601>",
  "oldSignature": "<base64(sig_by_old_key)>",
  "newSignature": "<base64(sig_by_new_key)>"
}
```

**Requirements**:
- The rotation data (`{oldDid, newDid, newPublicKey, timestamp}`) MUST be
  signed by BOTH the old and new secret keys.
- Verifiers MUST check both signatures to confirm the rotation was authorized.
- The rotation proof SHOULD be anchored on-chain for timestamping.
- The rotation proof MUST be submitted to the Registry to update the agent's
  public key binding.

---

## 3. Message Envelope

### 3.1 Envelope Format

All ATEL inter-agent messages MUST use the `atel.msg.v1` envelope format:

```json
{
  "envelope": "atel.msg.v1",
  "type": "<MessageType>",
  "from": "<sender_DID>",
  "to": "<receiver_DID>",
  "timestamp": "<ISO 8601>",
  "nonce": "<UUID v4>",
  "payload": { ... },
  "signature": "<base64(Ed25519_detached_sig)>"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `envelope` | string | REQUIRED | Fixed value `"atel.msg.v1"` |
| `type` | MessageType | REQUIRED | Message type identifier |
| `from` | string | REQUIRED | Sender's DID |
| `to` | string | REQUIRED | Receiver's DID |
| `timestamp` | string | REQUIRED | ISO 8601 creation time |
| `nonce` | string | REQUIRED | UUID v4, unique per message |
| `payload` | object | REQUIRED | Type-specific payload |
| `signature` | string | REQUIRED | Ed25519 signature over all fields except `signature` |

### 3.2 Message Types

The following message types are defined:

| Type | Direction | Description |
|------|-----------|-------------|
| `handshake_init` | A → B | Initiate mutual authentication |
| `handshake_ack` | B → A | Acknowledge with challenge response |
| `handshake_confirm` | A → B | Complete handshake |
| `task_delegate` | A → B | Delegate a task for execution |
| `proof_response` | B → A | Return execution proof |
| `trust_query` | A → B | Query trust information |
| `trust_response` | B → A | Return trust data |
| `capability_query` | A → B | Query capabilities |
| `capability_response` | B → A | Return capability declaration |
| `error` | any | Error response |

### 3.3 Signature Computation

The signature is computed over the deterministic JSON serialization of all
envelope fields EXCEPT the `signature` field itself:

```
signable = serializePayload({envelope, type, from, to, timestamp, nonce, payload})
signature = base64(Ed25519_sign(utf8(signable), secretKey))
```

### 3.4 Verification Procedure

Receivers MUST perform the following checks in order:

1. **Envelope version**: `envelope` MUST equal `"atel.msg.v1"`.
2. **Required fields**: `from`, `to`, `type`, `nonce` MUST be present.
3. **Timestamp freshness**: `timestamp` MUST be within 5 minutes of current
   time (configurable via `maxAgeMs`). Messages with future timestamps
   (> 30 seconds ahead) MUST be rejected.
4. **Nonce uniqueness**: The `nonce` MUST NOT have been seen before within the
   replay window (default: 10 minutes).
5. **Signature validity**: The signature MUST verify against the sender's
   Ed25519 public key (resolved from DID or session).

If any check fails, the message MUST be rejected with an appropriate error.

### 3.5 Encrypted Payloads

After a handshake establishes an encryption session, the `payload` field MAY
contain an encrypted payload instead of plaintext:

```json
{
  "enc": "atel.enc.v1",
  "ciphertext": "<base64(encrypted_data)>",
  "nonce": "<base64(24_byte_nonce)>",
  "ephemeralPubKey": "<base64(X25519_public_key)>"
}
```

The receiver MUST detect encrypted payloads by checking for `payload.enc === "atel.enc.v1"` and decrypt before processing.

### 3.6 Nonce Tracking

Implementations MUST maintain a nonce tracker to prevent replay attacks:

- Store each seen nonce with its timestamp.
- Reject any message whose nonce has been seen before.
- Evict nonces older than `2 × MAX_MESSAGE_AGE_MS` (default: 10 minutes).
- The tracker SHOULD be bounded in memory (e.g., LRU eviction).

---

## 4. Handshake Protocol

### 4.1 Overview

The ATEL handshake is a three-step mutual authentication protocol that
establishes identity verification and (optionally) end-to-end encryption
between two agents.

```
Agent A (Initiator)                    Agent B (Responder)
       │                                      │
       │──── handshake_init ─────────────────▶│
       │     {did_a, pubkey_a, enc_pk_a,      │
       │      challenge_a, wallets_a?}        │
       │                                      │
       │◀─── handshake_ack ──────────────────│
       │     {did_b, pubkey_b, enc_pk_b,      │
       │      challenge_b, sign(challenge_a),  │
       │      wallets_b?}                     │
       │                                      │
       │──── handshake_confirm ──────────────▶│
       │     {sign(challenge_b)}              │
       │                                      │
       ▼  ✅ Session established              ▼
```

### 4.2 Step 1: handshake_init

The initiator sends a `handshake_init` message:

**Payload** (`HandshakeInitPayload`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `did` | string | REQUIRED | Initiator's DID |
| `publicKey` | string | REQUIRED | Ed25519 public key (base64) |
| `encPublicKey` | string | REQUIRED | Ephemeral X25519 public key (base64) |
| `challenge` | string | REQUIRED | Random hex string (default 32 bytes = 64 hex chars) |
| `capabilities` | string[] | OPTIONAL | Initiator's capability types |
| `wallets` | object | OPTIONAL | Wallet addresses `{solana?, base?, bsc?}` |
| `walletBundle` | object | OPTIONAL | DID-signed wallet proof (v0.8.3+) |

The `walletBundle` object contains:
- `addresses`: `{solana?, base?, bsc?}` — wallet addresses
- `proof`: Ed25519 signature of canonical JSON of `addresses`, signed with DID secret key

**Requirements**:
- The `publicKey` MUST match the public key embedded in the `did`.
- The `encPublicKey` MUST be a freshly generated X25519 key pair (ephemeral).
- The `challenge` MUST be cryptographically random.

### 4.3 Step 2: handshake_ack

The responder verifies the init message and responds:

**Verification**:
1. Verify the envelope signature against the sender's public key.
2. Parse the DID and confirm it matches the provided `publicKey`.
3. If verification fails, respond with an error.

**Payload** (`HandshakeAckPayload`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `did` | string | REQUIRED | Responder's DID |
| `publicKey` | string | REQUIRED | Ed25519 public key (base64) |
| `encPublicKey` | string | REQUIRED | Ephemeral X25519 public key (base64) |
| `challenge` | string | REQUIRED | Responder's random challenge |
| `challengeResponse` | string | REQUIRED | `Ed25519_sign(initiator_challenge, responder_sk)` |
| `capabilities` | string[] | OPTIONAL | Responder's capability types |
| `wallets` | object | OPTIONAL | Wallet addresses `{solana?, base?, bsc?}` |
| `walletBundle` | object | OPTIONAL | DID-signed wallet proof (v0.8.3+) |

**Requirements**:
- The `challengeResponse` MUST be the Ed25519 signature of the initiator's
  challenge string, signed with the responder's identity secret key.
- The responder MUST generate its own ephemeral X25519 key pair.
- The responder MUST derive the shared encryption key at this point:
  `sharedKey = KDF(X25519_DH(responder_enc_sk, initiator_enc_pk))`

### 4.4 Step 3: handshake_confirm

The initiator verifies the ack and completes the handshake:

**Verification**:
1. Verify the ack envelope signature.
2. Verify the `challengeResponse` against the responder's public key.
3. If verification fails, abort the handshake.

**Payload** (`HandshakeConfirmPayload`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `challengeResponse` | string | REQUIRED | `Ed25519_sign(responder_challenge, initiator_sk)` |

### 4.5 Key Derivation Function (KDF)

The shared encryption key is derived using X25519 Diffie-Hellman followed by
SHA-256 key derivation:

```
raw_shared = X25519_DH(local_enc_sk, remote_enc_pk)
shared_key = SHA256("atel-session-key-v1" || raw_shared)
```

- The context string `"atel-session-key-v1"` MUST be prepended.
- The resulting `shared_key` is 32 bytes.
- Encryption uses XSalsa20-Poly1305 (NaCl `secretbox`).

### 4.6 Session Object

Upon successful handshake, both parties create a Session:

```json
{
  "sessionId": "<UUID v4>",
  "localDid": "<local_DID>",
  "remoteDid": "<remote_DID>",
  "remotePublicKey": "<32 bytes>",
  "encrypted": true,
  "remoteCapabilities": ["translation", "coding"],
  "remoteWallets": {"solana": "<address>", "base": "<address>"},
  "createdAt": "<ISO 8601>",
  "expiresAt": "<ISO 8601>",
  "state": "active"
}
```

- Default session TTL: 3600 seconds (1 hour).
- Expired sessions MUST be cleaned up; encryption keys MUST be zeroed.
- Sessions are keyed by `remoteDid` — one session per remote agent.

### 4.7 Encryption and Decryption

**Encryption** (XSalsa20-Poly1305):
1. Generate a random 24-byte nonce.
2. Encrypt: `ciphertext = secretbox(utf8(plaintext), nonce, sharedKey)`.
3. Return `{enc: "atel.enc.v1", ciphertext: base64(ct), nonce: base64(nonce)}`.

**Decryption**:
1. Verify `enc === "atel.enc.v1"`.
2. Decode ciphertext and nonce from base64.
3. Decrypt: `plaintext = secretbox.open(ciphertext, nonce, sharedKey)`.
4. If decryption fails, throw `CryptoError`.

### 4.8 Wallet Exchange & DID-Signed Verification

During handshake, agents MAY exchange wallet addresses for on-chain trust
verification. Starting from v0.8.3, wallet addresses are accompanied by a
DID signature proving ownership.

**Supported chains:**

| Field | Format | Example |
|-------|--------|---------|
| `solana` | Base58 public key | `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` |
| `base` | Hex EVM address | `0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18` |
| `bsc` | Hex EVM address | `0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18` |

**WalletBundle format:**

```json
{
  "addresses": { "solana": "<addr>", "base": "<addr>" },
  "proof": "<base64_ed25519_signature>"
}
```

**Signing process:**
1. Collect non-empty wallet addresses into a clean object.
2. Serialize using canonical JSON (sorted keys).
3. Sign with DID Ed25519 secret key: `proof = Ed25519_sign(canonical_json, sk)`.

**Verification process:**
1. Extract `walletBundle` from handshake message.
2. Reconstruct canonical JSON from `addresses`.
3. Verify: `Ed25519_verify(canonical_json, proof, remote_public_key)`.
4. If valid: `session.remoteWalletsVerified = true`.

**Security properties:**
- Wallet-DID binding is cryptographically unforgeable.
- Even if Registry is compromised, wallet ownership proofs remain valid.
- On-chain queries use public RPCs, no centralized dependency.

Wallet addresses enable the verifier to query on-chain anchor transactions
directly, without relying on the agent's self-reported data.

---

## 5. Connection Establishment

### 5.1 Candidate Address System

Each agent advertises a set of connection candidates, ordered by priority.
Candidates represent different network paths to reach the agent.

**Candidate Types**:

| Type | Priority | Description |
|------|----------|-------------|
| `local` | 100 | LAN IP address (same network, lowest latency) |
| `upnp` | 80 | Public IP with UPnP port mapping (auto-configured) |
| `direct` | 50 | Public IP (may require manual port forwarding) |
| `relay` | 10 | Relay server (always works, encrypted passthrough) |

**Candidate Format**:

```json
{
  "type": "local | direct | upnp | relay",
  "url": "http://<ip>:<port>",
  "priority": 100
}
```

### 5.2 Candidate Collection

During agent startup (`atel start`), the following steps are performed
automatically:

1. **Local IP Discovery**: Enumerate all non-internal IPv4 addresses from
   network interfaces. Each becomes a `local` candidate.
2. **Public IP Discovery**: Query external services (`api.ipify.org`,
   `ifconfig.me`, `icanhazip.com`) with 5-second timeout. First valid
   IPv4 response is used.
3. **UPnP Port Mapping**: Attempt NAT-PMP/UPnP port mapping with 5-second
   timeout and 7200-second TTL. If successful, create a `upnp` candidate.
   If failed, create a `direct` candidate (unverified).
4. **Relay Fallback**: Always add the relay server as a fallback candidate.
   Default relay: `http://47.251.8.19:9000`.

### 5.3 Connection Resolution

When Agent A wants to reach Agent B:

1. Fetch B's candidate list from the Registry.
2. Sort candidates by priority (descending).
3. **Phase 1 — Direct candidates**: For each non-relay candidate, perform a
   health check (`GET /atel/v1/health`, 3-second timeout). Use the first
   reachable candidate.
4. **Phase 2 — Relay fallback**: If no direct candidate is reachable, verify
   the relay server is up (`GET /relay/v1/health`). If available, use the
   relay send URL: `<relay>/relay/v1/send/<encoded_did>`.

**Health Check Response**:

```json
{
  "status": "ok",
  "did": "<agent_DID>",
  "timestamp": "<ISO 8601>",
  "activeSessions": 3,
  "tls": false,
  "encryption": true
}
```

### 5.4 NAT Traversal

ATEL uses a pragmatic approach to NAT traversal:

- **UPnP/NAT-PMP**: Automatic port mapping for home/office routers.
- **Direct**: Works when the port is already forwarded or the host has a
  public IP.
- **Relay**: Universal fallback that works through any NAT/firewall
  configuration. The relay forwards encrypted messages without inspecting
  content.

ATEL does NOT implement STUN/TURN/ICE. The relay-based fallback provides
equivalent connectivity with simpler implementation.

---

## 6. Task Protocol

### 6.1 Task Schema (task.v0.1)

A task represents a unit of work delegated from one agent to another.

```json
{
  "task_id": "<UUID v4>",
  "version": "task.v0.1",
  "issuer": "<issuer_DID>",
  "audience": ["<executor_DID>"],
  "intent": {
    "type": "<capability_type>",
    "goal": "<human-readable goal>",
    "constraints": { ... }
  },
  "risk": {
    "level": "low | medium | high | critical",
    "requires_human_confirm": false
  },
  "economics": {
    "max_cost": 0.01,
    "currency": "USD",
    "settlement": "offchain | onchain | credit"
  },
  "deadline": "<ISO 8601>",
  "context_refs": [
    {"type": "<ref_type>", "ref": "<reference>"}
  ],
  "nonce": "<UUID v4>",
  "signature": {
    "alg": "ed25519",
    "sig": "<base64>"
  }
}
```

**Field Definitions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task_id` | string | REQUIRED | UUID v4, globally unique |
| `version` | string | REQUIRED | Fixed `"task.v0.1"` |
| `issuer` | string | REQUIRED | Issuer's DID |
| `audience` | string[] | OPTIONAL | Target executor DID(s) |
| `intent.type` | string | REQUIRED | Capability type (e.g., `"translation"`) |
| `intent.goal` | string | REQUIRED | Human-readable description |
| `intent.constraints` | object | OPTIONAL | Type-specific constraints |
| `risk.level` | RiskLevel | REQUIRED | One of: `low`, `medium`, `high`, `critical` |
| `risk.requires_human_confirm` | boolean | OPTIONAL | Whether human approval is needed |
| `economics.max_cost` | number | OPTIONAL | Maximum cost in specified currency |
| `economics.currency` | string | OPTIONAL | ISO 4217 currency code |
| `economics.settlement` | Settlement | OPTIONAL | Settlement method |
| `deadline` | string | OPTIONAL | ISO 8601 deadline |
| `context_refs` | array | OPTIONAL | External references |
| `nonce` | string | REQUIRED | UUID v4 for replay protection |
| `signature` | object | OPTIONAL | Ed25519 signature over the task |

### 6.2 Capability Schema (cap.v0.1)

Agents declare their capabilities using the Capability schema:

```json
{
  "cap_id": "<UUID v4>",
  "version": "cap.v0.1",
  "provider": "<provider_DID>",
  "capabilities": [
    {
      "type": "translation",
      "description": "Translate text between languages",
      "input_schema": { ... },
      "output_schema": { ... },
      "constraints": {
        "max_risk_level": "medium",
        "supported_settlements": ["offchain"],
        "max_cost": 1.0,
        "currency": "USD"
      }
    }
  ],
  "endpoint": "http://host:port",
  "signature": {
    "alg": "ed25519",
    "sig": "<base64>"
  }
}
```

### 6.3 Task-Capability Matching

When matching a task to a capability, the following checks are performed in
order:

1. **Type match**: `task.intent.type` MUST equal `capability.type`.
2. **Risk level**: If the capability defines `max_risk_level`, the task's risk
   level MUST NOT exceed it. Risk ordering: `low < medium < high < critical`.
3. **Settlement**: If the task specifies a settlement method, it MUST be in the
   capability's `supported_settlements` list.
4. **Cost**: If both task and capability define `max_cost`, the task's cost
   MUST NOT exceed the capability's limit.

A task matches if at least one capability entry passes all checks.

### 6.4 Task Lifecycle

```
Sender                              Receiver
  │                                    │
  │── task_delegate ──────────────────▶│
  │   (ATELMessage with Task payload)  │
  │                                    │
  │◀── {status: "accepted", taskId} ──│  (immediate HTTP response)
  │                                    │
  │         [async execution]          │
  │                                    │
  │◀── proof_response ────────────────│  (via endpoint or relay)
  │   {taskId, result, proof, anchor}  │
  │                                    │
```

### 6.5 Task Execution Pipeline

On the receiver side, incoming tasks pass through a security pipeline:

1. **Nonce anti-replay**: Reject duplicate nonces.
2. **Content security audit**: Detect SQL/NoSQL injection, path traversal,
   command injection, credential access patterns.
3. **Security policy check**: DID blacklist/whitelist, rate limit, payload
   size, concurrency limit.
4. **Capability boundary check**: Verify the requested action is within
   registered capabilities.
5. **Trust check**: Verify the sender meets trust thresholds for the
   requested risk level.
6. **Accept**: Return `{status: "accepted", taskId}` immediately.
7. **Forward to executor**: POST task to `ATEL_EXECUTOR_URL`.
8. **Execute**: Executor processes and calls back with result.
9. **Generate Trace + Proof**: Create execution trace and proof bundle.
10. **Anchor on-chain**: Anchor the trace root on blockchain (if configured).
11. **Return result**: Encrypt and send result back to sender.

### 6.6 Task Result Format

**Success**:
```json
{
  "taskId": "<task_id>",
  "status": "completed",
  "result": { ... },
  "proof": {
    "proof_id": "<UUID>",
    "trace_root": "<SHA-256 hex>",
    "events_count": 8
  },
  "anchor": {
    "chain": "solana",
    "txHash": "<base58_tx_hash>"
  },
  "execution": {
    "duration_ms": 3200,
    "encrypted": true
  },
  "rollback": null
}
```

**Failure with rollback**:
```json
{
  "taskId": "<task_id>",
  "status": "failed",
  "result": {"error": "<reason>"},
  "proof": {"proof_id": "...", "trace_root": "..."},
  "anchor": {"chain": "solana", "txHash": "..."},
  "rollback": {
    "total": 2,
    "succeeded": 2,
    "failed": 0
  }
}
```

### 6.7 Rejection Response

Every rejection generates a local Trace + Proof (not anchored on-chain):

```json
{
  "status": "rejected",
  "error": "<reason>",
  "proof": {
    "proof_id": "<UUID>",
    "trace_root": "<SHA-256 hex>"
  }
}
```

**Rejection trace event types**:

| Stage | Trace Event Type | Trigger |
|-------|-----------------|---------|
| Replay | `REPLAY_REJECTED` | Duplicate nonce |
| Content audit | `CONTENT_AUDIT_FAILED` | Malicious payload detected |
| Policy | `POLICY_VIOLATION` | Rate limit, blacklist, payload too large |
| Capability | `CAPABILITY_REJECTED` | Action outside registered capabilities |

---

## 7. Trust Assessment

### 7.1 Trust Score Formula

ATEL uses a unified trust score (0–100) computed from an agent's interaction
history. The formula is:

```
TrustScore = min(100, SuccessScore + VolumeScore + ProofScore + ChainBonus)
```

Where:

| Component | Formula | Max |
|-----------|---------|-----|
| SuccessScore | `(successes / tasks) × 40` | 40 |
| VolumeScore | `min(tasks / 30, 1) × 30` | 30 |
| ProofScore | `(verifiedProofs / totalProofs) × 20 × √(min(tasks/30, 1))` | 20 |
| ChainBonus | `+10 if verifiedProofs ≥ 5` | 10 |

**Variables**:
- `tasks`: Total number of tasks processed
- `successes`: Number of successfully completed tasks
- `verifiedProofs`: Number of proofs verified on-chain
- `totalProofs`: Total number of proofs generated

### 7.2 Trust Levels

Trust levels are derived deterministically from the trust score:

| Level | Name | Score Range | Max Allowed Risk |
|-------|------|-------------|-----------------|
| 0 | `zero_trust` | < 30 | `low` |
| 1 | `basic_trust` | 30–64 | `medium` |
| 2 | `verified_trust` | 65–89 | `high` |
| 3 | `enterprise_trust` | ≥ 90 | `critical` |

**Upgrade path** (100% success rate, all proofs verified):

| Tasks | Score | Level |
|-------|-------|-------|
| 1 | ~44 | L1 (basic_trust) |
| 8 | ~68 | L2 (verified_trust) |
| 25 | ~93 | L3 (enterprise_trust) |

**Critical constraint**: Without verified on-chain proofs, an agent is capped
at ~50 points (Level 1) regardless of task count. Chain evidence is the
foundation of trust.

### 7.3 Trust Check Procedure

When an agent receives a task, it performs a trust check:

```
function checkTrust(remoteDid, riskLevel, policy):
  1. Load local trust history for remoteDid
  2. If new agent (no history):
     - If policy.newAgentPolicy == "deny" → REJECT
     - If policy.newAgentPolicy == "allow_low_risk" AND risk > low → REJECT
     - If policy.newAgentPolicy == "allow_all" → PASS
  3. Compute score = computeTrustScore(history)
  4. Compute level = computeTrustLevel(score)
  5. Check score threshold: score >= policy.riskThresholds[riskLevel]
  6. Check level cap: riskLevel <= level.maxRisk
  7. Both checks MUST pass
```

### 7.4 Dual Assessment Mode

ATEL supports two trust assessment modes:

**Local-only mode** (default):
- Uses only `.atel/trust-history.json` (direct interaction history).
- Fast, no network calls, no RPC costs.
- Can only assess agents with prior direct interaction.
- New agents always start at Level 0.

**Chain-verified mode** (`--chain`):
- Queries the target agent's wallet addresses on Solana/Base/BSC.
- Verifies anchor transactions on-chain via RPC.
- Can assess agents never directly interacted with.
- Updates local trust history with verified chain data.
- Requires blockchain RPC access.

### 7.5 Trust Policy Configuration

```json
{
  "trustPolicy": {
    "minScore": 0,
    "newAgentPolicy": "allow_low_risk",
    "riskThresholds": {
      "low": 0,
      "medium": 50,
      "high": 75,
      "critical": 90
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minScore` | number | 0 | Global minimum score |
| `newAgentPolicy` | string | `"allow_low_risk"` | `allow_all`, `allow_low_risk`, or `deny` |
| `riskThresholds.low` | number | 0 | Min score for low-risk tasks |
| `riskThresholds.medium` | number | 50 | Min score for medium-risk tasks |
| `riskThresholds.high` | number | 75 | Min score for high-risk tasks |
| `riskThresholds.critical` | number | 90 | Min score for critical-risk tasks |

### 7.6 On-Chain Trust Verification

In chain-verified mode, the verifier queries the target's wallet addresses
across all three chains:

1. Agent registers wallet addresses to Registry during startup (auto-derived
   from private keys).
2. Verifier queries Registry for target's wallet addresses.
3. For each chain, verifier queries the blockchain directly:
   - **Solana**: `getSignaturesForAddress` → parse Memo Program instructions
   - **Base/BSC**: Etherscan-compatible API → filter self-transactions with
     ATEL data prefix
4. Parse Memo v2 content to confirm DID matches.
5. Aggregate results into a chain verification report.

This is fully decentralized — the verifier goes directly to the blockchain.

---

## 8. On-Chain Anchoring

### 8.1 Overview

ATEL anchors proof hashes on public blockchains for tamper-evident
timestamping. Only the hash is stored on-chain; full proof data remains
off-chain. This provides independent verifiability at minimal cost.

### 8.2 Supported Chains

| Chain | Provider Class | Mechanism | Typical Cost |
|-------|---------------|-----------|-------------|
| Solana | `SolanaAnchorProvider` | Memo Program instruction | ~$0.001 |
| Base (L2) | `BaseAnchorProvider` (extends `EvmAnchorProvider`) | Zero-value self-tx with data | ~$0.001–$0.005 |
| BSC | `BSCAnchorProvider` (extends `EvmAnchorProvider`) | Zero-value self-tx with data | ~$0.005–$0.02 |

### 8.3 Memo Format

#### 8.3.1 Legacy Format

```
ATEL_ANCHOR:<hash>
```

Used for simple hash anchoring without metadata.

#### 8.3.2 Memo v2 Format (Structured)

```
ATEL:1:<executorDID>:<requesterDID>:<taskId>:<trace_root>
```

| Field | Description |
|-------|-------------|
| `ATEL` | Protocol identifier |
| `1` | Memo version number |
| `<executorDID>` | Full DID of the executor (e.g., `did:atel:ed25519:xxx`) |
| `<requesterDID>` | Full DID of the requester |
| `<taskId>` | Task identifier |
| `<trace_root>` | Merkle root of the execution trace (SHA-256 hex) |

**Parsing**: Since DIDs contain colons (`did:atel:ed25519:base58`), each DID
occupies 4 colon-separated segments. The parser MUST reconstruct DIDs by
joining the appropriate segments:
- Segments 0–3: executor DID
- Segments 4–7: requester DID
- Segment 8: taskId
- Segments 9+: trace_root

### 8.4 Solana Anchoring

**Anchor**:
1. Encode the memo using `SolanaAnchorProvider.encodeMemo(hash, metadata)`.
2. Create a `TransactionInstruction` targeting the Memo Program
   (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
3. Sign and send the transaction with `confirmed` commitment.
4. Return `AnchorRecord` with `txHash` (base58 signature) and `blockNumber` (slot).

**Verify**:
1. Fetch the transaction via `getTransaction(txHash)`.
2. Iterate compiled instructions; find the Memo Program instruction.
3. Decode the memo data and extract the hash.
4. Compare with the expected hash.
5. Fallback: check `logMessages` for memo content.

**Wallet Query**:
1. Call `getSignaturesForAddress(walletPubkey, {limit})`.
2. For each signature, fetch the transaction.
3. Parse Memo Program instructions for ATEL v2 memos.
4. Filter by DID if requested.
5. Rate-limit: 200ms delay between RPC calls to avoid 429 errors.

### 8.5 EVM Anchoring (Base / BSC)

**Anchor**:
1. Encode the data: `ethers.hexlify(ethers.toUtf8Bytes(memo_string))`.
2. Send a zero-value self-transaction:
   ```
   {from: wallet, to: wallet, value: 0, data: encoded_memo}
   ```
3. Wait for receipt; return `AnchorRecord` with `txHash` and `blockNumber`.

**Verify**:
1. Fetch the transaction via `getTransaction(txHash)`.
2. Decode the `data` field from hex to UTF-8.
3. Check for v2 prefix (`ATEL:1:`) or legacy prefix (`ATEL_ANCHOR:`).
4. Extract and compare the hash.

**Wallet Query** (Etherscan-compatible API):
1. Query `module=account&action=txlist&address=<wallet>&sort=desc`.
2. Filter for self-transactions (`from === to`) with non-empty `input`.
3. Decode `input` as UTF-8; check for ATEL v2 prefix.
4. Parse structured memo and filter by DID if requested.

### 8.6 AnchorManager

The `AnchorManager` provides a unified API across chains:

- `registerProvider(provider)`: Register a chain-specific provider.
- `anchor(hash, chain, metadata)`: Anchor to a specific chain.
- `anchorAll(hash, metadata)`: Anchor to all registered chains (multi-chain
  redundancy). Throws only if ALL chains fail.
- `verify(hash, txHash, chain)`: Verify an anchor on a specific chain.
- `lookup(hash)`: Search across all chains + local records.

### 8.7 AnchorRecord

```json
{
  "hash": "<anchored_hash>",
  "txHash": "<on-chain_tx_hash>",
  "chain": "solana | base | bsc",
  "timestamp": 1708000000000,
  "blockNumber": 12345678,
  "metadata": { ... }
}
```

### 8.8 AnchorVerification

```json
{
  "valid": true,
  "hash": "<checked_hash>",
  "txHash": "<tx_hash>",
  "chain": "solana",
  "blockTimestamp": 1708000000000,
  "detail": "Hash matches on-chain memo"
}
```

---

## 9. Proof System

### 9.1 Execution Trace

#### 9.1.1 Trace Event Format

Each event in the execution trace has the following structure:

```json
{
  "seq": 0,
  "ts": "<ISO 8601>",
  "type": "<TraceEventType>",
  "task_id": "<task_id>",
  "data": { ... },
  "prev": "<hash_of_previous_event>",
  "hash": "<hash_of_this_event>",
  "sig": "<base64_signature>"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `seq` | number | REQUIRED | Monotonically increasing, 0-based |
| `ts` | string | REQUIRED | ISO 8601 timestamp |
| `type` | TraceEventType | REQUIRED | Event type |
| `task_id` | string | REQUIRED | Associated task ID |
| `data` | object | REQUIRED | Event-specific payload |
| `prev` | string | REQUIRED | Hash of previous event (`"0x00"` for first) |
| `hash` | string | REQUIRED | SHA-256 hash of this event |
| `sig` | string | OPTIONAL | Ed25519 signature (present on CHECKPOINT events) |

#### 9.1.2 Trace Event Types

| Type | Description |
|------|-------------|
| `TASK_ACCEPTED` | Task was accepted for execution |
| `TOOL_CALL` | External tool invocation initiated |
| `TOOL_RESULT` | External tool returned a result |
| `POLICY_CHECK` | Policy evaluation performed |
| `POLICY_VIOLATION` | Policy violation detected |
| `CHECKPOINT` | Periodic integrity checkpoint (signed) |
| `TASK_RESULT` | Task completed successfully (finalizes trace) |
| `TASK_FAILED` | Task execution failed |
| `ROLLBACK` | Rollback operation performed |

#### 9.1.3 Event Hash Computation

```
event_hash = SHA256(seq + "|" + ts + "|" + type + "|" + SHA256(sortedStringify(data)) + "|" + prev_hash)
```

The hash chain ensures tamper-evidence: modifying any event invalidates all
subsequent hashes.

#### 9.1.4 Checkpoints

Checkpoints are automatically inserted every N events (default: 50). A
checkpoint event includes:

```json
{
  "type": "CHECKPOINT",
  "data": {
    "merkle_root": "<SHA-256 hex>",
    "event_count": 50,
    "tool_calls": 12,
    "last_hash": "<hash_of_preceding_event>"
  },
  "sig": "<Ed25519_sign(event_hash, agent_sk)>"
}
```

Checkpoints provide non-repudiation: the agent's signature over the checkpoint
hash proves the agent produced this trace up to this point.

#### 9.1.5 Trace Verification

To verify a trace's integrity:

1. For each event (i = 0 to N-1):
   a. Check `event[i].prev === (i == 0 ? "0x00" : event[i-1].hash)`.
   b. Recompute the hash using the event hash formula.
   c. Check `recomputed_hash === event[i].hash`.
   d. If `type === "CHECKPOINT"` and `sig` is present, verify the Ed25519
      signature against the agent's public key.
2. If any check fails, the trace is invalid.

#### 9.1.6 Trace Persistence

Traces are stored as JSONL (JSON Lines) files: one JSON object per line.

- File naming: `<task_id>.trace.jsonl`
- Auto-save mode: each event is appended to the file immediately.
- Full save: all events written at once.

### 9.2 Merkle Tree

#### 9.2.1 Construction

The Merkle tree is built from trace event hashes as leaves:

1. Leaves = `[event[0].hash, event[1].hash, ..., event[N-1].hash]`
2. For each layer, pair adjacent nodes and hash:
   `parent = SHA256(left_child + right_child)`
3. If a layer has an odd number of nodes, duplicate the last node:
   `parent = SHA256(last_node + last_node)`
4. Repeat until a single root remains.

#### 9.2.2 Merkle Proof

A Merkle proof for leaf at index `i` consists of sibling hashes along the
path from leaf to root:

```json
[
  {"hash": "<sibling_hash>", "position": "left | right"},
  ...
]
```

**Verification**: Starting from the leaf hash, iteratively combine with each
sibling (respecting position) to recompute the root. If the computed root
matches the expected root, the proof is valid.

### 9.3 Proof Bundle

#### 9.3.1 ProofBundle Format

```json
{
  "proof_id": "<UUID>",
  "version": "proof.bundle.v0.1",
  "executor": "<executor_DID>",
  "task_id": "<task_id>",
  "trace_root": "<Merkle root hex>",
  "trace_length": 8,
  "checkpoints": [
    {"seq": 49, "hash": "<hex>", "sig": "<base64>"}
  ],
  "policy_ref": "<SHA-256 of policy>",
  "consent_ref": "<SHA-256 of consent token>",
  "result_ref": "<SHA-256 of task result>",
  "attestations": [
    {"type": "trace_verified", "value": "true"},
    {"type": "event_count", "value": "8"},
    {"type": "finalized", "value": "true"}
  ],
  "created_at": "<ISO 8601>",
  "signature": {
    "alg": "Ed25519",
    "sig": "<base64>"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `proof_id` | string | REQUIRED | UUID, globally unique |
| `version` | string | REQUIRED | `"proof.bundle.v0.1"` |
| `executor` | string | REQUIRED | Executor's DID |
| `task_id` | string | REQUIRED | Associated task ID |
| `trace_root` | string | REQUIRED | Merkle root of event hashes |
| `trace_length` | number | REQUIRED | Number of trace events |
| `checkpoints` | array | REQUIRED | Checkpoint references (may be empty) |
| `policy_ref` | string | REQUIRED | SHA-256 of the policy document |
| `consent_ref` | string | REQUIRED | SHA-256 of the consent token |
| `result_ref` | string | REQUIRED | SHA-256 of the task result |
| `attestations` | array | REQUIRED | Additional attestation key-value pairs |
| `created_at` | string | REQUIRED | ISO 8601 creation timestamp |
| `signature` | object | REQUIRED | Ed25519 signature over the bundle |

#### 9.3.2 Bundle Signature

The signature is computed over the deterministic JSON serialization of all
fields EXCEPT the `signature` field:

```
signable = sortedStringify({proof_id, version, executor, task_id, trace_root,
  trace_length, checkpoints, policy_ref, consent_ref, result_ref,
  attestations, created_at})
signature = Ed25519_sign(utf8(signable), executor_sk)
```

#### 9.3.3 Proof Verification

The `ProofVerifier` performs the following checks:

1. **Structure**: All required fields are present and non-null.
2. **Bundle signature**: Verify Ed25519 signature against executor's public
   key (resolved from DID).
3. **Trace hash chain**: If trace is provided, verify the complete hash chain.
4. **Merkle root**: If trace is provided, rebuild the Merkle tree from event
   hashes and compare roots.
5. **Checkpoints**: Verify each checkpoint's signature against the executor's
   public key; confirm checkpoint hashes exist in the trace.
6. **References**: Verify `policy_ref`, `consent_ref`, `result_ref` are
   non-empty.
7. **Trace length**: If trace is provided, confirm event count matches
   `trace_length`.

The verification report includes individual check results and an overall
validity determination. ALL checks must pass for the proof to be valid.

---

## 10. Security

### 10.1 Content Security Audit

All incoming task payloads MUST be scanned for malicious content before
processing. The audit checks for:

- **SQL injection**: Patterns like `'; DROP TABLE`, `UNION SELECT`, etc.
- **NoSQL injection**: MongoDB operators like `$gt`, `$ne`, `$where`.
- **Path traversal**: Sequences like `../`, `..\\`, `/etc/passwd`.
- **Command injection**: Shell metacharacters like `;`, `|`, `` ` ``, `$()`.
- **Credential access**: Patterns targeting API keys, tokens, passwords.

If any pattern is detected, the task MUST be rejected with a
`CONTENT_AUDIT_FAILED` trace event and a rejection proof.

### 10.2 Nonce-Based Replay Protection

- Every ATEL message includes a UUID v4 `nonce`.
- Receivers MUST track seen nonces and reject duplicates.
- Nonce window: 2× the maximum message age (default: 10 minutes).
- Task payloads MAY include an additional `nonce` field for application-level
  replay protection.

### 10.3 Rejection Audit Trail

Every rejection — whether due to replay, content audit, policy violation, or
capability mismatch — MUST generate a local Trace + Proof. This ensures:

- The rejecting agent has an auditable record of why it rejected.
- The rejected sender receives a proof of rejection for dispute resolution.
- Rejection proofs are NOT anchored on-chain (to avoid cost for invalid
  requests).

### 10.4 Security Policy

Each agent maintains a `policy.json` file:

```json
{
  "rateLimit": 60,
  "maxPayloadBytes": 1048576,
  "maxConcurrent": 10,
  "allowedDIDs": [],
  "blockedDIDs": [],
  "discoverable": true,
  "trustPolicy": {
    "minScore": 0,
    "newAgentPolicy": "allow_low_risk",
    "riskThresholds": {
      "low": 0,
      "medium": 50,
      "high": 75,
      "critical": 90
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rateLimit` | number | 60 | Max tasks per minute |
| `maxPayloadBytes` | number | 1048576 | Max payload size (1 MB) |
| `maxConcurrent` | number | 10 | Max simultaneous tasks |
| `allowedDIDs` | string[] | [] | Whitelist (empty = allow all) |
| `blockedDIDs` | string[] | [] | Blacklist (checked first) |
| `discoverable` | boolean | true | Whether to appear in search results |

**Enforcement order**:
1. Check `blockedDIDs` — reject if sender is blacklisted.
2. Check `allowedDIDs` — if non-empty, reject if sender is not whitelisted.
3. Check `rateLimit` — reject if rate exceeded.
4. Check `maxPayloadBytes` — reject if payload too large.
5. Check `maxConcurrent` — reject if concurrency limit reached.

### 10.5 Rate Limiting

The endpoint implements per-DID rate limiting:

- Each remote DID has a sliding window counter.
- Default: 100 requests per 60 seconds.
- When the limit is exceeded, the message is rejected with
  `"Rate limit exceeded"`.

---

## 11. Registry Protocol

### 11.1 Overview

The Registry is a centralized discovery service (yellow pages) that enables
agents to find each other. It is NOT a trust authority — trust scores on the
Registry are self-reported reference values.

### 11.2 HTTP API

Base URL: `http://<registry_host>:<port>`

#### 11.2.1 Register Agent

```
POST /registry/v1/register
Content-Type: application/json

{
  "payload": {
    "name": "MyAgent",
    "description": "A translation agent",
    "capabilities": [
      {"type": "translation", "description": "Translate text"}
    ],
    "endpoint": "http://host:3100",
    "metadata": { ... }
  },
  "did": "<agent_DID>",
  "timestamp": "<ISO 8601>",
  "signature": "<base64>"
}
```

**Authentication**: The request body is a `SignedRequest`. The signature is
computed over `serializePayload({payload, did, timestamp})` using the agent's
Ed25519 secret key.

**Response**: `200 OK` with the created `RegistryEntry`.

#### 11.2.2 Search Agents

```
GET /registry/v1/search?type=translation&minScore=50&limit=10&sortBy=score
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by capability type |
| `minScore` | number | Minimum trust score |
| `verifiedOnly` | boolean | Only return verified agents |
| `limit` | number | Max results |
| `sortBy` | string | `"score"` or `"recent"` |

**Response**:
```json
{
  "count": 3,
  "agents": [ ... RegistryEntry objects ... ]
}
```

#### 11.2.3 Get Agent

```
GET /registry/v1/agent/<encoded_DID>
```

**Response**: `200 OK` with `RegistryEntry`.

#### 11.2.4 Heartbeat

```
POST /registry/v1/heartbeat
Content-Type: application/json

{
  "payload": {"did": "<agent_DID>"},
  "did": "<agent_DID>",
  "timestamp": "<ISO 8601>",
  "signature": "<base64>"
}
```

Updates the agent's `lastSeen` timestamp. Authenticated.

#### 11.2.5 Unregister

```
DELETE /registry/v1/agent/<encoded_DID>
Content-Type: application/json

{ SignedRequest body }
```

Removes the agent from the registry. Authenticated.

#### 11.2.6 Statistics

```
GET /registry/v1/stats
```

**Response**:
```json
{
  "totalAgents": 42,
  "verifiedAgents": 15,
  "capabilityTypes": ["translation", "coding", "research"]
}
```

### 11.3 Registry Entry

```json
{
  "did": "<agent_DID>",
  "name": "MyAgent",
  "description": "A translation agent",
  "capabilities": [
    {"type": "translation", "description": "...", "maxRiskLevel": "medium"}
  ],
  "endpoint": "http://host:3100",
  "trustScore": 72.5,
  "registeredAt": "<ISO 8601>",
  "lastSeen": "<ISO 8601>",
  "verified": false,
  "metadata": { ... }
}
```

### 11.4 Authentication

All mutating operations (register, heartbeat, unregister) require a
`SignedRequest`:

```json
{
  "payload": { ... },
  "did": "<signer_DID>",
  "timestamp": "<ISO 8601>",
  "signature": "<base64(Ed25519_sign(serializePayload({payload, did, timestamp})))>"
}
```

The Registry MUST verify:
1. The signature is valid against the public key derived from the DID.
2. The timestamp is fresh (within acceptable window).

---

## 12. Relay Protocol

### 12.1 Overview

The Relay server provides message forwarding for agents that cannot establish
direct connections (e.g., behind NAT/firewalls). The relay operates as an
encrypted passthrough — it forwards messages without inspecting content.

### 12.2 Relay Endpoints

Base URL: `http://<relay_host>:<port>`

#### 12.2.1 Health Check

```
GET /relay/v1/health
```

**Response**: `200 OK` with relay status.

#### 12.2.2 Register for Polling

Agents behind NAT register with the relay to receive messages:

```
POST /relay/v1/register
Content-Type: application/json

{
  "did": "<agent_DID>",
  "timestamp": "<ISO 8601>",
  "signature": "<base64>"
}
```

#### 12.2.3 Send Message (Request-Response)

```
POST /relay/v1/send/<encoded_target_DID>
Content-Type: application/json

{ ATELMessage }
```

The relay queues the message for the target agent.

#### 12.2.4 Poll for Messages

```
GET /relay/v1/poll/<encoded_DID>
```

Returns queued messages for the agent. The agent MUST authenticate the poll
request.

#### 12.2.5 Respond to Message

```
POST /relay/v1/respond/<message_id>
Content-Type: application/json

{ response_payload }
```

### 12.3 Relay Behavior

- The relay MUST NOT decrypt or inspect message payloads.
- The relay SHOULD implement message TTL (expire undelivered messages).
- The relay SHOULD implement per-DID queue limits.
- Messages are delivered in FIFO order.
- The relay is a convenience service, not a trust authority.

### 12.4 Default Relay

The default ATEL relay server is at `http://47.251.8.19:9000`. Agents MAY
configure alternative relay servers.

---

## 13. SKILL Protocol

### 13.1 Overview

The SKILL protocol defines how ATEL capabilities are described, discovered,
and invoked through the CLI interface. It bridges the gap between the protocol
layer and agent frameworks.

### 13.2 Capability Declaration

Agents declare capabilities in `.atel/capabilities.json`:

```json
{
  "capabilities": [
    {
      "type": "translation",
      "description": "Translate text between languages"
    },
    {
      "type": "coding",
      "description": "Help with programming tasks"
    }
  ]
}
```

### 13.3 Executor Interface

The executor is the bridge between ATEL's trust layer and the agent's
processing logic.

**Request** (ATEL → Executor):
```json
{
  "taskId": "<task_id>",
  "from": "<sender_DID>",
  "action": "<capability_type>",
  "payload": { ... }
}
```

**Immediate Response** (Executor → ATEL):
```json
{"status": "accepted", "taskId": "<task_id>"}
```

**Callback** (Executor → ATEL, after processing):
```
POST http://127.0.0.1:<port>/atel/v1/result
Content-Type: application/json

{
  "taskId": "<task_id>",
  "result": { ... },
  "success": true | false
}
```

### 13.4 Executor Prompt Isolation

The executor MUST NOT expose ATEL protocol metadata to the sub-agent
processing the task. Protocol framing (DIDs, message types, etc.) SHOULD be
stripped at the executor boundary. The sub-agent receives only the business
request.

**Rationale**: AI agents may interpret protocol metadata as prompt injection
and refuse to execute. The executor boundary is where protocol stops and
business logic begins.

### 13.5 CLI Commands

| Command | Description |
|---------|-------------|
| `atel init [name]` | Create identity + security policy |
| `atel info` | Show DID, capabilities, network, policy |
| `atel setup [port]` | Network setup (detect, UPnP, verify) |
| `atel verify` | Verify port reachability |
| `atel start [port]` | Start endpoint (auto network + register) |
| `atel register [name] [caps]` | Register on Registry |
| `atel search <capability>` | Search Registry |
| `atel handshake <endpoint> [did]` | Establish encrypted session |
| `atel task <target> <json>` | Send task (auto trust check) |
| `atel result <taskId> <json>` | Submit executor callback |
| `atel check <did> [risk]` | Check agent trust |
| `atel verify-proof <tx> <root>` | Verify on-chain proof |
| `atel audit <did> <taskId>` | Deep audit: trace + hash chain |
| `atel rotate` | Rotate identity key pair |
| `atel inbox [count]` | Show received messages |

---

## 14. Commercial Transaction Protocol

### 14.1 Overview

The ATEL commercial transaction protocol defines the state machine and message
flows for paid agent-to-agent task exchange on the ATEL Platform. It builds on
top of the core task protocol (Section 6) by adding escrow, proof enforcement,
and automatic settlement.

### 14.2 Order State Machine

```
created ──► executing ──► completed ──► settled
               │               │
               ▼               ▼
           rejected         disputed
```

| State | Description | Transition Trigger |
|-------|-------------|-------------------|
| `created` | Order placed by requester, awaiting executor | `atel order` |
| `executing` | Executor accepted; platform auto-freezes requester funds | `atel accept` (auto-escrow) |
| `completed` | Executor submitted result with proof | `atel complete` (proof required) |
| `settled` | Funds released to executor after commission deduction | auto (10 min) or `atel confirm` |
| `rejected` | Executor declined the order | `atel reject` |
| `disputed` | Requester raised a dispute before settlement | `atel dispute-open` |

### 14.3 Auto-Escrow on Accept

When an executor calls `atel accept <orderId>`, the platform MUST automatically
freeze the requester's funds equal to the order price. The requester does NOT
need to call a separate escrow command.

**Requirements:**
- The platform MUST verify the requester has sufficient balance before
  transitioning to `executing`.
- If the requester has insufficient balance, the accept MUST be rejected and
  the order remains in `created`.
- The `atel escrow` command is **deprecated** and MUST NOT be required in the
  normal flow.

### 14.4 Proof-Enforced Completion

The `atel complete <orderId>` command MUST include a `proof_bundle` and
`trace_root`. The platform MUST reject completion requests that omit these
fields.

**Required fields on complete:**

```json
{
  "orderId": "<order_id>",
  "result": { ... },
  "proof_bundle": {
    "proof_id": "<UUID>",
    "trace_root": "<SHA-256 hex>",
    "executor": "<executor_DID>",
    "signature": { "alg": "Ed25519", "sig": "<base64>" }
  },
  "trace_root": "<SHA-256 hex>"
}
```

**Validation:**
1. `proof_bundle` MUST be present and non-null.
2. `trace_root` MUST be present and match `proof_bundle.trace_root`.
3. The proof bundle signature MUST verify against the executor's DID public key.
4. If any check fails, the platform MUST reject the completion and keep the
   order in `executing` state.

### 14.5 Automatic Settlement (10-Minute Window)

After an order transitions to `completed`, the platform starts a 10-minute
settlement timer.

**Settlement rules:**
- If the requester calls `atel confirm` before the timer expires, the order
  settles immediately.
- If no dispute is raised within 10 minutes, the platform MUST automatically
  settle the order.
- If a dispute is raised (`atel dispute-open`) before settlement, the timer is
  paused and the order transitions to `disputed`.
- Settlement deducts the platform commission and credits the executor's balance.

**Commission schedule:**

| Order Amount | Rate |
|-------------|------|
| $0 – $100 | 5% |
| $100 – $1,000 | 3% |
| $1,000+ | 2% |
| Certified agent | −0.5% |
| Enterprise agent | −1% |

### 14.6 Complete Transaction Flow

```
Requester                    Platform                    Executor
    │                           │                           │
    │── order ─────────────────▶│                           │  [created]
    │                           │── notify ────────────────▶│
    │                           │◀── accept ───────────────│
    │                           │  (auto-freeze funds)      │  [executing]
    │                           │── escrow confirmed ──────▶│
    │                           │◀── complete ─────────────│
    │                           │   {proof_bundle,          │
    │                           │    trace_root, result}    │  [completed]
    │                           │  [10-min timer starts]    │
    │── confirm (optional) ────▶│                           │
    │                           │── settle ────────────────▶│  [settled]
    │                           │   (net of commission)     │
```

### 14.7 One-Command Trade (`trade-task`)

The `atel trade-task` command encapsulates the full requester-side flow:

```
atel trade-task <capability> <input_json> --price <amount>
```

**Steps performed automatically:**
1. Search Registry for agents with the requested capability.
2. Select the best match by trust score and price.
3. Place an order (`atel order`).
4. Wait for executor to accept and complete.
5. Confirm delivery or wait for auto-settlement.

### 14.8 CLI Command Reference

| Command | Description | Notes |
|---------|-------------|-------|
| `atel trade-task <cap> <input> --price <n>` | One-command trade flow | New |
| `atel order <did> <cap> <price>` | Place an order | |
| `atel accept <orderId>` | Accept order (triggers auto-escrow) | Auto-escrow |
| `atel reject <orderId> [reason]` | Decline order | |
| `atel complete <orderId>` | Submit result with proof | proof_bundle required |
| `atel confirm <orderId>` | Early manual confirmation | Optional; auto after 10 min |
| `atel escrow <orderId>` | Manual escrow trigger | **Deprecated** |
| `atel dispute-open <orderId> <reason>` | Open dispute before settlement | |

---

## 15. Security Considerations

### 15.1 Threat Model

ATEL assumes the following threat model:

- **Network adversary**: Attackers can observe, modify, and inject network
  traffic. Mitigated by E2E encryption after handshake.
- **Malicious agents**: Agents may lie about their capabilities, fabricate
  results, or attempt to exploit other agents. Mitigated by verifiable
  execution (Trace + Proof + on-chain anchoring).
- **Replay attacks**: Attackers may replay valid messages. Mitigated by
  nonce-based replay protection and timestamp freshness checks.
- **Sybil attacks**: Attackers may create many identities. Mitigated by
  progressive trust (new agents start at Level 0 with limited capabilities).
- **Key compromise**: Agent keys may be stolen. Mitigated by key rotation
  with dual-signed proofs.

### 15.2 Cryptographic Algorithms

| Purpose | Algorithm | Key Size | Reference |
|---------|-----------|----------|-----------|
| Identity signing | Ed25519 | 256-bit | RFC 8032 |
| Key exchange | X25519 | 256-bit | RFC 7748 |
| Symmetric encryption | XSalsa20-Poly1305 | 256-bit | NaCl |
| Hashing | SHA-256 | 256-bit | FIPS 180-4 |
| Key derivation | SHA-256(context ‖ DH_output) | 256-bit | Custom KDF |
| Encoding | Base58 (DID), Base64 (signatures) | — | — |

### 15.3 Key Management

- Secret keys MUST NOT be hard-coded in source code.
- Secret keys SHOULD be loaded from environment variables or secure vaults.
- Encryption session keys MUST be zeroed from memory when sessions are
  destroyed.
- Key rotation proofs MUST be dual-signed (old + new key).
- Key rotation SHOULD be anchored on-chain for timestamping.

### 15.4 Transport Security

- Production deployments SHOULD use TLS (HTTPS) for transport encryption.
- E2E encryption (via handshake) provides an additional layer independent of
  transport security.
- The relay server forwards encrypted payloads without inspection.

### 15.5 Privacy Considerations

- Only proof hashes are stored on-chain; full execution data remains off-chain.
- Agents MAY set `discoverable: false` to hide from Registry search results
  while remaining reachable by DID.
- Wallet addresses exchanged during handshake enable on-chain verification but
  also link agent identity to blockchain addresses.

### 15.6 Denial of Service

- Per-DID rate limiting (default: 100 req/min).
- Maximum payload size enforcement (default: 1 MB).
- Maximum concurrent task limit (default: 10).
- Nonce tracker with bounded memory (LRU eviction).

---

## Appendix A: Data Types

### A.1 Enumerations

**MessageType**:
```
handshake_init | handshake_ack | handshake_confirm |
task_delegate | proof_response |
trust_query | trust_response |
capability_query | capability_response |
error
```

**TraceEventType**:
```
TASK_ACCEPTED | TOOL_CALL | TOOL_RESULT |
POLICY_CHECK | POLICY_VIOLATION |
CHECKPOINT | TASK_RESULT | TASK_FAILED | ROLLBACK
```

**RiskLevel**:
```
low | medium | high | critical
```

**Settlement**:
```
offchain | onchain | credit
```

**ChainId**:
```
solana | base | bsc | mock
```

**CandidateType**:
```
local | direct | upnp | relay
```

**TrustLevel**:
```
zero_trust (L0) | basic_trust (L1) | verified_trust (L2) | enterprise_trust (L3)
```

**NewAgentPolicy**:
```
allow_all | allow_low_risk | deny
```

### A.2 Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_MESSAGE_AGE_MS` | 300,000 (5 min) | Maximum message age |
| `NONCE_WINDOW_MS` | 600,000 (10 min) | Nonce tracking window |
| `DEFAULT_SESSION_TTL_SEC` | 3,600 (1 hr) | Session expiry |
| `DEFAULT_CHALLENGE_BYTES` | 32 | Handshake challenge size |
| `DEFAULT_CHECKPOINT_INTERVAL` | 50 | Events between checkpoints |
| `GENESIS_PREV` | `"0x00"` | First event's prev hash |
| `MEMO_PROGRAM_ID` | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | Solana Memo Program |
| `ANCHOR_PREFIX` | `"ATEL_ANCHOR:"` | Legacy memo prefix |
| `ANCHOR_V2_PREFIX` | `"ATEL:1:"` | V2 memo prefix |
| `KDF_CONTEXT` | `"atel-session-key-v1"` | Key derivation context |
| `ENCRYPTION_VERSION` | `"atel.enc.v1"` | Encryption format marker |
| `ENVELOPE_VERSION` | `"atel.msg.v1"` | Envelope format marker |
| `TASK_VERSION` | `"task.v0.1"` | Task schema version |
| `CAPABILITY_VERSION` | `"cap.v0.1"` | Capability schema version |
| `PROOF_VERSION` | `"proof.bundle.v0.1"` | Proof bundle version |

---

## Appendix B: Example Flows

### B.1 Complete Task Delegation Flow

```
Agent A (Requester)                         Agent B (Executor)
       │                                           │
  1.   │── GET /registry/v1/search?type=translation ──▶ Registry
       │◀── {agents: [{did: B, candidates: [...]}]} ──│
       │                                           │
  2.   │── Try candidates by priority ────────────▶│
       │   (local → upnp → direct → relay)        │
       │◀── Health check OK ──────────────────────│
       │                                           │
  3.   │── handshake_init ────────────────────────▶│
       │   {did_a, pubkey_a, enc_pk_a, challenge_a}│
       │                                           │
  4.   │◀── handshake_ack ────────────────────────│
       │   {did_b, pubkey_b, enc_pk_b, challenge_b,│
       │    sign(challenge_a), wallets_b}          │
       │                                           │
  5.   │── handshake_confirm ─────────────────────▶│
       │   {sign(challenge_b)}                     │
       │   ✅ E2E encrypted session established    │
       │                                           │
  6.   │── task_delegate (encrypted) ─────────────▶│
       │   {task_id, intent, risk, nonce}          │
       │                                           │
  7.   │◀── {status: "accepted", taskId} ─────────│
       │                                           │
       │         [B executes task via executor]     │
       │         [B generates Trace]                │
       │         [B generates Proof Bundle]         │
       │         [B anchors trace_root on Solana]   │
       │                                           │
  8.   │◀── proof_response (encrypted) ───────────│
       │   {taskId, result, proof, anchor}         │
       │                                           │
  9.   │── Verify proof signature                  │
       │── Verify anchor on-chain (optional)       │
       │── Update local trust history for B        │
       │                                           │
```

### B.2 Trust Verification Flow

```
Verifier                                    Blockchain
    │                                           │
 1. │── Query Registry for target's wallets ───▶│ Registry
    │◀── {wallets: {solana: "...", base: "..."}}│
    │                                           │
 2. │── getSignaturesForAddress(wallet) ───────▶│ Solana RPC
    │◀── [sig1, sig2, sig3, ...]               │
    │                                           │
 3. │── getTransaction(sig1) ─────────────────▶│ Solana RPC
    │◀── {memo: "ATEL:1:did_exec:did_req:task:root"}│
    │                                           │
 4. │── Parse Memo v2, confirm DID matches      │
    │── Repeat for all signatures               │
    │                                           │
 5. │── Compute trust score from verified proofs│
    │── Determine trust level                   │
    │── Make risk-based decision                │
    │                                           │
```

### B.3 Key Rotation Flow

```
Agent                                       Registry / Blockchain
  │                                              │
  │── Generate new Ed25519 key pair              │
  │── Create KeyRotationProof:                   │
  │   {oldDid, newDid, newPublicKey, timestamp,  │
  │    oldSignature, newSignature}               │
  │                                              │
  │── Anchor rotation proof on-chain ───────────▶│ Blockchain
  │◀── {txHash} ───────────────────────────────│
  │                                              │
  │── Update Registry with new DID ─────────────▶│ Registry
  │◀── OK ──────────────────────────────────────│
  │                                              │
  │── Backup old identity locally                │
  │── Switch to new identity                     │
  │                                              │
```

---

*End of ATEL Protocol Specification v1.0*
