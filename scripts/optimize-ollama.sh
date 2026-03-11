#!/bin/bash

# Ollama 并发配置脚本
# 用于优化单机审计性能

set -e

echo "🚀 Ollama 并发优化配置"
echo "======================="
echo ""

# 检测 CPU 核心数
CPU_CORES=$(nproc)
echo "✅ 检测到 CPU 核心数: $CPU_CORES"

# 检测可用内存
TOTAL_MEM=$(free -g | grep Mem | awk '{print $2}')
AVAIL_MEM=$(free -g | grep Mem | awk '{print $7}')
echo "✅ 总内存: ${TOTAL_MEM}GB, 可用内存: ${AVAIL_MEM}GB"

# 计算推荐并发数
# 规则: min(CPU核心数, 可用内存GB / 0.5)
RECOMMENDED_PARALLEL=$CPU_CORES
if [ $AVAIL_MEM -lt $CPU_CORES ]; then
  RECOMMENDED_PARALLEL=$AVAIL_MEM
fi

echo ""
echo "📊 推荐配置:"
echo "   OLLAMA_NUM_PARALLEL=$RECOMMENDED_PARALLEL"
echo ""

# 询问用户
read -p "是否应用此配置? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ 已取消"
  exit 0
fi

# 停止现有 Ollama 服务
echo "⏸️  停止现有 Ollama 服务..."
pkill ollama || true
sleep 2

# 启动 Ollama 服务（带并发配置）
echo "🚀 启动 Ollama 服务（并发=$RECOMMENDED_PARALLEL）..."
OLLAMA_NUM_PARALLEL=$RECOMMENDED_PARALLEL nohup ollama serve > /tmp/ollama.log 2>&1 &

sleep 3

# 检查服务状态
if pgrep ollama > /dev/null; then
  echo "✅ Ollama 服务已启动"
  echo "📝 日志文件: /tmp/ollama.log"
  echo ""
  echo "🎯 配置完成！"
  echo "   并发能力: $RECOMMENDED_PARALLEL 个请求"
  echo "   预估处理能力: $((RECOMMENDED_PARALLEL * 10)) 个/分钟"
else
  echo "❌ Ollama 服务启动失败"
  echo "📝 查看日志: cat /tmp/ollama.log"
  exit 1
fi
