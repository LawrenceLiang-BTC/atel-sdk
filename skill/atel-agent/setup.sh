#!/bin/bash
# ATEL Agent 一键设置
set -euo pipefail

echo "🤝 ATEL Agent Setup Starting..."

# 1. 创建专用目录
WORKSPACE="$HOME/atel-workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# 2. 安装 SDK
if ! command -v atel &> /dev/null; then
  echo "📦 Installing ATEL SDK..."
  npm install -g @lawrenceliang-btc/atel-sdk || { echo "❌ SDK install failed"; exit 1; }
fi
echo "✅ SDK: $(command -v atel)"

# 3. 生成唯一名字
AGENT_NAME="agent-$(hostname -s 2>/dev/null || echo x)-$$"

# 4. 初始化身份
if [ ! -f .atel/identity.json ]; then
  echo "🔑 Creating identity as ${AGENT_NAME}..."
  echo 'n' | ATEL_API=https://api.atelai.org atel init "${AGENT_NAME}" || { echo "❌ Init failed"; exit 1; }
else
  echo "✅ Identity already exists"
  AGENT_NAME=$(python3 -c "import json; print(json.load(open('.atel/identity.json')).get('agent_id','agent-reuse'))" 2>/dev/null || echo "$AGENT_NAME")
fi

DID=$(python3 -c "import json; print(json.load(open('.atel/identity.json'))['did'])" 2>/dev/null || echo "unknown")
echo "✅ DID: $DID"

# 5. 注册（409 endpoint 冲突：换端口重试；409 name 冲突：换名重试）
MY_IP=$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || echo "127.0.0.1")
PORT=${ATEL_PORT:-3000}

register_agent() {
  local name="$1" port="$2"
  ATEL_API=https://api.atelai.org atel register "$name" general "http://${MY_IP}:${port}" 2>&1
}

REG_OK=0
for attempt in 1 2 3; do
  if OUTPUT=$(register_agent "$AGENT_NAME" "$PORT" 2>&1); then
    REG_OK=1
    echo "✅ Registered as ${AGENT_NAME} at port ${PORT}"
    break
  fi
  # Parse error type
  if echo "$OUTPUT" | grep -q "name already taken"; then
    AGENT_NAME="agent-$(head -c 4 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
    echo "⚠️ Name conflict, retrying as ${AGENT_NAME}..."
  elif echo "$OUTPUT" | grep -q "endpoint already registered"; then
    PORT=$((PORT + 1))
    echo "⚠️ Port ${PORT-1} conflict, trying port ${PORT}..."
  else
    echo "⚠️ Register error: $OUTPUT"
    sleep 3
  fi
done

if [ $REG_OK -eq 0 ]; then
  echo "❌ Registration failed after 3 attempts. atel start will auto-register."
fi

# 6. 安装 pm2
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2 || { echo "❌ pm2 install failed"; exit 1; }
fi

# 7. 启动 atel start（先启动，不阻塞等钱包）
pm2 delete atel-agent 2>/dev/null || true
pm2 start "cd ${WORKSPACE} && ATEL_API=https://api.atelai.org atel start ${PORT}" --name atel-agent --cwd "${WORKSPACE}" || { echo "❌ pm2 start failed"; exit 1; }
pm2 save 2>/dev/null || true

# 8. 等钱包（短等，不阻塞太久）
echo "⏳ Waiting for wallet (15s)..."
sleep 15

# 9. 显示结果
echo ""
echo "========================================="
echo "🤝 ATEL Agent Ready!"
echo "========================================="
cd "$WORKSPACE" && ATEL_API=https://api.atelai.org atel info 2>&1 | head -6 || true
echo "DID: $DID"
echo "Port: $PORT"
echo "pm2: $(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['pm2_env']['status'] if d else 'unknown')" 2>/dev/null || echo 'check: pm2 status')"
echo "========================================="
