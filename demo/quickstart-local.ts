import {
  ATELOrchestrator,
  MockAnchorProvider,
} from '../src/index.js';

async function main(): Promise<void> {
  const mock = new MockAnchorProvider();
  const delegator = new ATELOrchestrator({ agentId: 'qs-local-delegator', anchors: [mock] });
  const executor = new ATELOrchestrator({ agentId: 'qs-local-executor', anchors: [mock] });

  const delegation = delegator.delegateTask({
    executor: executor.identity,
    intent: { type: 'quickstart_local', goal: 'Validate local mode' },
    risk: 'low',
    scopes: ['tool:http:get', 'data:public_web:read'],
  });

  const execution = await executor.executeTask({
    task: delegation.task,
    consentToken: delegation.consentToken,
    tools: {
      'http.get': async () => ({ status: 200, body: { ok: true } }),
    },
    execute: async (gateway) => gateway.callTool({
      tool: 'http.get',
      input: { url: 'https://mock.local/qs' },
      risk_level: 'low',
      data_scope: 'public_web:read',
    }),
  });

  const verify = await delegator.verifyExecution(execution.proof, {
    trace: execution.trace,
    anchorChain: 'mock',
  });

  console.log(JSON.stringify({
    mode: 'local',
    success: execution.success,
    proofValid: verify.valid,
    anchor: execution.anchor,
    trustSync: execution.trustSync,
  }, null, 2));
}

main().catch((err) => {
  console.error('quickstart-local failed:', err);
  process.exit(1);
});
