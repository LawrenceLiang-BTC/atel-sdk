#!/bin/bash
# ATEL Agent 一键设置 — 小龙虾跑这一个脚本就行
set -e

echo "🤝 ATEL Agent Setup Starting..."

# 1. 创建专用目录
mkdir -p ~/atel-workspace
cd ~/atel-workspace

# 2. 安装 SDK
if ! which atel > /dev/null 2>&1; then
  echo "📦 Installing ATEL SDK..."
  npm install -g @lawrenceliang-btc/atel-sdk
fi
echo "✅ SDK: $(which atel)"

# 3. 初始化身份
if [ ! -f .atel/identity.json ]; then
  echo "🔑 Creating identity..."
  echo 'n' | ATEL_API=https://api.atelai.org atel init my-agent
fi
DID=$(cat .atel/identity.json | python3 -c "import sys,json; print(json.load(sys.stdin)['did'])")
echo "✅ DID: $DID"

# 4. 注册
MY_IP=$(curl -s ifconfig.me 2>/dev/null || echo "127.0.0.1")
PORT=${ATEL_PORT:-3000}
echo "📡 Registering with endpoint http://${MY_IP}:${PORT}..."
ATEL_API=https://api.atelai.org atel register my-agent general "http://${MY_IP}:${PORT}" 2>&1 || true

# 5. 启动 atel start（后台）
if ! which pm2 > /dev/null 2>&1; then
  npm install -g pm2
fi
pm2 delete atel-agent 2>/dev/null || true
cd ~/atel-workspace
pm2 start "cd ~/atel-workspace && ATEL_API=https://api.atelai.org atel start ${PORT}" --name atel-agent
pm2 save 2>/dev/null || true

# 6. 等钱包部署
echo "⏳ Waiting for smart wallet deployment (30s)..."
sleep 30

# 7. 显示结果
echo ""
echo "========================================="
echo "🤝 ATEL Agent Ready!"
echo "========================================="
cd ~/atel-workspace && ATEL_API=https://api.atelai.org atel info 2>&1 | head -8
echo ""
echo "DID: $DID"
echo "Working directory: ~/atel-workspace"
echo "Background service: pm2 status atel-agent"
echo "========================================="
