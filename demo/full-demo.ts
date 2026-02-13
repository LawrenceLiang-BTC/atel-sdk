/**
 * ATEL SDK — End-to-End Demo
 *
 * Scenario: Agent A (Travel Planner) delegates to Agent B (Flight Search Expert)
 * to search for flights from SIN → HND.
 *
 * Demonstrates the complete ATEL workflow across all 7 modules.
 */

import {
  // Module 1: Identity
  AgentIdentity,
  // Module 2: Schema
  createTask,
  createCapability,
  matchTaskToCapability,
  // Module 3: Policy
  mintConsentToken,
  verifyConsentToken,
  PolicyEngine,
  // Module 4: Gateway
  ToolGateway,
  computeHash,
  // Module 5: Trace
  ExecutionTrace,
  // Module 6: Proof
  ProofGenerator,
  ProofVerifier,
  // Module 7: Score
  TrustScoreClient,
} from '../src/index.js';

import type {
  ConsentToken,
  GatewayPolicyEngine,
  GatewayPolicyDecision,
  GatewayProposedAction,
} from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────

const LINE = '═'.repeat(60);
const THIN = '─'.repeat(60);

function header(step: number, title: string): void {
  console.log(`\n${LINE}`);
  console.log(`  Step ${step}: ${title}`);
  console.log(LINE);
}

function info(emoji: string, msg: string): void {
  console.log(`  ${emoji}  ${msg}`);
}

function json(label: string, obj: unknown): void {
  console.log(`  📋 ${label}:`);
  const lines = JSON.stringify(obj, null, 2).split('\n');
  for (const line of lines) {
    console.log(`     ${line}`);
  }
}

// ─── PolicyEngine Adapter ────────────────────────────────────────
// The ToolGateway expects a GatewayPolicyEngine interface.
// We bridge the real PolicyEngine (Module 3) to that interface.

class PolicyBridge implements GatewayPolicyEngine {
  private readonly engine: PolicyEngine;

  constructor(engine: PolicyEngine) {
    this.engine = engine;
  }

  evaluate(
    action: GatewayProposedAction,
    _context?: Record<string, unknown>,
  ): GatewayPolicyDecision {
    // Map gateway action → policy ProposedAction
    const policyAction = {
      tool: action.type,
      method: action.resource,
      dataScope: 'public_web:read',
    };

    const decision = this.engine.evaluate(policyAction);

    // Record the call so the engine tracks usage
    if (decision === 'allow') {
      this.engine.recordCall();
    }

    return {
      decision,
      reason: decision === 'deny' ? 'Policy denied this action' : undefined,
    };
  }
}

// ─── Main Demo ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║        🌐 ATEL SDK — End-to-End Demo               ║');
  console.log('  ║   Agent Trust & Economics Layer Protocol            ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log();
  info('📖', 'Scenario: Agent A (Travel Planner) delegates flight search');
  info('   ', 'to Agent B (Flight Search Expert) for SIN → HND flights.');
  console.log();

  // ──────────────────────────────────────────────────────────────
  // Step 1: Create Agent Identities
  // ──────────────────────────────────────────────────────────────
  header(1, '🆔 Create Agent Identities');

  const agentA = new AgentIdentity({ agent_id: 'agent-a-travel-planner' });
  const agentB = new AgentIdentity({ agent_id: 'agent-b-flight-expert' });

  info('👤', `Agent A (Travel Planner)`);
  info('   ', `DID: ${agentA.did}`);
  info('👤', `Agent B (Flight Expert)`);
  info('   ', `DID: ${agentB.did}`);

  // ──────────────────────────────────────────────────────────────
  // Step 2: Agent B registers capabilities
  // ──────────────────────────────────────────────────────────────
  header(2, '📝 Agent B Registers Capabilities');

  const capability = createCapability({
    provider: agentB.did,
    capabilities: [
      {
        type: 'flight_search',
        description: 'Search for flights between airports',
        input_schema: {
          type: 'object',
          properties: {
            origin: { type: 'string' },
            destination: { type: 'string' },
            date: { type: 'string' },
          },
        },
        constraints: {
          max_risk_level: 'medium',
          supported_settlements: ['offchain'],
          max_cost: 0.5,
          currency: 'USD',
        },
      },
    ],
  });

  info('✅', `Capability registered: ${capability.cap_id}`);
  info('   ', `Type: flight_search`);
  info('   ', `Max risk: medium | Settlement: offchain`);

  // ──────────────────────────────────────────────────────────────
  // Step 3: Agent A creates a task
  // ──────────────────────────────────────────────────────────────
  header(3, '📋 Agent A Creates Task');

  const task = createTask({
    issuer: agentA.did,
    audience: [agentB.did],
    intent: {
      type: 'flight_search',
      goal: 'Find flights from SIN to HND on 2026-03-15',
      constraints: {
        origin: 'SIN',
        destination: 'HND',
        date: '2026-03-15',
        max_stops: 1,
        class: 'economy',
      },
    },
    risk: { level: 'medium' },
    economics: {
      max_cost: 0.3,
      currency: 'USD',
      settlement: 'offchain',
    },
    deadline: new Date(Date.now() + 3600_000).toISOString(),
  });

  info('✅', `Task created: ${task.task_id}`);
  info('   ', `Intent: ${task.intent.goal}`);
  info('   ', `Risk: ${task.risk.level} | Max cost: $${task.economics?.max_cost}`);

  // Match task to capability
  const match = matchTaskToCapability(task, capability);
  info(match.matched ? '🎯' : '❌', `Task-Capability match: ${match.matched}`);

  // ──────────────────────────────────────────────────────────────
  // Step 4: Agent A mints Consent Token for Agent B
  // ──────────────────────────────────────────────────────────────
  header(4, '🔑 Agent A Issues Consent Token');

  const consentToken: ConsentToken = mintConsentToken(
    agentA.did,
    agentB.did,
    ['tool:http:get', 'data:public_web:read'],
    { max_calls: 10, ttl_sec: 3600 },
    'medium',
    agentA.secretKey,
  );

  info('✅', 'Consent token minted');
  info('   ', `Issuer: ${consentToken.iss.slice(0, 30)}...`);
  info('   ', `Subject: ${consentToken.sub.slice(0, 30)}...`);
  info('   ', `Scopes: ${consentToken.scopes.join(', ')}`);
  info('   ', `Max calls: ${consentToken.constraints.max_calls} | TTL: ${consentToken.constraints.ttl_sec}s`);

  // Verify the token
  const tokenValid = verifyConsentToken(consentToken, agentA.publicKey);
  info(tokenValid ? '🔒' : '❌', `Token signature valid: ${tokenValid}`);

  // ──────────────────────────────────────────────────────────────
  // Step 5: Agent B creates PolicyEngine and ToolGateway
  // ──────────────────────────────────────────────────────────────
  header(5, '🛡️  Agent B Sets Up Policy & Gateway');

  const policyEngine = new PolicyEngine(consentToken);
  const bridge = new PolicyBridge(policyEngine);
  const gateway = new ToolGateway(bridge);

  info('✅', 'PolicyEngine initialized with consent token');
  info('✅', 'ToolGateway created with policy enforcement');
  info('   ', `Remaining calls: ${policyEngine.getRemainingCalls()}`);

  // ──────────────────────────────────────────────────────────────
  // Step 6: Register mock flight search tool
  // ──────────────────────────────────────────────────────────────
  header(6, '🔧 Register Flight Search Tool');

  gateway.registerTool('http.get', async (input: unknown) => {
    const req = input as { url: string };
    info('   ', `🌐 [Mock HTTP] GET ${req.url}`);

    // Simulate API latency
    await new Promise((r) => setTimeout(r, 50));

    return {
      flights: [
        {
          airline: 'Singapore Airlines',
          flight: 'SQ638',
          departure: '2026-03-15T08:30:00+08:00',
          arrival: '2026-03-15T16:15:00+09:00',
          duration: '6h45m',
          price: 580,
          currency: 'USD',
          stops: 0,
        },
        {
          airline: 'ANA',
          flight: 'NH842',
          departure: '2026-03-15T10:00:00+08:00',
          arrival: '2026-03-15T18:30:00+09:00',
          duration: '7h30m',
          price: 520,
          currency: 'USD',
          stops: 0,
        },
        {
          airline: 'Japan Airlines',
          flight: 'JL712',
          departure: '2026-03-15T14:20:00+08:00',
          arrival: '2026-03-15T22:05:00+09:00',
          duration: '6h45m',
          price: 495,
          currency: 'USD',
          stops: 0,
        },
      ],
    };
  });

  info('✅', 'Mock flight search tool registered as "http.get"');

  // ──────────────────────────────────────────────────────────────
  // Step 7: Agent B starts execution, creates trace
  // ──────────────────────────────────────────────────────────────
  header(7, '📝 Agent B Starts Execution Trace');

  const trace = new ExecutionTrace(task.task_id, agentB, {
    checkpointInterval: 10,
  });

  trace.append('TASK_ACCEPTED', {
    task_id: task.task_id,
    executor: agentB.did,
    accepted_at: new Date().toISOString(),
  });

  info('✅', `Trace started for task: ${task.task_id}`);
  info('   ', `Events: ${trace.getStats().event_count}`);

  // ──────────────────────────────────────────────────────────────
  // Step 8: Agent B calls tool through Gateway, Trace records
  // ──────────────────────────────────────────────────────────────
  header(8, '🚀 Agent B Executes Tool Call via Gateway');

  // Record policy check in trace
  trace.append('POLICY_CHECK', {
    tool: 'http.get',
    scopes: consentToken.scopes,
    decision: 'allow',
  });

  // Call the tool
  const toolResult = await gateway.callTool({
    tool: 'http.get',
    input: { url: 'https://api.flights.example.com/search?from=SIN&to=HND&date=2026-03-15' },
    consentToken: JSON.stringify(consentToken),
  });

  // Record tool call and result in trace
  trace.append('TOOL_CALL', {
    tool: 'http.get',
    input_hash: toolResult.input_hash,
  });

  trace.append('TOOL_RESULT', {
    tool: 'http.get',
    output_hash: toolResult.output_hash,
    status: toolResult.status,
    duration_ms: toolResult.duration_ms,
  });

  info('✅', `Tool call completed: status=${toolResult.status}`);
  info('   ', `Duration: ${toolResult.duration_ms}ms`);
  info('   ', `Input hash:  ${toolResult.input_hash.slice(0, 20)}...`);
  info('   ', `Output hash: ${toolResult.output_hash.slice(0, 20)}...`);

  const flights = (toolResult.output as { flights: Array<{ airline: string; flight: string; price: number; duration: string }> }).flights;
  console.log(`\n  ✈️  Found ${flights.length} flights:`);
  console.log(`  ${THIN}`);
  for (const f of flights) {
    console.log(`     ${f.airline} ${f.flight} | ${f.duration} | $${f.price}`);
  }
  console.log(`  ${THIN}`);

  info('   ', `Remaining policy calls: ${policyEngine.getRemainingCalls()}`);

  // ──────────────────────────────────────────────────────────────
  // Step 9: Agent B finalizes task, generates Proof Bundle
  // ──────────────────────────────────────────────────────────────
  header(9, '📦 Finalize Task & Generate Proof Bundle');

  const taskResult = {
    status: 'completed',
    flights_found: flights.length,
    cheapest: flights.reduce((min, f) => (f.price < min.price ? f : min), flights[0]),
    search_params: { origin: 'SIN', destination: 'HND', date: '2026-03-15' },
  };

  const traceHash = trace.finalize(taskResult);
  info('✅', `Trace finalized: ${trace.getStats().event_count} events`);
  info('   ', `Trace hash: ${traceHash.slice(0, 30)}...`);

  // Generate proof bundle
  const proofGen = new ProofGenerator(trace, agentB);
  const policyRef = computeHash(consentToken.scopes);
  const consentRef = computeHash(consentToken);
  const resultRef = computeHash(taskResult);

  const proofBundle = proofGen.generate(policyRef, consentRef, resultRef);

  info('✅', `Proof bundle generated: ${proofBundle.proof_id}`);
  info('   ', `Merkle root: ${proofBundle.trace_root.slice(0, 30)}...`);
  info('   ', `Trace length: ${proofBundle.trace_length} events`);
  info('   ', `Checkpoints: ${proofBundle.checkpoints.length}`);

  // ──────────────────────────────────────────────────────────────
  // Step 10: Agent A verifies the Proof Bundle
  // ──────────────────────────────────────────────────────────────
  header(10, '🔍 Agent A Verifies Proof Bundle');

  const verifyReport = ProofVerifier.verify(proofBundle, { trace });

  info(verifyReport.valid ? '✅' : '❌', `Proof valid: ${verifyReport.valid}`);
  info('   ', verifyReport.summary);
  console.log();
  for (const check of verifyReport.checks) {
    const icon = check.passed ? '✓' : '✗';
    console.log(`     ${icon} ${check.name}: ${check.detail ?? ''}`);
  }

  // ──────────────────────────────────────────────────────────────
  // Step 11: Submit execution summaries to TrustScoreClient
  // ──────────────────────────────────────────────────────────────
  header(11, '📊 Submit Execution Summaries');

  const scoreClient = new TrustScoreClient();
  const stats = trace.getStats();

  // Agent B's summary (the executor)
  scoreClient.submitExecutionSummary({
    executor: agentB.did,
    task_id: task.task_id,
    task_type: task.intent.type,
    risk_level: task.risk.level,
    success: true,
    duration_ms: stats.duration_ms ?? 0,
    tool_calls: stats.tool_calls,
    policy_violations: stats.policy_violations,
    proof_id: proofBundle.proof_id,
    timestamp: new Date().toISOString(),
  });

  info('✅', 'Agent B execution summary submitted');

  // Simulate a few more historical tasks for Agent B to make the score interesting
  const historicalTasks = [
    { success: true, risk: 'low' as const, violations: 0 },
    { success: true, risk: 'medium' as const, violations: 0 },
    { success: true, risk: 'high' as const, violations: 0 },
    { success: false, risk: 'medium' as const, violations: 1 },
    { success: true, risk: 'low' as const, violations: 0 },
    { success: true, risk: 'high' as const, violations: 0 },
    { success: true, risk: 'medium' as const, violations: 0 },
    { success: true, risk: 'low' as const, violations: 0 },
    { success: true, risk: 'critical' as const, violations: 0 },
  ];

  for (let i = 0; i < historicalTasks.length; i++) {
    const h = historicalTasks[i];
    scoreClient.submitExecutionSummary({
      executor: agentB.did,
      task_id: `historical-task-${i}`,
      task_type: 'flight_search',
      risk_level: h.risk,
      success: h.success,
      duration_ms: 100 + Math.floor(Math.random() * 500),
      tool_calls: 1 + Math.floor(Math.random() * 3),
      policy_violations: h.violations,
      proof_id: `proof-hist-${i}`,
      timestamp: new Date(Date.now() - (historicalTasks.length - i) * 86400_000).toISOString(),
    });
  }

  info('📈', `Added ${historicalTasks.length} historical tasks for richer scoring`);

  // ──────────────────────────────────────────────────────────────
  // Step 12: View Agent B's trust score
  // ──────────────────────────────────────────────────────────────
  header(12, '🏆 Agent B Trust Score Report');

  const report = scoreClient.getAgentScore(agentB.did);

  console.log();
  console.log(`  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  Agent: ${agentB.agent_id.padEnd(40)} │`);
  console.log(`  │  DID:   ${report.agent_id.slice(0, 40).padEnd(40)} │`);
  console.log(`  ├──────────────────────────────────────────────────┤`);
  console.log(`  │  🏅 Trust Score:   ${String(report.trust_score).padEnd(29)} │`);
  console.log(`  │  📊 Total Tasks:   ${String(report.total_tasks).padEnd(29)} │`);
  console.log(`  │  ✅ Success Rate:  ${(report.success_rate * 100).toFixed(1).padEnd(28)}% │`);
  console.log(`  │  ⏱️  Avg Duration:  ${(report.avg_duration_ms + 'ms').padEnd(29)} │`);
  console.log(`  ├──────────────────────────────────────────────────┤`);
  console.log(`  │  Risk Distribution:                              │`);
  for (const [level, count] of Object.entries(report.risk_distribution)) {
    const bar = '█'.repeat(Math.min(count * 3, 25));
    console.log(`  │    ${level.padEnd(10)} ${bar} ${count}`.padEnd(53) + '│');
  }
  console.log(`  ├──────────────────────────────────────────────────┤`);
  if (report.risk_flags.length > 0) {
    console.log(`  │  ⚠️  Risk Flags:                                 │`);
    for (const flag of report.risk_flags) {
      console.log(`  │    • ${flag}`.padEnd(53) + '│');
    }
  } else {
    console.log(`  │  ✅ No risk flags                                │`);
  }
  console.log(`  └──────────────────────────────────────────────────┘`);

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  🎉 Demo Complete — ATEL Workflow Summary');
  console.log(LINE);
  console.log();
  info('1️⃣ ', 'Identity:  Two agents created with Ed25519 DID keys');
  info('2️⃣ ', 'Schema:    Capability registered, task created & matched');
  info('3️⃣ ', 'Policy:    Consent token minted, verified, and enforced');
  info('4️⃣ ', 'Gateway:   Tool call routed through policy-checked gateway');
  info('5️⃣ ', 'Trace:     Hash-chained execution log with 5 events');
  info('6️⃣ ', 'Proof:     Merkle-tree proof bundle generated & verified');
  info('7️⃣ ', 'Score:     Trust score computed from execution history');
  console.log();
  info('🔐', 'Every step is cryptographically verifiable.');
  info('📜', 'The full execution is auditable end-to-end.');
  console.log();
}

main().catch((err) => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});
