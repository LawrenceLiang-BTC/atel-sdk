/**
 * Module: Trust Manager
 *
 * Unified trust management combining TrustScoreClient and TrustGraph.
 * Provides a single entry point for submitting execution results and
 * querying comprehensive trust information.
 */

import {
  TrustScoreClient,
  type ExecutionSummary,
  type ScoreReport,
} from '../score/index.js';
import {
  TrustGraph,
  calculateTaskWeight,
  type TrustResult,
  type InteractionRecord,
  type TaskWeightParams,
} from '../graph/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** Extended execution summary that includes issuer for graph updates */
export interface TrustSubmission extends ExecutionSummary {
  /** DID of the agent that delegated the task (issuer) */
  issuer: string;
  /** Scene/category for graph classification (defaults to task_type) */
  scene?: string;
  /** Max cost of the task (used for weight calculation) */
  max_cost?: number;
  /** Number of similar tasks previously executed (for novelty) */
  similar_task_count?: number;
}

/** Comprehensive trust query result */
export interface ComprehensiveTrust {
  /** Trust score from the graph (0–1 range, composite) */
  graphTrust: TrustResult;
  /** Score report from the score client (0–100 range) */
  scoreReport: ScoreReport;
  /** Combined trust score (normalized 0–1) */
  combinedScore: number;
}

// ─── TrustManager ────────────────────────────────────────────────

/**
 * Unified trust manager that coordinates TrustScoreClient and TrustGraph.
 *
 * Provides:
 * - `submitResult()` — updates both score and graph in one call
 * - `queryTrust()` — returns comprehensive trust combining both systems
 */
export class TrustManager {
  /** The underlying score client */
  readonly scoreClient: TrustScoreClient;
  /** The underlying trust graph */
  readonly graph: TrustGraph;

  constructor(options?: { scoreClient?: TrustScoreClient; graph?: TrustGraph }) {
    this.scoreClient = options?.scoreClient ?? new TrustScoreClient();
    this.graph = options?.graph ?? new TrustGraph();
  }

  /**
   * Submit an execution result, updating both the score client and trust graph.
   *
   * @param submission - The execution result with issuer information.
   */
  submitResult(submission: TrustSubmission): void {
    // 1. Submit to TrustScoreClient
    this.scoreClient.submitExecutionSummary(submission);

    // 2. Calculate task weight for graph
    const taskWeight = calculateTaskWeight({
      tool_calls: submission.tool_calls,
      duration_ms: submission.duration_ms,
      max_cost: submission.max_cost ?? this._estimateCost(submission.risk_level),
      risk_level: submission.risk_level,
      similar_task_count: submission.similar_task_count ?? 0,
    });

    // 3. Update TrustGraph
    this.graph.recordInteraction({
      from: submission.issuer,
      to: submission.executor,
      scene: submission.scene ?? submission.task_type,
      success: submission.success,
      task_weight: taskWeight,
      duration_ms: submission.duration_ms,
    });
  }

  /**
   * Query comprehensive trust between two agents for a given scene.
   *
   * Combines graph-based trust (composite) with score-based reputation
   * into a single normalized score.
   *
   * @param from - The querying agent's DID.
   * @param to - The target agent's DID.
   * @param scene - The scene/category to query trust for.
   * @returns Comprehensive trust information.
   */
  queryTrust(from: string, to: string, scene: string): ComprehensiveTrust {
    const graphTrust = this.graph.compositeTrust(from, to, scene);
    const scoreReport = this.scoreClient.getAgentScore(to);

    // Combine: 60% graph trust + 40% normalized score
    const normalizedScore = scoreReport.trust_score / 100;
    const combinedScore = 0.6 * graphTrust.trust_score + 0.4 * normalizedScore;

    return {
      graphTrust,
      scoreReport,
      combinedScore,
    };
  }

  /**
   * Get the score report for a specific agent.
   *
   * @param agentId - The agent's DID.
   * @returns The score report.
   */
  getAgentScore(agentId: string): ScoreReport {
    return this.scoreClient.getAgentScore(agentId);
  }

  /**
   * Get the graph trust between two agents.
   *
   * @param from - Source agent DID.
   * @param to - Target agent DID.
   * @param scene - Scene/category.
   * @returns Trust result from the graph.
   */
  getGraphTrust(from: string, to: string, scene: string): TrustResult {
    return this.graph.compositeTrust(from, to, scene);
  }

  /**
   * Estimate max_cost from risk level for weight calculation.
   */
  private _estimateCost(riskLevel: string): number {
    switch (riskLevel) {
      case 'critical': return 10;
      case 'high': return 5;
      case 'medium': return 2;
      default: return 1;
    }
  }
}
