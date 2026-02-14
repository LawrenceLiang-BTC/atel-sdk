/**
 * Module: Collaboration Anchor
 *
 * Enhanced on-chain anchoring for multi-agent collaboration scenarios.
 * Records the full lifecycle of agent collaboration on-chain:
 *
 *   1. Handshake Anchor — proves two agents established a verified session
 *   2. Task Delegation Anchor — proves a task was delegated with consent
 *   3. Execution Proof Anchor — proves task execution result (existing ProofBundle)
 *   4. Trust Score Anchor — proves trust score at a point in time
 *   5. Dispute Evidence Anchor — immutable evidence for dispute resolution
 *
 * Each anchor is a SHA-256 hash of the relevant data, stored on-chain
 * via the existing AnchorManager infrastructure.
 */

import { createHash } from 'node:crypto';
import type { AnchorManager, AnchorRecord, ChainId } from '../anchor/index.js';
import type { ProofBundle } from '../proof/index.js';
import type { Session } from '../handshake/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** Types of collaboration events that can be anchored */
export type CollaborationAnchorType =
  | 'handshake'
  | 'task_delegation'
  | 'execution_proof'
  | 'trust_score'
  | 'dispute_evidence'
  | 'key_rotation';

/** A collaboration anchor record with typed metadata */
export interface CollaborationAnchorRecord {
  /** The type of collaboration event */
  type: CollaborationAnchorType;
  /** The hash that was anchored */
  hash: string;
  /** The on-chain anchor record */
  anchor: AnchorRecord;
  /** Participants involved */
  participants: string[]; // DIDs
  /** Human-readable description */
  description: string;
  /** Timestamp of the collaboration event */
  eventTimestamp: string;
}

/** Task delegation data for anchoring */
export interface TaskDelegationData {
  /** Requestor DID */
  requestorDid: string;
  /** Executor DID */
  executorDid: string;
  /** Task type */
  taskType: string;
  /** Consent token hash */
  consentHash: string;
  /** Policy hash */
  policyHash: string;
  /** Delegation timestamp */
  timestamp: string;
  /** Negotiated terms hash (if any) */
  termsHash?: string;
}

/** Trust score snapshot for anchoring */
export interface TrustScoreSnapshot {
  /** Agent DID */
  agentDid: string;
  /** Trust score at this point */
  score: number;
  /** Number of completed tasks */
  completedTasks: number;
  /** Number of failed tasks */
  failedTasks: number;
  /** Snapshot timestamp */
  timestamp: string;
  /** Previous snapshot hash (for chain linking) */
  previousHash?: string;
}

/** Dispute evidence for anchoring */
export interface DisputeEvidence {
  /** Dispute ID */
  disputeId: string;
  /** Complainant DID */
  complainantDid: string;
  /** Respondent DID */
  respondentDid: string;
  /** Related proof bundle hash */
  proofHash: string;
  /** Related task delegation hash */
  delegationHash: string;
  /** Evidence description */
  description: string;
  /** Timestamp */
  timestamp: string;
}

// ─── Hash Helpers ────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function sortedStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(sortedStringify).join(',')}]`;
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedStringify(record[k])}`).join(',')}}`;
}

function hashObject(obj: unknown): string {
  return sha256(sortedStringify(obj));
}

// ─── Collaboration Anchor Manager ────────────────────────────────

/**
 * Manages on-chain anchoring of multi-agent collaboration events.
 *
 * Builds on top of AnchorManager to provide typed, structured
 * anchoring for the full collaboration lifecycle.
 */
export class CollaborationAnchor {
  private readonly anchorManager: AnchorManager;
  private readonly defaultChain: ChainId | string;
  private readonly records: CollaborationAnchorRecord[] = [];

  constructor(anchorManager: AnchorManager, defaultChain: ChainId | string = 'mock') {
    this.anchorManager = anchorManager;
    this.defaultChain = defaultChain;
  }

  /**
   * Anchor a handshake session establishment.
   * Proves that two agents verified each other's identity at a specific time.
   */
  async anchorHandshake(
    session: Session,
    chain?: ChainId | string,
  ): Promise<CollaborationAnchorRecord> {
    const data = {
      type: 'handshake' as const,
      sessionId: session.sessionId,
      localDid: session.localDid,
      remoteDid: session.remoteDid,
      encrypted: session.encrypted,
      createdAt: session.createdAt,
    };

    const hash = hashObject(data);
    const anchor = await this.anchorManager.anchor(hash, chain ?? this.defaultChain, {
      type: 'handshake',
      participants: [session.localDid, session.remoteDid],
    });

    const record: CollaborationAnchorRecord = {
      type: 'handshake',
      hash,
      anchor,
      participants: [session.localDid, session.remoteDid],
      description: `Handshake between ${session.localDid} and ${session.remoteDid}`,
      eventTimestamp: session.createdAt,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Anchor a task delegation event.
   * Proves that a task was delegated with specific consent and policy.
   */
  async anchorTaskDelegation(
    delegation: TaskDelegationData,
    chain?: ChainId | string,
  ): Promise<CollaborationAnchorRecord> {
    const hash = hashObject(delegation);
    const anchor = await this.anchorManager.anchor(hash, chain ?? this.defaultChain, {
      type: 'task_delegation',
      taskType: delegation.taskType,
      participants: [delegation.requestorDid, delegation.executorDid],
    });

    const record: CollaborationAnchorRecord = {
      type: 'task_delegation',
      hash,
      anchor,
      participants: [delegation.requestorDid, delegation.executorDid],
      description: `Task "${delegation.taskType}" delegated from ${delegation.requestorDid} to ${delegation.executorDid}`,
      eventTimestamp: delegation.timestamp,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Anchor an execution proof bundle.
   * Proves the result of a task execution with full Merkle proof.
   */
  async anchorExecutionProof(
    proof: ProofBundle,
    chain?: ChainId | string,
  ): Promise<CollaborationAnchorRecord> {
    // Anchor the proof_id + trace_root combination
    const hash = sha256(`${proof.proof_id}:${proof.trace_root}:${proof.executor}`);
    const anchor = await this.anchorManager.anchor(hash, chain ?? this.defaultChain, {
      type: 'execution_proof',
      proof_id: proof.proof_id,
      trace_root: proof.trace_root,
      executor: proof.executor,
      trace_length: proof.trace_length,
    });

    const record: CollaborationAnchorRecord = {
      type: 'execution_proof',
      hash,
      anchor,
      participants: [proof.executor],
      description: `Execution proof ${proof.proof_id} by ${proof.executor} (${proof.trace_length} events)`,
      eventTimestamp: proof.created_at,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Anchor a trust score snapshot.
   * Creates an immutable record of an agent's trust score at a point in time.
   * Links to previous snapshot for chain integrity.
   */
  async anchorTrustScore(
    snapshot: TrustScoreSnapshot,
    chain?: ChainId | string,
  ): Promise<CollaborationAnchorRecord> {
    const hash = hashObject(snapshot);
    const anchor = await this.anchorManager.anchor(hash, chain ?? this.defaultChain, {
      type: 'trust_score',
      agentDid: snapshot.agentDid,
      score: snapshot.score,
      previousHash: snapshot.previousHash,
    });

    const record: CollaborationAnchorRecord = {
      type: 'trust_score',
      hash,
      anchor,
      participants: [snapshot.agentDid],
      description: `Trust score ${snapshot.score} for ${snapshot.agentDid} (${snapshot.completedTasks} completed, ${snapshot.failedTasks} failed)`,
      eventTimestamp: snapshot.timestamp,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Anchor dispute evidence.
   * Creates an immutable record for dispute resolution.
   */
  async anchorDisputeEvidence(
    evidence: DisputeEvidence,
    chain?: ChainId | string,
  ): Promise<CollaborationAnchorRecord> {
    const hash = hashObject(evidence);
    const anchor = await this.anchorManager.anchor(hash, chain ?? this.defaultChain, {
      type: 'dispute_evidence',
      disputeId: evidence.disputeId,
    });

    const record: CollaborationAnchorRecord = {
      type: 'dispute_evidence',
      hash,
      anchor,
      participants: [evidence.complainantDid, evidence.respondentDid],
      description: `Dispute ${evidence.disputeId}: ${evidence.complainantDid} vs ${evidence.respondentDid}`,
      eventTimestamp: evidence.timestamp,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Anchor a key rotation event.
   * Proves that an agent rotated their encryption keys at a specific time.
   */
  async anchorKeyRotation(
    agentDid: string,
    rotationSeq: number,
    newPublicKeyHash: string,
    chain?: ChainId | string,
  ): Promise<CollaborationAnchorRecord> {
    const data = {
      type: 'key_rotation' as const,
      agentDid,
      rotationSeq,
      newPublicKeyHash,
      timestamp: new Date().toISOString(),
    };

    const hash = hashObject(data);
    const anchor = await this.anchorManager.anchor(hash, chain ?? this.defaultChain, {
      type: 'key_rotation',
      agentDid,
      rotationSeq,
    });

    const record: CollaborationAnchorRecord = {
      type: 'key_rotation',
      hash,
      anchor,
      participants: [agentDid],
      description: `Key rotation #${rotationSeq} for ${agentDid}`,
      eventTimestamp: data.timestamp,
    };

    this.records.push(record);
    return record;
  }

  // ── Query ────────────────────────────────────────────────────

  /**
   * Get all collaboration anchor records.
   */
  getRecords(): CollaborationAnchorRecord[] {
    return [...this.records];
  }

  /**
   * Get records by type.
   */
  getRecordsByType(type: CollaborationAnchorType): CollaborationAnchorRecord[] {
    return this.records.filter((r) => r.type === type);
  }

  /**
   * Get records involving a specific agent.
   */
  getRecordsByParticipant(did: string): CollaborationAnchorRecord[] {
    return this.records.filter((r) => r.participants.includes(did));
  }

  /**
   * Verify a collaboration anchor against the chain.
   */
  async verifyAnchor(
    record: CollaborationAnchorRecord,
  ): Promise<{ valid: boolean; detail: string }> {
    try {
      const verification = await this.anchorManager.verify(
        record.hash,
        record.anchor.txHash,
        record.anchor.chain,
      );
      return {
        valid: verification.valid,
        detail: verification.detail ?? (verification.valid ? 'Anchor verified on-chain' : 'Verification failed'),
      };
    } catch (err) {
      return {
        valid: false,
        detail: `Verification error: ${(err as Error).message}`,
      };
    }
  }
}
