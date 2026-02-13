/**
 * Module 7: Trust Score Client
 *
 * Local reputation scoring for agents based on execution history.
 * MVP implementation — all data stored in-memory, no network calls.
 *
 * Score formula (0–100):
 *   base        = success_rate × 60
 *   volume      = min(total_tasks / 100, 1) × 15
 *   risk_bonus  = (high_risk_success / total) × 15
 *   consistency = (1 − violation_rate) × 10
 *   final       = base + volume + risk_bonus + consistency
 */

// ─── Types ───────────────────────────────────────────────────────

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

// ─── Trust Score Client ──────────────────────────────────────────

/**
 * Local trust-score engine.
 *
 * Tracks execution summaries per agent and computes a reputation score
 * based on success rate, task volume, risk handling, and policy compliance.
 */
export class TrustScoreClient {
  /** In-memory store: agent DID → execution summaries */
  private readonly store: Map<string, ExecutionSummary[]> = new Map();

  constructor() {
    // Intentionally empty — MVP uses in-memory storage only
  }

  /**
   * Submit an execution summary and update the agent's score data.
   *
   * @param summary - The execution summary to record.
   * @throws If required fields are missing or invalid.
   */
  submitExecutionSummary(summary: ExecutionSummary): void {
    if (!summary.executor) {
      throw new Error('ExecutionSummary.executor is required');
    }
    if (!summary.task_id) {
      throw new Error('ExecutionSummary.task_id is required');
    }
    if (summary.duration_ms < 0) {
      throw new Error('ExecutionSummary.duration_ms must be non-negative');
    }

    const existing = this.store.get(summary.executor);
    if (existing) {
      existing.push(summary);
    } else {
      this.store.set(summary.executor, [summary]);
    }
  }

  /**
   * Get the score report for a specific agent.
   *
   * @param agentId - The agent's DID.
   * @returns The computed ScoreReport, or a zero-score report if unknown.
   */
  getAgentScore(agentId: string): ScoreReport {
    const summaries = this.store.get(agentId);
    if (!summaries || summaries.length === 0) {
      return {
        agent_id: agentId,
        trust_score: 0,
        total_tasks: 0,
        success_rate: 0,
        avg_duration_ms: 0,
        risk_distribution: {},
        risk_flags: [],
        last_updated: new Date().toISOString(),
      };
    }

    const totalTasks = summaries.length;
    const successCount = summaries.filter((s) => s.success).length;
    const successRate = successCount / totalTasks;
    const avgDuration =
      summaries.reduce((sum, s) => sum + s.duration_ms, 0) / totalTasks;

    // Risk distribution
    const riskDist: Record<string, number> = {};
    for (const s of summaries) {
      riskDist[s.risk_level] = (riskDist[s.risk_level] ?? 0) + 1;
    }

    const trustScore = this.calculateScore(agentId);
    const riskFlags = this.getRiskFlags(agentId);

    return {
      agent_id: agentId,
      trust_score: trustScore,
      total_tasks: totalTasks,
      success_rate: successRate,
      avg_duration_ms: Math.round(avgDuration),
      risk_distribution: riskDist,
      risk_flags: riskFlags,
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Get score reports for all tracked agents.
   *
   * @returns Array of ScoreReport objects.
   */
  getAllScores(): ScoreReport[] {
    const reports: ScoreReport[] = [];
    for (const agentId of this.store.keys()) {
      reports.push(this.getAgentScore(agentId));
    }
    return reports;
  }

  /**
   * Export all stored data as a JSON-serializable snapshot.
   *
   * @returns A ScoreExport object.
   */
  exportData(): ScoreExport {
    const summaries: Record<string, ExecutionSummary[]> = {};
    for (const [agentId, entries] of this.store.entries()) {
      summaries[agentId] = [...entries];
    }

    return {
      exported_at: new Date().toISOString(),
      agent_count: this.store.size,
      summaries,
      reports: this.getAllScores(),
    };
  }

  // ─── Internal Methods ────────────────────────────────────────

  /**
   * Calculate the trust score for an agent.
   *
   * Formula:
   *   base        = success_rate × 60
   *   volume      = min(total / 100, 1) × 15
   *   risk_bonus  = (high_risk_successes / total) × 15
   *   consistency = (1 − violation_rate) × 10
   *   score       = clamp(base + volume + risk_bonus + consistency, 0, 100)
   *
   * @param agentId - The agent's DID.
   * @returns Trust score between 0 and 100.
   */
  private calculateScore(agentId: string): number {
    const summaries = this.store.get(agentId);
    if (!summaries || summaries.length === 0) return 0;

    const total = summaries.length;
    const successCount = summaries.filter((s) => s.success).length;
    const successRate = successCount / total;

    // Base score: success rate × 60
    const base = successRate * 60;

    // Volume bonus: scales linearly up to 100 tasks
    const volume = Math.min(total / 100, 1) * 15;

    // Risk bonus: proportion of successful high/critical risk tasks
    const highRiskSuccesses = summaries.filter(
      (s) => (s.risk_level === 'high' || s.risk_level === 'critical') && s.success
    ).length;
    const riskBonus = (highRiskSuccesses / total) * 15;

    // Consistency bonus: inversely proportional to violation rate
    const totalViolations = summaries.reduce(
      (sum, s) => sum + s.policy_violations,
      0
    );
    const violationRate = totalViolations / total;
    const consistency = (1 - Math.min(violationRate, 1)) * 10;

    const score = base + volume + riskBonus + consistency;
    return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
  }

  /**
   * Detect risk flags for an agent based on their execution history.
   *
   * @param agentId - The agent's DID.
   * @returns Array of risk flag strings.
   */
  private getRiskFlags(agentId: string): string[] {
    const summaries = this.store.get(agentId);
    if (!summaries || summaries.length === 0) return [];

    const flags: string[] = [];
    const total = summaries.length;
    const successCount = summaries.filter((s) => s.success).length;
    const successRate = successCount / total;

    // LOW_SUCCESS_RATE: overall success rate below 50%
    if (successRate < 0.5) {
      flags.push(FLAG_LOW_SUCCESS_RATE);
    }

    // HAS_VIOLATIONS: any policy violations at all
    const hasViolations = summaries.some((s) => s.policy_violations > 0);
    if (hasViolations) {
      flags.push(FLAG_HAS_VIOLATIONS);
    }

    // LOW_RISK_ONLY: only low-risk tasks and more than 50
    const allLowRisk = summaries.every((s) => s.risk_level === 'low');
    if (allLowRisk && total > 50) {
      flags.push(FLAG_LOW_RISK_ONLY);
    }

    // RECENT_FAILURES: >50% failure in the last 10 tasks
    const recent = summaries.slice(-10);
    const recentFailures = recent.filter((s) => !s.success).length;
    if (recent.length >= 2 && recentFailures / recent.length > 0.5) {
      flags.push(FLAG_RECENT_FAILURES);
    }

    return flags;
  }
}
