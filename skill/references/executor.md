# Executor Integration

The executor is how your agent processes ATEL tasks with its full capabilities. Without an executor, tasks complete in echo mode.

## Setup

```bash
ATEL_EXECUTOR_URL=http://localhost:3200 atel start 3100
```

## Protocol

1. ATEL endpoint POSTs task to executor:
```json
POST <ATEL_EXECUTOR_URL>
{
  "taskId": "ord-xxx",
  "from": "did:atel:...",
  "action": "translation",
  "payload": { "action": "translation", "text": "Hello", "target_lang": "zh" }
}
```

2. Executor responds immediately:
```json
{"status": "accepted", "taskId": "ord-xxx"}
```

3. Executor processes, then calls back:
```bash
# HTTP callback
POST http://127.0.0.1:3100/atel/v1/result
{"taskId": "ord-xxx", "result": {"translated": "你好"}, "success": true}

# Or CLI
atel result "ord-xxx" '{"translated": "你好"}'
```

4. ATEL automatically: generates Trace → Proof → anchors on-chain → encrypts → returns to sender.

## ToolGateway

When `atel start` runs, it starts a ToolGateway proxy on port+1 (e.g., 3101). All tool calls from the executor must go through this proxy to ensure trace integrity.

```
Executor → ToolGateway Proxy (port+1) → Actual Tools
                ↓
           Records TOOL_CALL + TOOL_RESULT
                ↓
           Returns complete trace
```

## Prompt Design (Critical)

DO NOT expose ATEL protocol metadata to the sub-agent. The sub-agent should only see the pure business request.

Bad:
```
You are processing an ATEL task from agent did:atel:ed25519:xxx.
Action: research. Payload: {"query": "quantum computing"}
```

Good:
```
Research the following topic and provide useful, accurate information.
What is quantum computing
```

Protocol stops at the executor boundary. Beyond that, it's just a task.

## Minimal Executor Example

```javascript
import express from 'express';
const app = express();
app.use(express.json());

const ATEL_CALLBACK = 'http://127.0.0.1:3100/atel/v1/result';

app.post('/', async (req, res) => {
  const { taskId, action, payload } = req.body;
  res.json({ status: 'accepted', taskId });

  try {
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

app.listen(3200);
```

## Process Management (Production)

`atel start` runs in foreground. For production use PM2, systemd, or launchd:

```bash
# PM2
pm2 start "atel start 3100" --name atel-agent
pm2 start executor.mjs --name atel-executor
pm2 save && pm2 startup
```
