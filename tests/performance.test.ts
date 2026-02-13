import { describe, it, expect } from 'vitest';
import { AgentIdentity, ExecutionTrace, mintConsentToken, PolicyEngine, ToolGateway } from '../src/index.js';

describe('performance baseline', () => {
  it('handles concurrent tool calls through gateway', async () => {
    const issuer = new AgentIdentity();
    const executor = new AgentIdentity();
    const token = mintConsentToken(
      issuer.did,
      executor.did,
      ['tool:http:get', 'data:public_web:read'],
      { max_calls: 1000, ttl_sec: 3600 },
      'medium',
      issuer.secretKey,
    );
    const gateway = new ToolGateway(new PolicyEngine(token), { defaultRiskLevel: 'low' });
    gateway.registerTool('http.get', async () => ({ ok: true }));

    const start = Date.now();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        gateway.callTool({
          tool: 'http.get',
          input: { url: `https://example.com/${i}` },
          risk_level: 'low',
          data_scope: 'public_web:read',
        }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(gateway.getCallCount()).toBe(200);
    // Non-strict guard: just ensure it does not regress into pathological slowness.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('builds and verifies a long trace', () => {
    const identity = new AgentIdentity();
    const trace = new ExecutionTrace('perf-trace', identity, { checkpointInterval: 200 });

    for (let i = 0; i < 2000; i++) {
      trace.append('TOOL_CALL', { i, tool: 'noop' });
      trace.append('TOOL_RESULT', { i, status: 'ok' });
    }
    trace.finalize({ status: 'done' });

    const result = trace.verify();
    expect(result.valid).toBe(true);
    // 2000 TOOL_CALL + 2000 TOOL_RESULT + 1 TASK_RESULT + auto CHECKPOINTs
    expect(trace.getStats().event_count).toBeGreaterThanOrEqual(4001);
  });
});
