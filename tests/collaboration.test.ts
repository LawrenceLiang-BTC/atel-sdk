import { describe, it, expect, beforeAll } from 'vitest';
import { AgentIdentity } from '../src/identity/index.js';
import { AnchorManager, MockAnchorProvider } from '../src/anchor/index.js';
import { HandshakeManager, type Session } from '../src/handshake/index.js';
import { ProofGenerator, type ProofBundle } from '../src/proof/index.js';
import { ExecutionTrace } from '../src/trace/index.js';
import {
  CollaborationAnchor,
  type TaskDelegationData,
  type TrustScoreSnapshot,
  type DisputeEvidence,
} from '../src/collaboration/index.js';

describe('Collaboration Anchor', () => {
  let anchorManager: AnchorManager;
  let collab: CollaborationAnchor;
  const alice = new AgentIdentity({ agent_id: 'alice' });
  const bob = new AgentIdentity({ agent_id: 'bob' });

  beforeAll(() => {
    anchorManager = new AnchorManager();
    anchorManager.registerProvider(new MockAnchorProvider());
    collab = new CollaborationAnchor(anchorManager, 'mock');
  });

  it('should anchor a handshake session', async () => {
    const aliceHs = new HandshakeManager(alice);
    const bobHs = new HandshakeManager(bob);

    const initMsg = aliceHs.createInit(bob.did);
    const ackMsg = bobHs.processInit(initMsg);
    const { session } = aliceHs.processAck(ackMsg);

    const record = await collab.anchorHandshake(session);

    expect(record.type).toBe('handshake');
    expect(record.participants).toContain(alice.did);
    expect(record.participants).toContain(bob.did);
    expect(record.anchor.txHash).toBeTruthy();
  });

  it('should anchor a task delegation', async () => {
    const delegation: TaskDelegationData = {
      requestorDid: alice.did,
      executorDid: bob.did,
      taskType: 'flight_search',
      consentHash: 'abc123',
      policyHash: 'def456',
      timestamp: new Date().toISOString(),
    };

    const record = await collab.anchorTaskDelegation(delegation);

    expect(record.type).toBe('task_delegation');
    expect(record.description).toContain('flight_search');
    expect(record.anchor.txHash).toBeTruthy();
  });

  it('should anchor an execution proof', async () => {
    const trace = new ExecutionTrace('task-1', bob);
    trace.append('TOOL_CALL', { tool: 'http', input: { url: 'https://api.flights.com' } });
    trace.append('TOOL_RESULT', { tool: 'http', output: { flights: [] } });
    trace.finalize({ status: 'ok', flights: [] });

    const generator = new ProofGenerator(trace, bob);
    const proof = generator.generate('policy-hash', 'consent-hash', 'result-hash');

    const record = await collab.anchorExecutionProof(proof);

    expect(record.type).toBe('execution_proof');
    expect(record.participants).toContain(bob.did);
    expect(record.anchor.txHash).toBeTruthy();
  });

  it('should anchor trust score snapshots with chain linking', async () => {
    const snapshot1: TrustScoreSnapshot = {
      agentDid: bob.did,
      score: 75,
      completedTasks: 10,
      failedTasks: 1,
      timestamp: new Date().toISOString(),
    };

    const record1 = await collab.anchorTrustScore(snapshot1);
    expect(record1.type).toBe('trust_score');

    // Second snapshot links to first
    const snapshot2: TrustScoreSnapshot = {
      agentDid: bob.did,
      score: 80,
      completedTasks: 15,
      failedTasks: 1,
      timestamp: new Date().toISOString(),
      previousHash: record1.hash,
    };

    const record2 = await collab.anchorTrustScore(snapshot2);
    expect(record2.type).toBe('trust_score');
    expect(record2.hash).not.toBe(record1.hash);
  });

  it('should anchor dispute evidence', async () => {
    const evidence: DisputeEvidence = {
      disputeId: 'dispute-001',
      complainantDid: alice.did,
      respondentDid: bob.did,
      proofHash: 'proof-hash-123',
      delegationHash: 'delegation-hash-456',
      description: 'Task result did not match specification',
      timestamp: new Date().toISOString(),
    };

    const record = await collab.anchorDisputeEvidence(evidence);

    expect(record.type).toBe('dispute_evidence');
    expect(record.participants).toContain(alice.did);
    expect(record.participants).toContain(bob.did);
  });

  it('should anchor key rotation events', async () => {
    const record = await collab.anchorKeyRotation(bob.did, 1, 'new-key-hash-abc');

    expect(record.type).toBe('key_rotation');
    expect(record.participants).toContain(bob.did);
  });

  it('should query records by type', async () => {
    const handshakes = collab.getRecordsByType('handshake');
    expect(handshakes.length).toBeGreaterThanOrEqual(1);

    const scores = collab.getRecordsByType('trust_score');
    expect(scores.length).toBeGreaterThanOrEqual(2);
  });

  it('should query records by participant', async () => {
    const bobRecords = collab.getRecordsByParticipant(bob.did);
    expect(bobRecords.length).toBeGreaterThanOrEqual(4); // handshake, delegation, proof, score x2, key rotation
  });

  it('should verify anchors against the chain', async () => {
    const records = collab.getRecords();
    const result = await collab.verifyAnchor(records[0]);
    expect(result.valid).toBe(true);
  });
});
