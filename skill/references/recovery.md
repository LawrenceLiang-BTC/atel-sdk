# Recovery Runbook

## 1) Endpoint down

**With PM2:**
```bash
pm2 restart atel-agent
curl -s http://127.0.0.1:3100/atel/v1/health
```

**Without PM2:**
```bash
# Find and kill the process
lsof -i :3100 | grep LISTEN | awk '{print $2}' | xargs kill
# Restart
atel start 3100
```

## 2) Executor down

**With PM2:**
```bash
pm2 restart atel-executor
curl -s http://127.0.0.1:3102/health
```

**Without PM2:**
```bash
# Find and kill the process
lsof -i :3102 | grep LISTEN | awk '{print $2}' | xargs kill
# Restart (if using external executor)
node executor.mjs
```

## 3) Port conflict (3100/3101/3102)

```bash
lsof -i :3100 -i :3101 -i :3102
# kill stale pid
kill <PID>
```

**Then restart:**

With PM2:
```bash
pm2 restart atel-agent atel-executor
```

Without PM2:
```bash
atel start 3100
```

## 4) Relay 404 (not registered)

Symptom:
- handshake failed: Agent not registered with relay

Fix:
- ensure remote side is running `atel start` continuously
- restart local agent and verify `relay_registered` in logs

**With PM2:**
```bash
pm2 restart atel-agent
pm2 logs atel-agent --lines 80 --nostream | grep relay_registered
```

**Without PM2:**
```bash
# Stop old process
lsof -i :3100 | grep LISTEN | awk '{print $2}' | xargs kill
# Start and check logs
atel start 3100 2>&1 | tee atel-agent.log
# In another terminal, check for relay_registered
grep relay_registered atel-agent.log
```

## 5) DID mismatch after restart/reset

```bash
atel info
curl -s http://127.0.0.1:3100/atel/v1/health
```

If mismatch:
- stale old process likely bound old identity
- stop all stale atel processes and start one clean instance

```bash
# Find all atel processes
ps aux | grep atel
# Kill stale processes
kill <PID>
# Start fresh
atel start 3100
```

## 6) Empty sessions.json parse issue

```bash
[ -s .atel/sessions.json ] || echo '{}' > .atel/sessions.json
```
