/**
 * Module 7: Trust Score Client
 *
 * Local reputation scoring for agents based on on-chain proof records.
 *
 * Data source: On-chain anchored proofs (not agent self-reported summaries).
 * Each proof record is verified against the blockchain before being counted.
 *
 * Score formula (0–100):
 *   base        = success_rate × 60
 *   volume      = min(total_tasks / 100, 1) × 15
 *   risk_bonus  = (high_risk_success / total) × 15
 *   consistency = (1 − violation_rate) × 10
 *   raw         = base + volume + risk_bonus + consistency
 *
 * v2 adjustments:
 *   - early verification penalty starts at total>=3 when verified ratio < 50%
 *   - stronger penalty at total>=10 when verified ratio < 50%
 *   - cold-start caps: <5 => max 55, <10 => max 65, <20 => max 75
 */

import type { AnchorProvider, AnchorRecord } from '../anchor/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** On-chain proof record with execution metadata */
export interface OnChainProofRecord {
  /** Proof trace root (the hash anchored on-chain) */
  traceRoot: string;
  /** On-chain transaction hash */
  txHash: string;
  /** Chain identifier */
  chain: string;
  /** Executor DID */
  executor: string;
  /** Task sender DID */
  taskFrom: string;
  /** Action/task type */
  action: string;
  /** Whether the task completed successfully */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Risk level */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Number of policy violations */
  policyViolations: number;
  /** Proof ID */
  proofId: string;
  /** Anchor timestamp (from chain or local) */
  timestamp: string;
  /** Whether this record has been verified on-chain */
  verified: boolean;
}

/** Summary of a single task execution, submitted after completion */
export interface ExecutionSummary {
  /** Executor DID */
  executor: string;
  /** Task identifier */
  task_id: string;
  /** Task type (from intent.type) */
  task_type: string;
  /** Risk level of the task */
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  /** Whether the task completed successfully */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Number of tool calls made */
  tool_calls: number;
  /** Number of policy violations encountered */
  policy_violations: number;
  /** Proof bundle ID */
  proof_id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Aggregated score report for an agent */
export interface ScoreReport {
  /** Agent DID */
  agent_id: string;
  /** Computed trust score (0–100) */
  trust_score: number;
  /** Total tasks executed */
  total_tasks: number;
  /** Success rate (0–1) */
  success_rate: number;
  /** Average task duration in milliseconds */
  avg_duration_ms: number;
  /** Count of tasks per risk level */
  risk_distribution: Record<string, number>;
  /** Active risk flags */
  risk_flags: string[];
  /** Number of on-chain verified records */
  verified_count: number;
  /** ISO 8601 timestamp of last update */
  last_updated: string;
}

/** Exported data snapshot */
export interface ScoreExport {
  /** Export timestamp */
  exported_at: string;
  /** Number of agents tracked */
  agent_count: number;
  /** All execution summaries keyed by agent DID */
  summaries: Record<string, ExecutionSummary[]>;
  /** All computed score reports */
  reports: ScoreReport[];
}

// ─── Risk Flag Constants ─────────────────────────────────────────

/** Agent's success rate is below 50% */
export const FLAG_LOW_SUCCESS_RATE = 'LOW_SUCCESS_RATE';
/** Agent has at least one policy violation */
export const FLAG_HAS_VIOLATIONS = 'HAS_VIOLATIONS';
/** Agent only handles low-risk tasks (>50 tasks) */
export const FLAG_LOW_RISK_ONLY = 'LOW_RISK_ONLY';
/** More than 50% of the last 10 tasks failed */
export const FLAG_RECENT_FAILURES = 'RECENT_FAILURES';
/** Agent has no on-chain verified proofs */
export const FLAG_NO_VERIFIED_PROOFS = 'NO_VERIFIED_PROOFS';

// ─── Trust Score Client ──────────────────────────────────────────

/**
 * Local trust-score engine.
 *
 * Primary data source: on-chain proof records (OnChainProofRecord).
 * Fallback: legacy ExecutionSummary (for backward compatibility).
 *
 * Agents query another agent's on-chain proof history, then feed it
 * into this client to compute a trust score locally.
 */
export class TrustScoreClient {
  /** In-memory store: agent DID → execution summaries (legacy) */
  private readonly store: Map<string, ExecutionSummary[]> = new Map();
  /** On-chain proof records: agent DID → proof records */
  private readonly proofStore: Map<string, OnChainProofRecord[]> = new Map();
  /** Optional anchor provider for on-chain verification */
  private anchorProvider?: AnchorProvider;

  constructor(anchorProvider?: AnchorProvider) {
    this.anchorProvider = anchorProvider;
  }

  /**
   * Set the anchor provider for on-chain verification.
   */
  setAnchorProvider(provider: AnchorProvider): void {
    this.anchorProvider = provider;
  }

  /**
   * Add an on-chain proof record for an agent.
   * This is the primary data ingestion method.
   *
   * @param record - The on-chain proof record.
   */
  addProofRecord(record: OnChainProofRecord): void {
    if (!record.executor) throw new Error('OnChainProofRecord.executor is required');
    if (!record.txHash) throw new Error('OnChainProofRecord.txHash is required');

    const existing = this.proofStore.get(record.executor);
    if (existing) {
      // Deduplicate by txHash
      if (!existing.some(r => r.txHash === record.txHash)) {
        existing.push(record);
      }
    } else {
      this.proofStore.set(record.executor, [record]);
    }
  }

  /**
   * Verify an on-chain proof record against the blockchain.
   * Updates the record's verified flag.
   *
   * @param record - The record to verify.
   * @returns Whether the verification succeeded.
   */
  async verifyProofRecord(record: OnChainProofRecord): Promise<boolean> {
    if (!this.anchorProvider) return false;
    try {
      const result = await this.anchorProvider.verify(record.traceRoot, record.txHash);
      record.verified = result.valid;
      return result.valid;
    } catch {
      return false;
    }
  }

  /**
   * Verify all unverified proof records for an agent.
   *
   * @param agentId - The agent's DID.
   * @returns Number of newly verified records.
   */
  async verifyAllRecords(agentId: string): Promise<number> {
    const records = this.proofStore.get(agentId);
    if (!records) return 0;
    let verified = 0;
    for (const r of records) {
      if (!r.verified) {
        const ok = await this.verifyProofRecord(r);
        if (ok) verified++;
      }
    }
    return verified;
  }

  /**
   * Submit an execution summary (legacy method, backward compatible).
   * Prefer addProofRecord() for new integrations.
   */
  submitExecutionSummary(summary: ExecutionSummary): void {
    if (!summary.executor) throw new Error('ExecutionSummary.executor is required');
    if (!summary.task_id) throw new Error('ExecutionSummary.task_id is required');
    if (summary.duration_ms < 0) throw new Error('ExecutionSummary.duration_ms must be non-negative');

    const existing = this.store.get(summary.executor);
    if (existing) {
      existing.push(summary);
    } else {
      this.store.set(summary.executor, [summary]);
    }
  }

  /**
   * Get the score report for a specific agent.
   * Uses on-chain proof records as primary source, falls back to legacy summaries.
   */
  getAgentScore(agentId: string): ScoreReport {
    const proofRecords = this.proofStore.get(agentId);

    // If we have on-chain proof records, use them (primary source)
    if (proofRecords && proofRecords.length > 0) {
      return this.computeScoreFromProofs(agentId, proofRecords);
    }

    // Fallback to legacy summaries
    const summaries = this.store.get(agentId);
    if (summaries && summaries.length > 0) {
      return this.computeScoreFromSummaries(agentId, summaries);
    }

    return {
      agent_id: agentId,
      trust_score: 0,
      total_tasks: 0,
      success_rate: 0,
      avg_duration_ms: 0,
      risk_distribution: {},
      risk_flags: [],
      verified_count: 0,
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Get score reports for all tracked agents.
   */
  getAllScores(): ScoreReport[] {
    const agentIds = new Set([...this.proofStore.keys(), ...this.store.keys()]);
    return [...agentIds].map(id => this.getAgentScore(id));
  }

  /**
   * Export all stored data as a JSON-serializable snapshot.
   */
  exportData(): ScoreExport {
    const summaries: Record<string, ExecutionSummary[]> = {};
    for (const [agentId, entries] of this.store.entries()) {
      summaries[agentId] = [...entries];
    }
    return {
      exported_at: new Date().toISOString(),
      agent_count: new Set([...this.proofStore.keys(), ...this.store.keys()]).size,
      summaries,
      reports: this.getAllScores(),
    };
  }

  // ─── Score Computation Helpers ────────────────────────────────

  private applyV2Adjustments(rawScore: number, total: number, verifiedCount: number): number {
    let score = rawScore;

    // Verification penalty (v2): start earlier and increase with volume
    if (total >= 3) {
      const verifiedRatio = total > 0 ? verifiedCount / total : 0;
      if (verifiedRatio < 0.5) {
        score *= total >= 10 ? 0.7 : 0.85;
      }
    }

    // Cold-start cap (v2)
    if (total < 5) score = Math.min(score, 55);
    else if (total < 10) score = Math.min(score, 65);
    else if (total < 20) score = Math.min(score, 75);

    return score;
  }

  // ─── Score Computation from On-Chain Proofs ──────────────────

  private computeScoreFromProofs(agentId: string, records: OnChainProofRecord[]): ScoreReport {
    const total = records.length;
    const successCount = records.filter(r => r.success).length;
    const successRate = successCount / total;
    const avgDuration = records.reduce((sum, r) => sum + (r.durationMs || 0), 0) / total;
    const verifiedCount = records.filter(r => r.verified).length;

    // Risk distribution
    const riskDist: Record<string, number> = {};
    for (const r of records) {
      const level = r.riskLevel || 'low';
      riskDist[level] = (riskDist[level] ?? 0) + 1;
    }

    // Score calculation (same formula)
    const base = successRate * 60;
    const volume = Math.min(total / 100, 1) * 15;
    const highRiskSuccesses = records.filter(
      r => (r.riskLevel === 'high' || r.riskLevel === 'critical') && r.success
    ).length;
    const riskBonus = (highRiskSuccesses / total) * 15;
    const totalViolations = records.reduce((sum, r) => sum + (r.policyViolations || 0), 0);
    const violationRate = totalViolations / total;
    const consistency = (1 - Math.min(violationRate, 1)) * 10;

    const rawScore = base + volume + riskBonus + consistency;
    let score = this.applyV2Adjustments(rawScore, total, verifiedCount);
    score = Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;

    // Risk flags
    const flags: string[] = [];
    if (successRate < 0.5) flags.push(FLAG_LOW_SUCCESS_RATE);
    if (records.some(r => (r.policyViolations || 0) > 0)) flags.push(FLAG_HAS_VIOLATIONS);
    if (records.every(r => r.riskLevel === 'low') && total > 50) flags.push(FLAG_LOW_RISK_ONLY);
    const recent = records.slice(-10);
    if (recent.length >= 2 && recent.filter(r => !r.success).length / recent.length > 0.5) flags.push(FLAG_RECENT_FAILURES);
    if (verifiedCount === 0 && total > 0) flags.push(FLAG_NO_VERIFIED_PROOFS);

    return {
      agent_id: agentId,
      trust_score: score,
      total_tasks: total,
      success_rate: successRate,
      avg_duration_ms: Math.round(avgDuration),
      risk_distribution: riskDist,
      risk_flags: flags,
      verified_count: verifiedCount,
      last_updated: new Date().toISOString(),
    };
  }

  // ─── Legacy Score Computation (from self-reported summaries) ──

  private computeScoreFromSummaries(agentId: string, summaries: ExecutionSummary[]): ScoreReport {
    const total = summaries.length;
    const successCount = summaries.filter(s => s.success).length;
    const successRate = successCount / total;
    const avgDuration = summaries.reduce((sum, s) => sum + s.duration_ms, 0) / total;

    const riskDist: Record<string, number> = {};
    for (const s of summaries) {
      riskDist[s.risk_level] = (riskDist[s.risk_level] ?? 0) + 1;
    }

    const base = successRate * 60;
    const volume = Math.min(total / 100, 1) * 15;
    const highRiskSuccesses = summaries.filter(
      s => (s.risk_level === 'high' || s.risk_level === 'critical') && s.success
    ).length;
    const riskBonus = (highRiskSuccesses / total) * 15;
    const totalViolations = summaries.reduce((sum, s) => sum + s.policy_violations, 0);
    const violationRate = totalViolations / total;
    const consistency = (1 - Math.min(violationRate, 1)) * 10;
    const rawScore = base + volume + riskBonus + consistency;
    const score = Math.round(Math.min(100, Math.max(0, this.applyV2Adjustments(rawScore, total, 0))) * 100) / 100;

    const flags: string[] = [];
    if (successRate < 0.5) flags.push(FLAG_LOW_SUCCESS_RATE);
    if (summaries.some(s => s.policy_violations > 0)) flags.push(FLAG_HAS_VIOLATIONS);
    if (summaries.every(s => s.risk_level === 'low') && total > 50) flags.push(FLAG_LOW_RISK_ONLY);
    const recent = summaries.slice(-10);
    if (recent.length >= 2 && recent.filter(s => !s.success).length / recent.length > 0.5) flags.push(FLAG_RECENT_FAILURES);

    return {
      agent_id: agentId,
      trust_score: score,
      total_tasks: total,
      success_rate: successRate,
      avg_duration_ms: Math.round(avgDuration),
      risk_distribution: riskDist,
      risk_flags: flags,
      verified_count: 0, // Legacy summaries have no on-chain verification
      last_updated: new Date().toISOString(),
    };
  }
}
