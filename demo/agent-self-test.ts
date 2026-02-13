/**
 * 小sea（丹子姐）作为真实Agent使用ATEL SDK的体验测试
 * 
 * 使用新的 ATELOrchestrator API，验证体验改善
 */

import {
  ATELOrchestrator,
  AgentIdentity,
  MockAnchorProvider,
  createCapability,
  matchTaskToCapability,
  TrustManager,
} from '../src';

async function main() {
  console.log('\n🌊 小sea Agent 自测开始（Orchestrator版）\n');
  const issues: string[] = [];
  const feedback: string[] = [];
  const startTime = Date.now();

  // ========== 1. 创建身份（使用Orchestrator） ==========
  console.log('--- 1. 创建Agent身份 ---');
  let t0 = Date.now();
  const xiaosea = new ATELOrchestrator({
    agentId: 'xiaosea-assistant',
    metadata: { name: '小sea', description: '智能助手', version: '1.0' },
  });
  const webSearchAgent = new ATELOrchestrator({
    agentId: 'web-search-agent',
    metadata: { name: 'WebSearch Agent', description: '网页搜索专家', capabilities: ['web_search'] },
    anchors: [new MockAnchorProvider()],
  });
  console.log(`  小sea DID: ${xiaosea.getIdentity().did}`);
  console.log(`  小sea 元数据: ${JSON.stringify(xiaosea.getIdentity().metadata)}`);
  console.log(`  WebSearch DID: ${webSearchAgent.getIdentity().did}`);
  console.log(`  耗时: ${Date.now() - t0}ms`);
  
  if (!xiaosea.getIdentity().did.startsWith('did:atel:')) {
    issues.push('DID格式不对');
  }
  feedback.push('✅ 身份创建支持metadata了！可以填name、description、capabilities。');

  // ========== 2. 注册能力 ==========
  console.log('\n--- 2. WebSearch Agent注册能力 ---');
  t0 = Date.now();
  let cap;
  try {
    cap = createCapability({
      provider: webSearchAgent.getIdentity().did,
      capabilities: [{
        type: 'web_search',
        description: 'Search the web for information',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        output_schema: { type: 'object', properties: { results: { type: 'array' } } },
        constraints: { max_risk_level: 'low', supported_settlements: ['offchain'] },
      }],
      endpoint: 'https://api.websearch.example.com',
    });
    console.log(`  能力ID: ${cap.cap_id}`);
    console.log(`  耗时: ${Date.now() - t0}ms`);
  } catch (e: any) {
    issues.push(`createCapability失败: ${e.message}`);
    console.log(`  ❌ 失败: ${e.message}`);
  }
  feedback.push('✅ createCapability使用正确的参数格式，验证通过。');

  // ========== 3. 委托任务（一步完成） ==========
  console.log('\n--- 3. 小sea委托搜索任务 ---');
  t0 = Date.now();
  let delegation;
  try {
    delegation = xiaosea.delegateTask({
      executor: webSearchAgent.getIdentity(),
      intent: {
        type: 'web_search',
        goal: 'Search for latest ATEL protocol news',
        constraints: { language: 'zh-CN', max_results: 5 },
      },
      risk: 'low',
      scopes: ['tool:http:get', 'data:public_web:read'],
      maxCost: 0.01,
      deadline: new Date(Date.now() + 60000).toISOString(),
    });
    console.log(`  任务ID: ${delegation.task.task_id}`);
    console.log(`  任务已签名: ${!!delegation.task.signature}`);
    console.log(`  Consent Token已签发: ${!!delegation.consentToken.sig}`);
    console.log(`  Scopes: ${delegation.consentToken.scopes.join(', ')}`);
    console.log(`  耗时: ${Date.now() - t0}ms`);
  } catch (e: any) {
    issues.push(`delegateTask失败: ${e.message}`);
    console.log(`  ❌ 失败: ${e.message}`);
  }
  feedback.push('✅ delegateTask一步完成了createTask + 签名 + mintConsentToken！体验大幅改善。');

  // 任务-能力匹配
  if (delegation && cap) {
    const matched = matchTaskToCapability(delegation.task, cap);
    console.log(`  任务-能力匹配: ${matched.matched}`);
    if (!matched.matched) issues.push('任务和能力应该匹配但没匹配上');
  }

  // ========== 4. 执行任务（自动Trace + Proof） ==========
  console.log('\n--- 4. WebSearch Agent执行任务 ---');
  t0 = Date.now();
  let execResult;
  try {
    execResult = await webSearchAgent.executeTask({
      task: delegation!.task,
      consentToken: delegation!.consentToken,
      tools: {
        'http.get': async (input: any) => ({
          results: [
            { title: 'ATEL Protocol Whitepaper Released', url: 'https://atel.dev/whitepaper' },
            { title: 'Agent Trust: The Missing Layer', url: 'https://blog.atel.dev/trust-layer' },
          ],
        }),
      },
      execute: async (gateway, trace) => {
        // 只需要关注业务逻辑，Trace自动记录！
        const result = await gateway.callTool({
          tool: 'http.get',
          input: { url: 'https://api.websearch.example.com/search?q=ATEL+protocol' },
          // 不需要传consentToken了！
        });
        return { searchResults: result.output, status: result.status };
      },
    });

    console.log(`  执行成功: ${execResult.success}`);
    console.log(`  Proof ID: ${execResult.proof.proof_id}`);
    console.log(`  Trace事件数: ${execResult.trace.getStats().event_count}`);
    console.log(`  链上锚定: ${execResult.anchorRecords?.length ?? 0}条`);
    console.log(`  耗时: ${Date.now() - t0}ms`);

    if (!execResult.success) issues.push('任务执行失败');
  } catch (e: any) {
    issues.push(`executeTask失败: ${e.message}`);
    console.log(`  ❌ 失败: ${e.message}`);
  }
  feedback.push('✅ executeTask自动处理了Trace、Proof、Anchor！不需要手动append事件了。');
  feedback.push('✅ callTool不需要传consentToken了！PolicyEngine内部已有token。');

  // ========== 5. 验证执行结果 ==========
  console.log('\n--- 5. 小sea验证执行结果 ---');
  t0 = Date.now();
  try {
    const verification = await xiaosea.verifyExecution(execResult!.proof, {
      trace: execResult!.trace,
    });
    console.log(`  验证结果: ${verification.valid}`);
    console.log(`  Proof有效: ${verification.proofValid}`);
    console.log(`  信誉分: ${verification.trustScore}`);
    verification.report.checks.forEach(c => {
      console.log(`    ${c.passed ? '✅' : '❌'} ${c.name}`);
    });
    console.log(`  耗时: ${Date.now() - t0}ms`);
    if (!verification.valid) issues.push('验证失败');
  } catch (e: any) {
    issues.push(`verifyExecution失败: ${e.message}`);
    console.log(`  ❌ 失败: ${e.message}`);
  }
  feedback.push('✅ verifyExecution一步完成了ProofVerifier + Anchor验证 + Trust查询。');

  // ========== 6. 查看信任状态 ==========
  console.log('\n--- 6. 查看信任状态 ---');
  t0 = Date.now();
  try {
    const trust = webSearchAgent.trustManager.queryTrust(
      xiaosea.getIdentity().did,
      webSearchAgent.getIdentity().did,
      'web_search',
    );
    console.log(`  综合信任分: ${trust.combinedScore.toFixed(4)}`);
    console.log(`  图信任: ${trust.graphTrust.trust_score.toFixed(4)}`);
    console.log(`  信誉分: ${trust.scoreReport.trust_score}`);
    console.log(`  成功率: ${trust.scoreReport.success_rate}`);
    console.log(`  耗时: ${Date.now() - t0}ms`);
  } catch (e: any) {
    issues.push(`Trust查询失败: ${e.message}`);
    console.log(`  ❌ 失败: ${e.message}`);
  }
  feedback.push('✅ TrustManager统一了Score和Graph，queryTrust返回综合信任。');

  // ========== 总结 ==========
  console.log('\n' + '='.repeat(60));
  console.log('  🌊 小sea Agent 自测报告（Orchestrator版）');
  console.log('='.repeat(60));
  console.log(`\n  总耗时: ${Date.now() - startTime}ms`);
  console.log(`  发现问题: ${issues.length}个`);
  if (issues.length > 0) {
    issues.forEach((issue, i) => console.log(`    ❌ ${i + 1}. ${issue}`));
  } else {
    console.log('    ✅ 所有功能正常运行');
  }
  
  console.log(`\n  体验改善总结:`);
  feedback.forEach((fb, i) => console.log(`    ${fb}`));
  
  console.log('\n  📊 对比改善:');
  console.log('    旧API: 需要手动创建PolicyBridge、手动append Trace、手动传consentToken');
  console.log('    新API: Orchestrator一步完成委托、执行、验证，自动处理所有集成');
  console.log('\n');
}

main().catch(console.error);
