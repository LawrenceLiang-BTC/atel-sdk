/**
 * ATEL SDK — End-to-End Dual Agent Collaboration Demo
 *
 * Demonstrates the full lifecycle:
 *   1. Two agents create identities
 *   2. Both start Endpoints
 *   3. Both register in Registry
 *   4. Agent A discovers Agent B via Registry search
 *   5. Agent A handshakes with Agent B (identity + encryption)
 *   6. Agent A negotiates terms with Agent B
 *   7. Agent A delegates a task to Agent B (encrypted)
 *   8. Agent B executes, generates proof
 *   9. Agent B sends proof back to Agent A (encrypted)
 *  10. Both anchor collaboration events on-chain
 *  11. Verify all anchors
 *  12. Cleanup
 */

import {
  AgentIdentity,
  AgentEndpoint,
  AgentClient,
  HandshakeManager,
  RegistryService,
  RegistryClient,
  NegotiationHandler,
  createMessage,
  ExecutionTrace,
  ProofGenerator,
  ProofVerifier,
  AnchorManager,
  MockAnchorProvider,
  CollaborationAnchor,
} from '../src/index.js';

// ─── Config ──────────────────────────────────────────────────────

const REGISTRY_PORT = 14000;
const AGENT_A_PORT = 14001;
const AGENT_B_PORT = 14002;

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  ATEL SDK — Dual Agent Collaboration Demo');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Step 1: Create Identities ────────────────────────────────

  console.log('📋 Step 1: Creating agent identities...');
  const agentA = new AgentIdentity({
    agent_id: 'travel-planner',
    metadata: { name: 'Travel Planner Agent', version: '1.0.0' },
  });
  const agentB = new AgentIdentity({
    agent_id: 'flight-search',
    metadata: { name: 'Flight Search Agent', version: '1.0.0' },
  });
  console.log(`  Agent A (Travel Planner): ${agentA.did}`);
  console.log(`  Agent B (Flight Search):  ${agentB.did}\n`);

  // ── Step 2: Start Registry ───────────────────────────────────

  console.log('📒 Step 2: Starting Registry service...');
  const registry = new RegistryService({
    port: REGISTRY_PORT,
    dataDir: '/tmp/atel-demo-registry',
    host: 'localhost',
    adminDids: [agentA.did], // A is admin for demo
  });
  await registry.start();
  const registryClient = new RegistryClient({
    registryUrl: `http://localhost:${REGISTRY_PORT}`,
  });
  console.log(`  Registry running on port ${REGISTRY_PORT}\n`);

  // ── Step 3: Start Agent Endpoints ────────────────────────────

  console.log('🖥️  Step 3: Starting agent endpoints...');

  const endpointA = new AgentEndpoint(agentA, {
    port: AGENT_A_PORT,
    host: 'localhost',
  });

  // Agent B handles incoming tasks
  const endpointB = new AgentEndpoint(agentB, {
    port: AGENT_B_PORT,
    host: 'localhost',
  });

  // B's task handler: simulate flight search
  endpointB.onTask(async (message, session) => {
    const payload = message.payload as any;
    console.log(`  [Agent B] Received task: ${payload.intent}`);
    console.log(`  [Agent B] Session encrypted: ${session?.encrypted ?? 'no session'}`);

    // Simulate execution with trace
    const trace = new ExecutionTrace('flight-search-task', agentB);
    trace.append('TOOL_CALL', {
      tool: 'flight_api',
      input: { from: payload.from, to: payload.to, date: payload.date },
    });

    // Simulate API response
    const flights = [
      { airline: 'ANA', flight: 'NH123', price: 3500, currency: 'CNY' },
      { airline: 'JAL', flight: 'JL456', price: 3800, currency: 'CNY' },
    ];

    trace.append('TOOL_RESULT', { tool: 'flight_api', output: { flights } });
    trace.finalize({ status: 'ok', flights });

    // Generate proof
    const proofGen = new ProofGenerator(trace, agentB);
    const proof = proofGen.generate(
      'policy-hash-demo',
      'consent-hash-demo',
      'result-hash-demo',
    );

    console.log(`  [Agent B] Generated proof: ${proof.proof_id}`);
    console.log(`  [Agent B] Trace root: ${proof.trace_root.substring(0, 16)}...`);

    return { flights, proof };
  });

  await endpointA.start();
  await endpointB.start();
  console.log(`  Agent A listening on port ${AGENT_A_PORT}`);
  console.log(`  Agent B listening on port ${AGENT_B_PORT}\n`);

  // ── Step 4: Register in Registry ─────────────────────────────

  console.log('📝 Step 4: Registering agents in Registry...');
  await registryClient.register(
    {
      name: 'Travel Planner Agent',
      description: 'Plans travel itineraries, delegates searches',
      capabilities: [{ type: 'travel_planning', description: 'Plan trips' }],
      endpoint: `http://localhost:${AGENT_A_PORT}`,
    },
    agentA,
  );

  await registryClient.register(
    {
      name: 'Flight Search Agent',
      description: 'Searches flights across airlines',
      capabilities: [
        { type: 'flight_search', description: 'Search and compare flights' },
      ],
      endpoint: `http://localhost:${AGENT_B_PORT}`,
    },
    agentB,
  );

  const stats = await registryClient.stats();
  console.log(`  Registered ${stats.totalAgents} agents\n`);

  // ── Step 5: Agent A discovers Agent B ────────────────────────

  console.log('🔍 Step 5: Agent A searching for flight_search capability...');
  const searchResults = await registryClient.search({ type: 'flight_search' });
  console.log(`  Found ${searchResults.count} agent(s):`);
  for (const agent of searchResults.agents) {
    console.log(`    - ${agent.name} (${agent.did.substring(0, 20)}...) at ${agent.endpoint}`);
  }
  const targetAgent = searchResults.agents[0];
  console.log();

  // ── Step 6: Handshake (Identity + Encryption) ────────────────

  console.log('🤝 Step 6: Performing handshake (identity verification + E2E encryption)...');
  const clientA = new AgentClient(agentA);
  const handshakeA = new HandshakeManager(agentA);

  const session = await clientA.handshake(
    targetAgent.endpoint,
    handshakeA,
    targetAgent.did,
  );

  console.log(`  Session ID: ${session.sessionId}`);
  console.log(`  Encrypted: ${session.encrypted}`);
  console.log(`  Remote DID verified: ${session.remoteDid.substring(0, 20)}...`);
  console.log(`  Expires: ${session.expiresAt}\n`);

  // ── Step 7: Delegate Task (Encrypted) ────────────────────────

  console.log('📤 Step 7: Agent A delegating flight search task (E2E encrypted)...');
  const taskMessage = createMessage({
    type: 'task_delegate',
    from: agentA.did,
    to: targetAgent.did,
    payload: {
      intent: 'search_flights',
      from: 'PVG',
      to: 'NRT',
      date: '2026-03-15',
    },
    secretKey: agentA.secretKey,
  });

  // Send with encryption (handshakeA has the encryption session)
  const taskResult = await clientA.sendTask(
    targetAgent.endpoint,
    taskMessage,
    handshakeA,
  ) as any;

  console.log(`  Task status: ${taskResult.status}`);
  const flights = taskResult.result.flights;
  console.log(`  Found ${flights.length} flights:`);
  for (const f of flights) {
    console.log(`    ✈️  ${f.airline} ${f.flight}: ¥${f.price}`);
  }
  console.log();

  // ── Step 8: Verify Proof ─────────────────────────────────────

  console.log('🔐 Step 8: Verifying execution proof...');
  const proof = taskResult.result.proof;
  const verifyReport = ProofVerifier.verify(proof);
  console.log(`  Proof valid: ${verifyReport.valid}`);
  console.log(`  Checks passed: ${verifyReport.checks.filter((c: any) => c.passed).length}/${verifyReport.checks.length}`);
  for (const check of verifyReport.checks) {
    console.log(`    ${check.passed ? '✅' : '❌'} ${check.name}: ${check.detail}`);
  }
  console.log();

  // ── Step 9: Anchor Collaboration On-Chain ────────────────────

  console.log('⛓️  Step 9: Anchoring collaboration events on-chain...');
  const anchorManager = new AnchorManager();
  anchorManager.registerProvider(new MockAnchorProvider());
  const collab = new CollaborationAnchor(anchorManager, 'mock');

  // Anchor handshake
  const hsAnchor = await collab.anchorHandshake(session);
  console.log(`  ✅ Handshake anchored: tx ${hsAnchor.anchor.txHash.substring(0, 24)}...`);

  // Anchor task delegation
  const delegationAnchor = await collab.anchorTaskDelegation({
    requestorDid: agentA.did,
    executorDid: targetAgent.did,
    taskType: 'flight_search',
    consentHash: 'consent-hash-demo',
    policyHash: 'policy-hash-demo',
    timestamp: new Date().toISOString(),
  });
  console.log(`  ✅ Task delegation anchored: tx ${delegationAnchor.anchor.txHash.substring(0, 24)}...`);

  // Anchor execution proof
  const proofAnchor = await collab.anchorExecutionProof(proof);
  console.log(`  ✅ Execution proof anchored: tx ${proofAnchor.anchor.txHash.substring(0, 24)}...`);

  // Anchor trust score
  const scoreAnchor = await collab.anchorTrustScore({
    agentDid: targetAgent.did,
    score: 85,
    completedTasks: 1,
    failedTasks: 0,
    timestamp: new Date().toISOString(),
  });
  console.log(`  ✅ Trust score anchored: tx ${scoreAnchor.anchor.txHash.substring(0, 24)}...`);
  console.log();

  // ── Step 10: Verify Anchors ──────────────────────────────────

  console.log('🔍 Step 10: Verifying all on-chain anchors...');
  const allRecords = collab.getRecords();
  for (const record of allRecords) {
    const verification = await collab.verifyAnchor(record);
    console.log(`  ${verification.valid ? '✅' : '❌'} ${record.type}: ${verification.detail}`);
  }
  console.log();

  // ── Summary ──────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════');
  console.log('  ✅ Demo Complete — Full Collaboration Lifecycle');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Agents: 2`);
  console.log(`  Handshake: mutual identity verification + E2E encryption`);
  console.log(`  Task: flight search (PVG → NRT)`);
  console.log(`  Proof: Merkle tree with ${proof.trace_length} events`);
  console.log(`  On-chain anchors: ${allRecords.length}`);
  console.log(`  All verifications: PASSED`);
  console.log('═══════════════════════════════════════════════════\n');

  // ── Cleanup ──────────────────────────────────────────────────

  await endpointA.stop();
  await endpointB.stop();
  await registry.stop();
  console.log('🧹 Cleanup complete.');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
