/**
 * Phase 0.5 demo: real external API execution via RealHttpTool.
 *
 * Runs a true network call end-to-end through:
 * delegate -> consent -> gateway -> trace -> proof -> verify
 */

import {
  ATELOrchestrator,
  RealHttpTool,
} from '../src/index.js';

async function main(): Promise<void> {
  const delegator = new ATELOrchestrator({ agentId: 'delegator-real-api' });
  const executor = new ATELOrchestrator({ agentId: 'executor-real-api' });

  const ctx = delegator.delegateTask({
    executor: executor.identity,
    intent: {
      type: 'http_fetch',
      goal: 'Fetch one post from JSONPlaceholder',
      constraints: { url: 'https://jsonplaceholder.typicode.com/posts/1' },
    },
    risk: 'low',
    scopes: ['tool:http:get', 'data:public_web:read'],
  });

  const exec = await executor.executeTask({
    task: ctx.task,
    consentToken: ctx.consentToken,
    tools: {
      'http.get': async (input: unknown) => {
        const req = input as { url: string; headers?: Record<string, string> };
        return RealHttpTool.get(req.url, req.headers);
      },
    },
    execute: async (gateway) => {
      const result = await gateway.callTool({
        tool: 'http.get',
        input: { url: 'https://jsonplaceholder.typicode.com/posts/1' },
        risk_level: 'low',
        data_scope: 'public_web:read',
      });
      return {
        status: result.status,
        response: result.output,
      };
    },
  });

  const verify = await delegator.verifyExecution(exec.proof, {
    trace: exec.trace,
  });

  console.log('Execution success:', exec.success);
  console.log('Proof valid:', verify.valid);
  console.log('Trace events:', exec.trace.getStats().event_count);
  console.log('Executor score:', verify.trustScore);
}

main().catch((err) => {
  console.error('real-api-demo failed:', err);
  process.exit(1);
});
