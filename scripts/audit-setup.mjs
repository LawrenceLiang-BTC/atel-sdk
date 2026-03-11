#!/usr/bin/env node

/**
 * ATEL Audit Setup - 自动化审计环境配置
 * 
 * 功能：
 * 1. 检测/安装 Ollama
 * 2. 拉取审计模型 (qwen2.5:0.5b)
 * 3. 配置并发
 * 4. 验证 thinking 能力
 * 
 * 用法: atel audit-setup [--model qwen2.5:0.5b] [--parallel auto]
 */

import { execSync, spawn } from 'child_process';
import os from 'os';
import fs from 'fs';

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'qwen2.5:0.5b';
const OLLAMA_INSTALL_URL = 'https://ollama.com/install.sh';
const AUDIT_CONFIG_FILE = '.atel/audit-config.json';

// ─── Helpers ────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 300000, ...opts }).trim();
  } catch (e) {
    if (opts.allowFail) return null;
    throw e;
  }
}

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

// ─── Step 1: Detect/Install Ollama ──────────────────────────

async function ensureOllama() {
  log('\n🔍 Step 1: 检测 Ollama...');
  
  const ollamaPath = run('which ollama', { allowFail: true });
  
  if (ollamaPath) {
    const version = run('ollama --version', { allowFail: true });
    ok(`Ollama 已安装: ${version || ollamaPath}`);
    return true;
  }

  info('Ollama 未安装，正在安装...');
  
  try {
    execSync(`curl -fsSL ${OLLAMA_INSTALL_URL} | sh`, { stdio: 'inherit', timeout: 300000 });
  } catch (e) {
    // Install script may exit with error but still succeed
  }
  
  // Verify installation
  const verifyPath = run('which ollama', { allowFail: true });
  if (verifyPath) {
    ok('Ollama 安装完成');
    return true;
  } else {
    fail('Ollama 安装失败');
    return false;
  }
}

// ─── Step 2: Start Ollama Service ───────────────────────────

async function ensureOllamaService(parallel) {
  log('\n🔍 Step 2: 启动 Ollama 服务...');

  // Check if already running
  const running = run('pgrep -x ollama', { allowFail: true });
  
  if (running) {
    ok('Ollama 服务已在运行');
    // Check if concurrency is configured
    const env = run('cat /proc/' + running.split('\n')[0] + '/environ 2>/dev/null | tr "\\0" "\\n" | grep OLLAMA_NUM_PARALLEL', { allowFail: true });
    if (env) {
      info(`当前并发配置: ${env}`);
    }
    return true;
  }

  info(`启动 Ollama 服务 (并发=${parallel})...`);
  
  const child = spawn('ollama', ['serve'], {
    env: { ...process.env, OLLAMA_NUM_PARALLEL: String(parallel) },
    detached: true,
    stdio: ['ignore', fs.openSync('/tmp/ollama-audit.log', 'w'), fs.openSync('/tmp/ollama-audit.log', 'a')]
  });
  child.unref();

  // Wait for service to be ready
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const check = run('curl -s http://localhost:11434/api/version', { allowFail: true });
    if (check) {
      ok(`Ollama 服务已启动 (PID: ${child.pid}, 并发: ${parallel})`);
      return true;
    }
  }

  fail('Ollama 服务启动超时');
  return false;
}

// ─── Step 3: Pull Audit Model ───────────────────────────────

async function ensureModel(modelName) {
  log(`\n🔍 Step 3: 检测审计模型 (${modelName})...`);

  // Check if model exists
  const models = run('ollama list 2>/dev/null', { allowFail: true }) || '';
  
  if (models.includes(modelName.split(':')[0])) {
    ok(`模型 ${modelName} 已存在`);
    return true;
  }

  info(`正在拉取模型 ${modelName}...`);
  
  try {
    execSync(`ollama pull ${modelName}`, { stdio: 'inherit', timeout: 600000 });
  } catch (e) {
    // pull may throw but still succeed
  }
  
  // Verify model exists
  const verifyModels = run('ollama list 2>/dev/null', { allowFail: true }) || '';
  if (verifyModels.includes(modelName.split(':')[0])) {
    ok(`模型 ${modelName} 拉取完成`);
    return true;
  } else {
    fail(`模型 ${modelName} 拉取失败`);
    return false;
  }
}

// ─── Step 4: Detect Optimal Concurrency ─────────────────────

function detectOptimalConcurrency() {
  const cpuCores = os.cpus().length;
  const totalMemGB = Math.floor(os.totalmem() / 1024 / 1024 / 1024);
  const freeMemGB = Math.floor(os.freemem() / 1024 / 1024 / 1024);
  
  // Each qwen2.5:0.5b instance uses ~500MB
  const memBasedParallel = Math.floor(freeMemGB / 0.5);
  const recommended = Math.max(1, Math.min(cpuCores, memBasedParallel));

  return { cpuCores, totalMemGB, freeMemGB, recommended };
}

// ─── Step 5: Verify Thinking Capability ─────────────────────

async function verifyThinkingCapability(modelName) {
  log('\n🔍 Step 5: 验证 thinking 能力...');

  const testPrompt = '请一步一步思考：1+1等于几？要求：先分析问题，再给出答案。';
  
  try {
    const result = run(`echo '${testPrompt}' | ollama run ${modelName} 2>/dev/null`, { timeout: 30000 });
    
    // Check if response contains step-by-step reasoning
    const hasSteps = result && (
      result.includes('步') ||
      result.includes('Step') ||
      result.includes('step') ||
      result.includes('首先') ||
      result.includes('然后') ||
      result.includes('所以') ||
      result.includes('因此') ||
      result.includes('1.') ||
      result.includes('分析')
    );
    
    const hasConclusion = result && (
      result.includes('2') ||
      result.includes('二') ||
      result.includes('答案')
    );

    // Build evidence record
    const evidence = {
      testPrompt,
      modelResponse: result || '',
      responseLength: result?.length || 0,
      checks: {
        hasSteps,
        hasConclusion,
        matchedPatterns: []
      },
      verdict: hasSteps && hasConclusion ? 'PASS' : 'FAIL',
      testedAt: new Date().toISOString()
    };

    // Record which patterns matched
    const stepPatterns = ['步', 'Step', 'step', '首先', '然后', '所以', '因此', '1.', '分析'];
    const conclusionPatterns = ['2', '二', '答案'];
    for (const p of stepPatterns) {
      if (result && result.includes(p)) evidence.checks.matchedPatterns.push(`step:${p}`);
    }
    for (const p of conclusionPatterns) {
      if (result && result.includes(p)) evidence.checks.matchedPatterns.push(`conclusion:${p}`);
    }

    if (hasSteps && hasConclusion) {
      ok('模型具备 thinking 能力');
      info(`响应长度: ${result.length} 字符`);
      info(`匹配模式: ${evidence.checks.matchedPatterns.join(', ')}`);
      return { capable: true, evidence };
    } else {
      fail('模型可能不具备 thinking 能力');
      info(`响应: ${result?.substring(0, 100)}...`);
      return { capable: false, evidence };
    }
  } catch (e) {
    const evidence = {
      testPrompt,
      error: e.message,
      verdict: 'ERROR',
      testedAt: new Date().toISOString()
    };
    fail(`thinking 能力验证失败: ${e.message}`);
    return { capable: false, evidence };
  }
}

// ─── Step 6: Save Audit Config ──────────────────────────────

function saveAuditConfig(config) {
  log('\n🔍 Step 6: 保存审计配置...');
  
  const dir = '.atel';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  fs.writeFileSync(AUDIT_CONFIG_FILE, JSON.stringify(config, null, 2));
  ok(`配置已保存到 ${AUDIT_CONFIG_FILE}`);
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const modelArg = args.find((_, i, a) => a[i-1] === '--model') || DEFAULT_MODEL;
  const parallelArg = args.find((_, i, a) => a[i-1] === '--parallel');

  console.log('🦞 ATEL 审计环境自动配置');
  console.log('========================\n');

  // Load identity
  let identity = null;
  try {
    identity = JSON.parse(fs.readFileSync('.atel/identity.json', 'utf-8'));
    ok(`Agent: ${identity.agent_id} (${identity.did})`);
  } catch {
    fail('未找到 Agent 身份，请先运行: atel init');
    process.exit(1);
  }

  // Step 1: Ensure Ollama
  if (!await ensureOllama()) {
    fail('无法安装 Ollama，退出');
    process.exit(1);
  }

  // Step 4: Detect concurrency (before starting service)
  const hw = detectOptimalConcurrency();
  const parallel = parallelArg === 'auto' || !parallelArg ? hw.recommended : parseInt(parallelArg);
  
  log(`\n🔍 Step 4: 硬件检测...`);
  ok(`CPU: ${hw.cpuCores} 核`);
  ok(`内存: ${hw.totalMemGB}GB 总量, ${hw.freeMemGB}GB 可用`);
  ok(`推荐并发: ${hw.recommended} (实际使用: ${parallel})`);

  // Step 2: Start service
  if (!await ensureOllamaService(parallel)) {
    fail('无法启动 Ollama 服务，退出');
    process.exit(1);
  }

  // Step 3: Pull model
  if (!await ensureModel(modelArg)) {
    fail('无法拉取模型，退出');
    process.exit(1);
  }

  // Step 5: Verify thinking
  const thinkingResult = await verifyThinkingCapability(modelArg);

  // Step 6: Save config
  const config = {
    version: '1.0.0',
    model: modelArg,
    parallel,
    hardware: {
      cpuCores: hw.cpuCores,
      totalMemGB: hw.totalMemGB,
      freeMemGB: hw.freeMemGB
    },
    thinking: {
      capable: thinkingResult.capable,
      verifiedAt: new Date().toISOString(),
      evidence: thinkingResult.evidence || null
    },
    ollama: {
      endpoint: 'http://localhost:11434',
      logFile: '/tmp/ollama-audit.log'
    }
  };
  
  saveAuditConfig(config);

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('🎯 审计环境配置完成！\n');
  console.log(`  Agent:     ${identity.agent_id}`);
  console.log(`  模型:      ${modelArg}`);
  console.log(`  并发:      ${parallel}`);
  console.log(`  Thinking:  ${thinkingResult.capable ? '✅ 具备' : '❌ 不具备'}`);
  
  if (!thinkingResult.capable) {
    console.log('\n  ⚠️  当前模型不具备 thinking 能力，将无法通过其他 Agent 的审计！');
    console.log('  建议使用支持 thinking 的模型。');
  } else {
    console.log('\n  ✅ Agent 已准备就绪，可以通过审计接入！');
  }
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
