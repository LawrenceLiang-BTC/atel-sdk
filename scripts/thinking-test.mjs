#!/usr/bin/env node

/**
 * ATEL Thinking Capability Test Suite
 * 
 * 原理：
 * 具备 thinking 能力的模型有以下特征：
 * 1. 结构化推理 - 能分步骤思考，不是直接给答案
 * 2. 逻辑连贯性 - 步骤之间有因果关系（因为→所以）
 * 3. 任务理解 - 能准确理解任务要求
 * 4. 自我纠错 - 能发现错误并修正
 * 5. 多领域泛化 - 数学、逻辑、常识都能推理
 * 
 * 检测方法：
 * 发送 5 类不同的测试 prompt，分析模型响应：
 * - 是否包含步骤标记（1. 2. 3. / 首先/然后/最后）
 * - 是否包含因果词（因为/所以/因此/由于）
 * - 是否包含正确结论
 * - 响应长度是否合理（太短=没思考）
 * 
 * 评分：每个测试 0-1 分，总分 0-5，>=3 分认定为具备 thinking 能力
 */

import { execSync } from 'child_process';

const MODEL = process.argv[2] || 'qwen2.5:0.5b';

function ollama(prompt) {
  try {
    return execSync(`echo '${prompt.replace(/'/g, "\\'")}' | ollama run ${MODEL} 2>/dev/null`, 
      { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch { return ''; }
}

// ─── 测试用例 ───────────────────────────────────────────────

const tests = [
  {
    name: '数学推理',
    category: 'math',
    prompt: '请一步一步计算：如果一个苹果3元，买5个苹果需要多少钱？',
    expectedAnswer: '15',
    stepPatterns: ['步', '首先', '然后', '所以', '1.', '2.', 'Step'],
    causalPatterns: ['因为', '所以', '因此', '等于', '='],
    minLength: 30
  },
  {
    name: '逻辑推理',
    category: 'logic',
    prompt: '请推理：小明比小红高，小红比小刚高，那么小明和小刚谁高？请说明推理过程。',
    expectedAnswer: '小明',
    stepPatterns: ['步', '首先', '然后', '所以', '因此', '推理', '比较'],
    causalPatterns: ['因为', '所以', '因此', '由于', '那么', '可以得出'],
    minLength: 40
  },
  {
    name: '常识推理',
    category: 'commonsense',
    prompt: '请思考：为什么冬天要穿厚衣服？请分析原因。',
    expectedAnswer: '冷|保暖|温度',
    stepPatterns: ['首先', '其次', '因为', '所以', '1.', '原因', '分析'],
    causalPatterns: ['因为', '所以', '因此', '由于', '导致', '为了'],
    minLength: 30
  },
  {
    name: '错误识别',
    category: 'error_detection',
    prompt: '请判断这个计算对不对：2+3=6。如果错了，请说明正确答案和原因。',
    expectedAnswer: '5|错',
    stepPatterns: ['步', '首先', '检查', '验证', '计算', '判断', '分析'],
    causalPatterns: ['因为', '所以', '因此', '实际', '正确', '错误', '应该'],
    minLength: 20
  },
  {
    name: '多步骤任务',
    category: 'multi_step',
    prompt: '请按步骤回答：把"hello world"这个字符串反转，结果是什么？请说明每一步操作。',
    expectedAnswer: 'dlrow olleh|dlrow|反转',
    stepPatterns: ['步', '首先', '然后', '最后', '1.', '2.', '操作'],
    causalPatterns: ['得到', '结果', '变成', '反转', '输出'],
    minLength: 30
  }
];

// ─── 评分函数 ───────────────────────────────────────────────

function scoreResponse(response, test) {
  if (!response || response.length < 5) {
    return { score: 0, details: { hasSteps: false, hasCausal: false, hasAnswer: false, lengthOk: false } };
  }

  // 1. 步骤标记检测
  const matchedSteps = test.stepPatterns.filter(p => response.includes(p));
  const hasSteps = matchedSteps.length >= 2;

  // 2. 因果关系检测
  const matchedCausal = test.causalPatterns.filter(p => response.includes(p));
  const hasCausal = matchedCausal.length >= 1;

  // 3. 正确答案检测
  const answerPatterns = test.expectedAnswer.split('|');
  const hasAnswer = answerPatterns.some(a => response.includes(a));

  // 4. 响应长度检测
  const lengthOk = response.length >= test.minLength;

  // 计算分数 (0-1)
  let score = 0;
  if (hasSteps) score += 0.3;
  if (hasCausal) score += 0.25;
  if (hasAnswer) score += 0.3;
  if (lengthOk) score += 0.15;

  return {
    score: Math.round(score * 100) / 100,
    details: {
      hasSteps,
      hasCausal,
      hasAnswer,
      lengthOk,
      matchedSteps,
      matchedCausal,
      responseLength: response.length
    }
  };
}

// ─── 主测试流程 ─────────────────────────────────────────────

async function main() {
  console.log(`🧪 ATEL Thinking 能力检测套件`);
  console.log(`${'='.repeat(50)}`);
  console.log(`模型: ${MODEL}`);
  console.log(`测试数量: ${tests.length}`);
  console.log(`通过阈值: 3/5 (60%)\n`);

  const results = [];
  let totalScore = 0;

  for (const test of tests) {
    console.log(`📝 测试 ${results.length + 1}: ${test.name} (${test.category})`);
    console.log(`   Prompt: ${test.prompt.substring(0, 50)}...`);
    
    const startTime = Date.now();
    const response = ollama(test.prompt);
    const duration = Date.now() - startTime;
    
    const { score, details } = scoreResponse(response, test);
    totalScore += score;

    const icon = score >= 0.7 ? '✅' : score >= 0.4 ? '⚠️' : '❌';
    console.log(`   ${icon} 得分: ${score}/1.0 (${duration}ms)`);
    console.log(`      步骤: ${details.hasSteps ? '✅' : '❌'} | 因果: ${details.hasCausal ? '✅' : '❌'} | 答案: ${details.hasAnswer ? '✅' : '❌'} | 长度: ${details.lengthOk ? '✅' : '❌'}`);
    if (details.matchedSteps?.length) console.log(`      匹配步骤词: ${details.matchedSteps.join(', ')}`);
    if (details.matchedCausal?.length) console.log(`      匹配因果词: ${details.matchedCausal.join(', ')}`);
    console.log(`      响应(前80字): ${response.substring(0, 80).replace(/\n/g, ' ')}...`);
    console.log('');

    results.push({
      name: test.name,
      category: test.category,
      prompt: test.prompt,
      response,
      score,
      details,
      duration
    });
  }

  // ─── 汇总 ─────────────────────────────────────────────────

  console.log('='.repeat(50));
  console.log('📊 测试汇总\n');

  const avgScore = totalScore / tests.length;
  const passed = totalScore >= 3;

  console.log(`   总分: ${totalScore.toFixed(2)} / ${tests.length}`);
  console.log(`   平均: ${avgScore.toFixed(2)}`);
  console.log(`   通过: ${passed ? '✅ 是' : '❌ 否'}`);
  console.log('');

  results.forEach((r, i) => {
    const icon = r.score >= 0.7 ? '✅' : r.score >= 0.4 ? '⚠️' : '❌';
    console.log(`   ${icon} ${r.name}: ${r.score}/1.0 (${r.duration}ms)`);
  });

  console.log('');
  if (passed) {
    console.log(`🎉 模型 ${MODEL} 具备 thinking 能力！`);
    console.log(`   可以接入 ATEL 审计系统。`);
  } else {
    console.log(`❌ 模型 ${MODEL} 不具备足够的 thinking 能力。`);
    console.log(`   建议使用更强的模型。`);
  }

  // ─── 输出完整证据 JSON ────────────────────────────────────

  const evidence = {
    model: MODEL,
    testSuite: 'atel-thinking-v1',
    totalTests: tests.length,
    totalScore: Math.round(totalScore * 100) / 100,
    avgScore: Math.round(avgScore * 100) / 100,
    passThreshold: 3,
    verdict: passed ? 'PASS' : 'FAIL',
    testedAt: new Date().toISOString(),
    results: results.map(r => ({
      name: r.name,
      category: r.category,
      score: r.score,
      duration: r.duration,
      details: r.details,
      prompt: r.prompt,
      response: r.response
    }))
  };

  // Save evidence
  const fs = await import('fs');
  const evidencePath = '.atel/thinking-evidence.json';
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`\n📄 完整证据已保存到: ${evidencePath}`);
}

main().catch(console.error);
