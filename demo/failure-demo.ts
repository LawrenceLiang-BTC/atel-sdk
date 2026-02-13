/**
 * ATEL SDK — Failure Scenarios Demo
 *
 * Demonstrates 6 failure scenarios:
 * 1. Policy Engine denies an unauthorized tool call
 * 2. Consent Token expiration
 * 3. Exceeding max call count
 * 4. Tool call failure → Trace records TASK_FAILED
 * 5. Proof verification fails after trace tampering
 * 6. Rollback execution
 */

import {
  AgentIdentity,
  mintConsentToken,
  PolicyEngine,
  ToolGateway,
  ExecutionTrace,
  ProofGenerator,
  ProofVerifier,
  computeHash,
  RollbackManager,
} from '../src/index.js';

import type {
  ConsentToken,
  GatewayPolicyEngine,
  GatewayPolicyDecision,
  GatewayProposedAction,
  TraceEvent,
} from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────

const LINE = '═'.repeat(60);
const THIN = '─'.repeat(60);

function header(scenario: number, title: string): void {
  console.log(`\n${LINE}`);
  console.log(`  Scenario ${scenario}: ${title}`);
  console.log(LINE);
}

function info(emoji: string, msg: string): void {
  console.log(`  ${emoji}  ${msg}`);
}

// ─── Policy Bridge ───────────────────────────────────────────────

class PolicyBridge implements GatewayPolicyEngine {
  private readonly engine: PolicyEngine;

  constructor(engine: PolicyEngine) {
    this.engine = engine;
  }

  evaluate(
    action: GatewayProposedAction,
    _context?: Record<string, unknown>,
  ): GatewayPolicyDecision {
    const policyAction = {
      tool: action.type,
      method: action.resource,
      dataScope: 'public_web:read',
    };

    const decision = this.engine.evaluate(policyAction);

    if (decision === 'allow') {
      this.engine.recordCall();
    }

    return {
      decision,
      reason: decision === 'deny' ? 'Policy denied this action' : undefined,
    };
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║     🚨 ATEL SDK — Failure Scenarios Demo            ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');

  const agentA = new AgentIdentity({ agent_id: 'agent-a-issuer' });
  const agentB = new AgentIdentity({ agent_id: 'agent-b-executor' });

  // ──────────────────────────────────────────────────────────────
  // Scenario 1: Policy Engine denies unauthorized tool call
  // ──────────────────────────────────────────────────────────────
  header(1, '🚫 Unauthorized Tool Call Denied by Policy');

  {
    // Consent only allows "tool:http:get", not "tool:db:write"
    const token = mintConsentToken(
      agentA.did,
      agentB.did,
      ['tool:http:get', 'data:public_web:read'],
      { max_calls: 10, ttl_sec: 3600 },
      'low',
      agentA.secretKey,
    );

    const engine = new PolicyEngine(token);
    const bridge = new PolicyBridge(engine);
    const gateway = new ToolGateway(bridge);

    // Register a tool that the consent doesn't cover
    gateway.registerTool('db.write', async () => ({ written: true }));

    try {
      await gateway.callTool({
        tool: 'db.write',
        input: { table: 'users', data: { name: 'hacker' } },
        consentToken: JSON.stringify(token),
      });
      info('❌', 'ERROR: Should have been denied!');
    } catch (err: any) {
      info('✅', `Correctly denied: ${err.message}`);
      info('📋', `Error type: ${err.constructor.name}`);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Scenario 2: Consent Token expired
  // ──────────────────────────────────────────────────────────────
  header(2, '⏰ Consent Token Expired');

  {
    // Create a token that's already expired (ttl_sec = 1, then wait)
    const token = mintConsentToken(
      agentA.did,
      agentB.did,
      ['tool:http:get', 'data:public_web:read'],
      { max_calls: 10, ttl_sec: 1 },
      'medium',
      agentA.secretKey,
    );

    // Manually expire the token by setting exp to the past
    (token as any).exp = Math.floor(Date.now() / 1000) - 10;

    const engine = new PolicyEngine(token);
    info('🔍', `Token expired: ${engine.isExpired()}`);

    const decision = engine.evaluate({
      tool: 'http',
      method: 'get',
      dataScope: 'public_web:read',
    });

    info('✅', `Policy decision for expired token: "${decision}"`);
    info('📋', 'Expired tokens are automatically denied by PolicyEngine');
  }

  // ──────────────────────────────────────────────────────────────
  // Scenario 3: Exceeding max call count
  // ──────────────────────────────────────────────────────────────
  header(3, '🔢 Exceeding Max Call Count');

  {
    const token = mintConsentToken(
      agentA.did,
      agentB.did,
      ['tool:http:get', 'data:public_web:read'],
      { max_calls: 3, ttl_sec: 3600 },
      'medium',
      agentA.secretKey,
    );

    const engine = new PolicyEngine(token);
    const bridge = new PolicyBridge(engine);
    const gateway = new ToolGateway(bridge);

    gateway.registerTool('http.get', async (input: unknown) => {
      return { data: 'response' };
    });

    for (let i = 1; i <= 4; i++) {
      try {
        const result = await gateway.callTool({
          tool: 'http.get',
          input: { url: `https://api.example.com/call-${i}` },
          consentToken: JSON.stringify(token),
        });
        info('✅', `Call ${i}: OK (remaining: ${engine.getRemainingCalls()})`);
      } catch (err: any) {
        info('🚫', `Call ${i}: DENIED — ${err.message}`);
        info('📋', `Remaining calls: ${engine.getRemainingCalls()}`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Scenario 4: Tool call failure → Trace records TASK_FAILED
  // ──────────────────────────────────────────────────────────────
  header(4, '💥 Tool Call Failure → TASK_FAILED in Trace');

  {
    const token = mintConsentToken(
      agentA.did,
      agentB.did,
      ['tool:http:get', 'data:public_web:read'],
      { max_calls: 10, ttl_sec: 3600 },
      'medium',
      agentA.secretKey,
    );

    const engine = new PolicyEngine(token);
    const bridge = new PolicyBridge(engine);
    const gateway = new ToolGateway(bridge);

    // Register a tool that always fails
    gateway.registerTool('http.get', async () => {
      throw new Error('Connection refused: api.example.com:443');
    });

    const trace = new ExecutionTrace('fail-task-001', agentB);
    trace.append('TASK_ACCEPTED', { task_id: 'fail-task-001' });

    // Call the failing tool
    const result = await gateway.callTool({
      tool: 'http.get',
      input: { url: 'https://api.example.com/data' },
      consentToken: JSON.stringify(token),
    });

    trace.append('TOOL_CALL', { tool: 'http.get' });
    trace.append('TOOL_RESULT', {
      status: result.status,
      error: (result.output as any).error,
    });

    info('🔍', `Tool call status: ${result.status}`);
    info('🔍', `Tool error: ${(result.output as any).error}`);

    // Mark trace as failed
    const failEvent = trace.fail({
      reason: 'Tool call failed',
      error: (result.output as any).error,
    });

    info('✅', `Trace marked as TASK_FAILED at seq #${failEvent.seq}`);
    info('📋', `Trace stats: ${JSON.stringify(trace.getStats().event_count)} events, failed=${trace.isFailed()}`);
  }

  // ──────────────────────────────────────────────────────────────
  // Scenario 5: Proof verification fails after tampering
  // ──────────────────────────────────────────────────────────────
  header(5, '🔓 Proof Verification Fails (Tampered Trace)');

  {
    const trace = new ExecutionTrace('tamper-task-001', agentB);
    trace.append('TASK_ACCEPTED', { task_id: 'tamper-task-001' });
    trace.append('TOOL_CALL', { tool: 'http.get', input: { url: 'https://api.example.com' } });
    trace.append('TOOL_RESULT', { result: 'sensitive data' });
    trace.finalize({ status: 'completed' });

    // Generate a valid proof
    const proofGen = new ProofGenerator(trace, agentB);
    const proof = proofGen.generate('policy-ref', 'consent-ref', 'result-ref');

    info('✅', `Proof generated: ${proof.proof_id}`);

    // Verify the valid proof first
    const validReport = ProofVerifier.verify(proof, { trace });
    info('✅', `Valid proof verification: ${validReport.valid}`);

    // Now tamper with the proof — change the trace_root
    const tamperedProof = { ...proof, trace_root: 'deadbeef0000000000000000000000000000000000000000000000000000dead' };

    const tamperedReport = ProofVerifier.verify(tamperedProof, { trace });
    info('🚫', `Tampered proof verification: ${tamperedReport.valid}`);

    for (const check of tamperedReport.checks) {
      if (!check.passed) {
        info('📋', `Failed check: ${check.name} — ${check.detail}`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Scenario 6: Rollback execution
  // ──────────────────────────────────────────────────────────────
  header(6, '⏪ Rollback Execution');

  {
    const rollback = new RollbackManager();
    const sideEffects: string[] = [];

    // Simulate creating side effects and registering compensations
    info('📝', 'Simulating side effects...');

    sideEffects.push('order-123');
    rollback.registerCompensation('Cancel order #123', async () => {
      info('   ', '↩️  Cancelling order #123...');
      const idx = sideEffects.indexOf('order-123');
      if (idx >= 0) sideEffects.splice(idx, 1);
    });
    info('   ', '→ Created order #123');

    sideEffects.push('file-report.pdf');
    rollback.registerCompensation('Delete file report.pdf', async () => {
      info('   ', '↩️  Deleting file report.pdf...');
      const idx = sideEffects.indexOf('file-report.pdf');
      if (idx >= 0) sideEffects.splice(idx, 1);
    });
    info('   ', '→ Created file report.pdf');

    sideEffects.push('notification-sent');
    rollback.registerCompensation('Retract notification', async () => {
      // This one will fail to demonstrate partial failure
      throw new Error('Cannot retract: notification already read');
    });
    info('   ', '→ Sent notification');

    info('📋', `Side effects before rollback: [${sideEffects.join(', ')}]`);
    info('📋', `Registered ${rollback.getActions().length} compensation actions`);

    // Simulate task failure → trigger rollback
    info('💥', 'Task failed! Initiating rollback...');
    console.log(`  ${THIN}`);

    const report = await rollback.rollback();

    console.log(`  ${THIN}`);
    info('📊', `Rollback report:`);
    info('   ', `Total: ${report.total} | Succeeded: ${report.succeeded} | Failed: ${report.failed}`);
    info('📋', `Side effects after rollback: [${sideEffects.join(', ')}]`);

    for (const action of report.actions) {
      const icon = action.status === 'completed' ? '✅' : '❌';
      const detail = action.error ? ` (${action.error})` : '';
      info('   ', `${icon} ${action.description}: ${action.status}${detail}`);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  🎉 All 6 failure scenarios demonstrated successfully');
  console.log(LINE);
  console.log();
  info('1️⃣ ', 'Unauthorized tool call → denied by PolicyEngine');
  info('2️⃣ ', 'Expired consent token → denied');
  info('3️⃣ ', 'Max call count exceeded → denied');
  info('4️⃣ ', 'Tool failure → TASK_FAILED recorded in trace');
  info('5️⃣ ', 'Tampered proof → verification failed');
  info('6️⃣ ', 'Rollback → compensations executed in reverse order');
  console.log();
}

main().catch((err) => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});
