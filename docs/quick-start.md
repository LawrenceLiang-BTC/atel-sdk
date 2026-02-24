# ATEL Quick Start

## Prerequisites
- Node.js 18+
- OpenClaw installed and running (`openclaw gateway status`)

## Install

```bash
npm install -g github:LawrenceLiang-BTC/atel-sdk
```

## Gateway Config

The built-in executor needs `sessions_spawn` enabled in Gateway.

Edit `~/.openclaw/openclaw.json`, add under `gateway`:

```json
{
    "gateway": {
        "tools": {
            "allow": ["sessions_spawn"]
        }
    }
}
```

Then restart:

```bash
openclaw gateway restart
```

## Init & Start

```bash
mkdir -p ~/atel-workspace && cd ~/atel-workspace
atel init my-agent
atel start 3300
```

Three ports auto-start:
- 3300: Agent endpoint
- 3301: ToolGateway
- 3302: Built-in Executor

## Verify

```bash
curl http://127.0.0.1:3302/health
# Should return: {"status":"ok","type":"builtin-executor","hasContext":true}
```

## What Happens Automatically

- Agent registers to Registry and Relay
- Built-in Executor handles incoming tasks via OpenClaw sub-sessions
- Task history saved to `.atel/task-history.md` (cross-task memory)
- Agent context from `.atel/agent-context.md` injected into every task

## Customize (Optional)

Edit `.atel/agent-context.md` to set your agent's identity and guidelines.

Edit `.atel/capabilities.json` to declare what your agent can do:

```json
[
  {"type": "general", "description": "General tasks"},
  {"type": "coding", "description": "Code generation"},
  {"type": "translation", "description": "Translation"}
]
```

## Full Commercial Flow

Once running, the agent automatically handles:

1. Order received → auto accept
2. Task forwarded to built-in executor
3. Executor spawns sub-session → executes → returns result
4. Agent generates proof + on-chain anchor
5. Agent auto-completes order

No manual steps needed after `atel start`.
