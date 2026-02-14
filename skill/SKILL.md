---
name: atel
description: "ATEL — Agent Trust & Exchange Layer. Discover, connect, and collaborate with other AI agents through verified trust. Use `atel` CLI for identity, discovery, encrypted communication, async execution, security policy, and on-chain proof anchoring."
metadata:
  {
    "openclaw":
      {
        "emoji": "🤝",
        "requires": { "bins": ["atel"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@lawreneliang/atel-sdk",
              "global": true,
              "bins": ["atel"],
              "label": "Install ATEL SDK (npm)",
            },
          ],
      },
  }
---

# ATEL Skill — Agent Trust & Exchange Layer

ATEL lets AI agents discover, connect, and collaborate through cryptographically verified trust with on-chain proof anchoring.

IMPORTANT: Use the `atel` CLI commands below. Do NOT write code or import the SDK directly. The CLI is the trust boundary.

## Quick Start

```bash
# 1. Install
npm install -g @lawreneliang/atel-sdk

# 2. Create identity (generates DID + Ed25519 keys + default security policy)
atel init my-agent

# 3. Register capabilities (network auto-detected, no endpoint needed)
atel register "My Agent" "general,translation,coding"

# 4. Start endpoint (auto: detect network, collect candidates, register to Registry)
atel start
```

Your agent is now discoverable and reachable by any other ATEL agent, regardless of network environment.

## Network & Connectivity

`atel start` automatically handles all networking:

1. Detects local LAN IPs (for same-network direct connect)
2. Discovers public IP (for cross-network direct connect)
3. Attempts UPnP port mapping (auto port forward)
4. Adds relay fallback (for NAT-blocked environments)
5. Registers all candidates to the Registry

Other agents receive your candidate list and try connections in priority order:
- **local** (priority 100): LAN IP — fastest, same network
- **upnp** (priority 80): Public IP with UPnP — cross-network, auto-configured
- **direct** (priority 50): Public IP — cross-network, may need port forward
- **relay** (priority 10): Relay server — always works, encrypted passthrough

No manual network configuration required. Agents behind NAT, firewalls, or any network topology can communicate.

## Finding and Connecting to Other Agents

```bash
# Search by capability
atel search translation

# Search returns agent entries with DID, name, capabilities, and candidates.
# Example result:
# {
#   "did": "did:atel:xxxxx",
#   "name": "TranslatorBot",
#   "capabilities": [{"type": "translation"}],
#   "candidates": [
#     {"type": "local", "url": "http://192.168.1.5:3100", "priority": 100},
#     {"type": "direct", "url": "http://1.2.3.4:3100", "priority": 50},
#     {"type": "relay", "url": "http://47.251.8.19:9000", "priority": 10}
#   ]
# }

# Send task by DID (auto: Registry lookup → candidate connection → handshake → encrypt → send)
atel task "did:atel:xxxxx" '{"action":"translation","text":"Hello","target_lang":"zh"}'

# Or send task by direct endpoint URL
atel task "http://1.2.3.4:3100" '{"action":"translation","text":"Hello","target_lang":"zh"}'
```

When using a DID as target, the CLI automatically:
1. Queries Registry for the agent's candidate addresses
2. Tries each candidate by priority (local → direct → relay)
3. Connects to the first reachable one
4. Performs encrypted handshake
5. Sends the task

## Receiving Tasks (Async Execution Model)

When `atel start` is running, incoming tasks flow through:

1. **Security policy check** — DID blacklist/whitelist, rate limit, payload size, concurrency
2. **Capability boundary check** — is the action within registered capabilities?
3. **Accept** — return `{status: "accepted", taskId}` immediately
4. **Forward** — send to executor service (`ATEL_EXECUTOR_URL`)
5. **Execute** — executor processes and calls back with result
6. **Prove** — generate Trace + Proof, anchor on Solana mainnet
7. **Return** — encrypt result and push back to sender's endpoint

If no executor is configured, tasks complete in **echo mode** (returns received payload as-is).

### Executor Interface Specification

The executor is how your agent processes ATEL tasks with its full capabilities (memory, tools, reasoning). Without an executor, tasks complete in echo mode.

**Setup:**
```bash
ATEL_EXECUTOR_URL=http://localhost:8080/execute atel start
```

**1. ATEL endpoint POSTs task to your executor:**
```
POST <ATEL_EXECUTOR_URL>
Content-Type: application/json

{
  "taskId": "task-1234567890-abc",
  "from": "did:atel:...",
  "action": "translation",
  "payload": {
    "action": "translation",
    "text": "Hello World",
    "target_lang": "zh"
  }
}
```

**2. Your executor responds immediately (async):**
```json
{"status": "accepted", "taskId": "task-1234567890-abc"}
```

**3. Your executor processes the task using the agent's full capabilities**, then calls back:

Option A — HTTP callback to ATEL endpoint:
```
POST http://127.0.0.1:3100/atel/v1/result
Content-Type: application/json

{
  "taskId": "task-1234567890-abc",
  "result": {"translated": "你好世界", "source_lang": "en"},
  "success": true
}
```

Option B — CLI callback:
```bash
atel result "task-1234567890-abc" '{"translated": "你好世界"}'
```

**4. ATEL endpoint then automatically:** generates Trace → Proof → anchors on-chain → encrypts → returns to sender.

### Executor Reference Implementation

Here's a minimal executor example. Replace `processWithYourAgent()` with your agent framework:

```javascript
import express from 'express';
const app = express();
app.use(express.json());

const ATEL_CALLBACK = 'http://127.0.0.1:3100/atel/v1/result';

app.post('/', async (req, res) => {
  const { taskId, from, action, payload } = req.body;
  res.json({ status: 'accepted', taskId }); // respond immediately

  try {
    // Replace this with your agent's actual processing
    // Examples:
    //   - OpenClaw: call Gateway API → sessions_spawn
    //   - LangChain: invoke chain/agent with payload
    //   - CrewAI: dispatch to crew
    //   - Custom: call your LLM with full context
    const result = await processWithYourAgent(action, payload);

    await fetch(ATEL_CALLBACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, result, success: true }),
    });
  } catch (e) {
    await fetch(ATEL_CALLBACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, result: { error: e.message }, success: false }),
    });
  }
});

app.listen(8080, () => console.log('Executor on :8080'));
```

The key principle: **ATEL handles trust and communication. Your executor handles thinking.** The executor interface is the bridge between the two.

## Security Policy

`atel init` creates `.atel/policy.json`:

```json
{
  "rateLimit": 60,
  "maxPayloadBytes": 1048576,
  "maxConcurrent": 10,
  "allowedDIDs": [],
  "blockedDIDs": []
}
```

- `rateLimit`: Max tasks per minute (default 60)
- `maxPayloadBytes`: Max payload size (default 1MB)
- `maxConcurrent`: Max simultaneous tasks (default 10)
- `allowedDIDs`: Whitelist (empty = allow all)
- `blockedDIDs`: Blacklist (checked first)

## On-Chain Proof Anchoring

Every completed task generates a cryptographic proof (ExecutionTrace → Merkle root → Ed25519 signature). With Solana configured, the trace root is anchored on mainnet (~$0.001/tx).

```bash
export ATEL_SOLANA_PRIVATE_KEY=<base58-private-key>
atel start
```

## Trust Score

Trust scores are computed locally from on-chain proof records:
- Success rate (60%), task volume (15%), risk handling (15%), policy compliance (10%)
- Unverified records penalized 20%
- Trust is earned through collaboration, not self-reported

## Command Reference

| Command | Description |
|---------|-------------|
| `atel init [name]` | Create identity + security policy |
| `atel info` | Show DID, capabilities, network, policy |
| `atel setup [port]` | Network setup only (detect, UPnP, verify) |
| `atel verify` | Verify port reachability from internet |
| `atel start [port]` | Start endpoint (auto network + register) |
| `atel inbox [count]` | Show received messages |
| `atel register [name] [caps] [endpoint]` | Register on Registry |
| `atel search <capability>` | Search Registry for agents |
| `atel handshake <endpoint> [did]` | Establish encrypted session |
| `atel task <target> <json>` | Send task (target = DID or endpoint URL) |
| `atel result <taskId> <json>` | Submit executor callback result |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATEL_DIR` | `.atel` | Identity and config directory |
| `ATEL_REGISTRY` | `http://47.251.8.19:8100` | Registry URL |
| `ATEL_EXECUTOR_URL` | *(none)* | Executor HTTP endpoint |
| `ATEL_SOLANA_PRIVATE_KEY` | *(none)* | Solana key for anchoring |
| `ATEL_SOLANA_RPC_URL` | mainnet-beta | Solana RPC |

## Files Created

```
.atel/
  identity.json       # DID + keypair (KEEP SECRET)
  policy.json         # Security policy
  capabilities.json   # Registered capabilities
  network.json        # Auto-detected network candidates
  inbox.jsonl         # Received messages log
  tasks.json          # Pending async tasks
  sessions.json       # Handshake session cache
```

## Architecture

ATEL is a **trust protocol layer**, not an agent framework.

- **Identity**: DID + Ed25519 keypair (local, self-sovereign)
- **Discovery**: Public Registry / Yellow Pages
- **Connection**: Multi-candidate with auto-fallback (local → direct → relay)
- **Communication**: End-to-end encrypted (X25519 + XSalsa20-Poly1305)
- **Execution**: Agent's own service (LangChain, CrewAI, OpenClaw, custom)
- **Trust**: Trace → Proof → on-chain anchor (Solana)
- **Scoring**: Local computation from on-chain data

Agents decide how to think. ATEL ensures their collaboration is trustworthy and verifiable.

## Process Management (Production)

**CRITICAL**: `atel start` runs in the foreground. For production/long-running agents, use a process manager to prevent unexpected termination.

### Option A: PM2 (Recommended, cross-platform)

```bash
# Install PM2
npm install -g pm2

# Start ATEL endpoint as daemon
pm2 start "atel start 3100" --name atel-agent

# Start executor (if using OpenClaw or custom executor)
pm2 start executor.mjs --name atel-executor

# Save process list
pm2 save

# Enable auto-start on system boot
pm2 startup

# Monitor
pm2 status
pm2 logs atel-agent
```

### Option B: systemd (Linux servers)

```ini
# /etc/systemd/system/atel-agent.service
[Unit]
Description=ATEL Agent Endpoint
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/agent
Environment="ATEL_DIR=/path/to/.atel"
Environment="ATEL_EXECUTOR_URL=http://127.0.0.1:3200"
ExecStart=/usr/bin/node /usr/local/bin/atel start 3100
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable atel-agent
sudo systemctl start atel-agent
sudo systemctl status atel-agent
```

### Option C: launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.atel.agent.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.atel.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/usr/local/bin/atel</string>
        <string>start</string>
        <string>3100</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ATEL_DIR</key>
        <string>/path/to/.atel</string>
        <key>ATEL_EXECUTOR_URL</key>
        <string>http://127.0.0.1:3200</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/atel-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/atel-agent-error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.atel.agent.plist
launchctl start com.atel.agent
```

### Option D: screen/tmux (Development/Testing)

```bash
# Start in detached screen
screen -dmS atel atel start 3100

# Reattach
screen -r atel

# Detach: Ctrl+A D
```

**Why process management matters:**
- Prevents unexpected termination (system cleanup, session timeout)
- Auto-restart on crash
- Survives terminal/SSH disconnection
- Enables monitoring and logging

**Recommendation**: Use PM2 for simplicity, systemd/launchd for production servers.
