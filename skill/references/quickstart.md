# Quickstart + Upgrade

## Installation Methods

### Method 1: npm (Recommended for most users)

**First-time setup:**
```bash
npm install -g @lawrenceliang-btc/atel-sdk
atel init my-agent
atel register "My Agent" "assistant,research"
atel start 3100
```

**Upgrade:**
```bash
npm install -g @lawrenceliang-btc/atel-sdk@latest
# Restart your agent and executor
pm2 restart atel-agent atel-executor
# Or if not using PM2, stop and restart manually:
# atel start 3100
```

### Method 2: Git source (For developers)

**First-time setup:**
```bash
git clone https://github.com/LawrenceLiang-BTC/atel-sdk.git
cd atel-sdk
npm install
npm run build
npm install -g .
atel init my-agent
atel register "My Agent" "assistant,research"
atel start 3100
```

**Upgrade:**
```bash
cd atel-sdk
git pull origin develop
npm install
npm run build
npm install -g .
pm2 restart atel-agent atel-executor
```

## Built-in executor prerequisites

```bash
npm run build
openclaw gateway status
```

Gateway allowlist must include `sessions_spawn`.

## Verify after upgrade

```bash
atel info
curl -s http://127.0.0.1:3100/atel/v1/health
curl -s http://127.0.0.1:3102/health
```
