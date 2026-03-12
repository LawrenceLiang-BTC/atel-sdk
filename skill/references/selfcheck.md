# Self-Check Guide

Run this right after reboot or incident:

```bash
bash skill/scripts/selfcheck.sh
```

**Note:** This script assumes PM2 is installed. If you're not using PM2, manually check:

1. **Process state:**
```bash
ps aux | grep "atel start"
ps aux | grep "executor"
```

2. **Health endpoints:**
```bash
curl -s http://127.0.0.1:3100/atel/v1/health
curl -s http://127.0.0.1:3102/health
```

3. **Port listeners:**
```bash
lsof -i :3100 -i :3101 -i :3102
```

4. **DID consistency:**
```bash
atel info
```

Interpretation:
- PASS: safe to continue
- WARN: degraded but likely recoverable quickly
- FAIL: run recovery runbook immediately
