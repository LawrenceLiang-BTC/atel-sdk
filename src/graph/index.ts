/**
 * Module 8: Trust Graph
 *
 * Multi-dimensional trust graph tracking agent collaboration,
 * scene performance, and trust propagation.
 *
 * Core formulas:
 *   DirectTrust(A,B,scene) = success_weighted_rate × recency × consistency × confidence
 *   IndirectTrust(A,C)     = max path trust × hop_decay^(hops-1)
 *   CompositeTrust         = α·Direct + β·Indirect + γ·ReputationBonus
 */

// ─── Types ───────────────────────────────────────────────────────

/** Graph node representing an Agent */
export interface GraphNode {
  agent_id: string;
  registered_at: string;
  total_interactions: number;
  scenes: Set<string>;
  metadata?: Record<string, any>;
}

/** Collaboration edge between two Agents in a specific scene */
export interface GraphEdge {
  from: string;
  to: string;
  scene: string;
  total_tasks: number;
  successful_tasks: number;
  failed_tasks: number;
  total_weight: number;
  successful_weight: number;
  avg_duration_ms: number;
  last_interaction: string;
  consistency_score: number;
}

/** Trust query result */
export interface TrustResult {
  trust_score: number;
  confidence: number;
  source: 'direct' | 'indirect' | 'composite';
  path?: string[];
  details: {
    direct_trust?: number;
    indirect_trust?: number;
    reputation_bonus?: number;
  };
}

/** Parameters for task weight calculation */
export interface TaskWeightParams {
  tool_calls: number;
  duration_ms: number;
  max_cost: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  similar_task_count: number;
}

/** Interaction record for updating the graph */
export interface InteractionRecord {
  from: string;
  to: string;
  scene: string;
  success: boolean;
  task_weight: number;
  duration_ms: number;
}

// ─── Constants ───────────────────────────────────────────────────

/** Recency decay rate: exp(-λ × days). λ = 0.01 */
const LAMBDA = 0.01;
/** Tasks needed for full confidence */
const FULL_CONFIDENCE_TASKS = 20;
/** Hop decay for indirect trust: each extra hop × 0.7 */
const HOP_DECAY = 0.7;
/** Default max BFS depth for indirect trust */
const DEFAULT_MAX_DEPTH = 3;
/** Composite weights */
const ALPHA = 0.6;
const BETA = 0.3;
const GAMMA = 0.1;
/** Behavior consistency suspicion threshold */
const BCS_THRESHOLD = 0.7;
const MAX_CLUSTER_CANDIDATES = 30;
const MAX_COMBINATION_CHECKS = 5000;

const RISK_FACTOR_MAP: Record<string, number> = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
  critical: 3.0,
};

// ─── Helper: Task Weight ─────────────────────────────────────────

/**
 * Calculate task weight from execution parameters.
 *
 * Formula:
 *   task_weight = complexity × value × risk × novelty
 *
 * Where:
 *   complexity = min(1, tool_calls × 0.2 + duration_ms / 10000 × 0.3)
 *   value      = min(1, max_cost / 10)
 *   risk       = {low:0.5, medium:1.0, high:2.0, critical:3.0}
 *   novelty    = 1 / (1 + ln(1 + similar_task_count))
 *
 * Example: tool_calls=5, duration_ms=8000, max_cost=5, risk='medium', similar=2
 *   complexity = min(1, 5×0.2 + 0.8×0.3) = min(1, 1.24) = 1
 *   value      = min(1, 0.5) = 0.5
 *   risk       = 1.0
 *   novelty    = 1/(1+ln(3)) ≈ 0.476
 *   weight     = 1 × 0.5 × 1.0 × 0.476 ≈ 0.238
 */
export function calculateTaskWeight(params: TaskWeightParams): number {
  const { tool_calls, duration_ms, max_cost, risk_level, similar_task_count } = params;

  const complexity = Math.min(1, tool_calls * 0.2 + (duration_ms / 10000) * 0.3);
  const value = Math.min(1, max_cost / 10);
  const risk = RISK_FACTOR_MAP[risk_level] ?? 1.0;
  const novelty = 1.0 / (1 + Math.log(1 + similar_task_count));

  return complexity * value * risk * novelty;
}

// ─── Helper: Edge key ────────────────────────────────────────────

function edgeKey(from: string, to: string, scene: string): string {
  return `${from}:${to}:${scene}`;
}

// ─── TrustGraph Class ────────────────────────────────────────────

/**
 * Multi-dimensional trust graph.
 *
 * Nodes = agents, edges = per-scene collaboration records.
 * Supports direct, indirect, and composite trust queries,
 * anomaly detection, and graph export.
 */
export class TrustGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();

  // ── Node management ──────────────────────────────────────────

  /** Register a new agent node. Idempotent — re-adding updates metadata. */
  addNode(agentId: string, metadata?: Record<string, any>): void {
    const existing = this.nodes.get(agentId);
    if (existing) {
      if (metadata) existing.metadata = { ...existing.metadata, ...metadata };
      return;
    }
    this.nodes.set(agentId, {
      agent_id: agentId,
      registered_at: new Date().toISOString(),
      total_interactions: 0,
      scenes: new Set(),
      metadata,
    });
  }

  getNode(agentId: string): GraphNode | undefined {
    return this.nodes.get(agentId);
  }

  /** Remove a node and all its edges. */
  removeNode(agentId: string): void {
    this.nodes.delete(agentId);
    for (const [key, edge] of this.edges) {
      if (edge.from === agentId || edge.to === agentId) {
        this.edges.delete(key);
      }
    }
  }

  // ── Edge management ──────────────────────────────────────────

  /**
   * Record a single collaboration interaction.
   * Auto-creates nodes if they don't exist.
   * Updates edge statistics and node interaction counts.
   *
   * Consistency score is maintained as a running exponential moving average
   * of success (1) / failure (0) variance across recent interactions.
   */
  recordInteraction(interaction: InteractionRecord): void {
    const { from, to, scene, success, task_weight, duration_ms } = interaction;

    // Auto-register nodes
    if (!this.nodes.has(from)) this.addNode(from);
    if (!this.nodes.has(to)) this.addNode(to);

    const fromNode = this.nodes.get(from)!;
    const toNode = this.nodes.get(to)!;
    fromNode.total_interactions++;
    toNode.total_interactions++;
    fromNode.scenes.add(scene);
    toNode.scenes.add(scene);

    const key = edgeKey(from, to, scene);
    let edge = this.edges.get(key);

    if (!edge) {
      edge = {
        from, to, scene,
        total_tasks: 0,
        successful_tasks: 0,
        failed_tasks: 0,
        total_weight: 0,
        successful_weight: 0,
        avg_duration_ms: 0,
        last_interaction: new Date().toISOString(),
        consistency_score: 1.0,
      };
      this.edges.set(key, edge);
    }

    // Update running average duration
    const totalDur = edge.avg_duration_ms * edge.total_tasks + duration_ms;
    edge.total_tasks++;
    edge.avg_duration_ms = totalDur / edge.total_tasks;

    if (success) {
      edge.successful_tasks++;
      edge.successful_weight += task_weight;
    } else {
      edge.failed_tasks++;
    }
    edge.total_weight += task_weight;
    edge.last_interaction = new Date().toISOString();

    // Update consistency: EMA of success rate stability
    const currentRate = edge.successful_tasks / edge.total_tasks;
    const deviation = Math.abs((success ? 1 : 0) - currentRate);
    edge.consistency_score = edge.consistency_score * 0.9 + (1 - deviation) * 0.1;
  }

  getEdge(from: string, to: string, scene: string): GraphEdge | undefined {
    return this.edges.get(edgeKey(from, to, scene));
  }

  /** Get all edges involving a given agent (as from or to). */
  getEdges(agentId: string): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.from === agentId || edge.to === agentId) {
        result.push(edge);
      }
    }
    return result;
  }

  // ── Trust computation ────────────────────────────────────────

  /**
   * Direct trust between two agents in a scene.
   *
   * Formula:
   *   DirectTrust = swr × recency × consistency × confidence
   *
   *   swr        = successful_weight / total_weight
   *   recency    = exp(-0.01 × days_since_last)
   *   consistency = edge.consistency_score
   *   confidence = min(1, total_tasks / 20)
   *
   * Example: swr=0.8, 10 days ago, consistency=0.9, 15 tasks
   *   recency    = exp(-0.01×10) ≈ 0.905
   *   confidence = min(1, 15/20) = 0.75
   *   trust      = 0.8 × 0.905 × 0.9 × 0.75 ≈ 0.489
   *
   * Returns trust_score=0 when no edge exists.
   */
  directTrust(from: string, to: string, scene: string): TrustResult {
    const edge = this.edges.get(edgeKey(from, to, scene));
    if (!edge || edge.total_weight === 0) {
      return { trust_score: 0, confidence: 0, source: 'direct', details: { direct_trust: 0 } };
    }

    const swr = edge.successful_weight / edge.total_weight;
    const daysSince = (Date.now() - new Date(edge.last_interaction).getTime()) / 86_400_000;
    const recency = Math.exp(-LAMBDA * daysSince);
    const consistency = edge.consistency_score;
    const confidence = Math.min(1, edge.total_tasks / FULL_CONFIDENCE_TASKS);

    const score = swr * recency * consistency * confidence;

    return {
      trust_score: score,
      confidence,
      source: 'direct',
      details: { direct_trust: score },
    };
  }

  /**
   * Indirect trust via intermediate nodes (BFS, max depth 3).
   *
   * For each path P from A to B:
   *   path_trust = ∏(DirectTrust(edge_i)) × 0.7^(|P|-1)
   *
   * Returns the strongest path.
   *
   * Example: A→M trust=0.8, M→B trust=0.7, depth=2
   *   path_trust = 0.8 × 0.7 × 0.7^(2-1) = 0.8 × 0.7 × 0.7 = 0.392
   */
  indirectTrust(from: string, to: string, scene: string, maxDepth: number = DEFAULT_MAX_DEPTH): TrustResult {
    if (from === to) {
      return { trust_score: 0, confidence: 0, source: 'indirect', details: { indirect_trust: 0 } };
    }

    // BFS to find all paths up to maxDepth
    interface QueueItem { node: string; path: string[]; trust: number; }
    const queue: QueueItem[] = [{ node: from, path: [from], trust: 1.0 }];
    let bestTrust = 0;
    let bestPath: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length > maxDepth + 1) continue;

      // Find outgoing edges for current node in this scene
      for (const edge of this.edges.values()) {
        if (edge.from !== current.node || edge.scene !== scene) continue;
        if (current.path.includes(edge.to)) continue; // no cycles

        const dt = this.directTrust(edge.from, edge.to, scene);
        const hopCount = current.path.length; // hops so far (edges = nodes - 1)
        const pathTrust = current.trust * dt.trust_score * Math.pow(HOP_DECAY, hopCount - 1);

        if (edge.to === to) {
          // Skip direct (1-hop) paths — indirect means ≥ 2 hops
          if (current.path.length >= 2 && pathTrust > bestTrust) {
            bestTrust = pathTrust;
            bestPath = [...current.path, edge.to];
          }
        } else if (current.path.length < maxDepth + 1) {
          queue.push({ node: edge.to, path: [...current.path, edge.to], trust: current.trust * dt.trust_score });
        }
      }
    }

    return {
      trust_score: bestTrust,
      confidence: bestTrust > 0 ? 0.5 : 0, // indirect trust has lower confidence
      source: 'indirect',
      path: bestPath.length > 0 ? bestPath : undefined,
      details: { indirect_trust: bestTrust },
    };
  }

  /**
   * Composite trust combining direct, indirect, and reputation.
   *
   * CompositeTrust = α×Direct + β×Indirect + γ×ReputationBonus
   *   α=0.6, β=0.3, γ=0.1
   *
   * If no direct trust exists, α's weight transfers to β:
   *   β_effective = β + α = 0.9
   *
   * ReputationBonus = global_success_rate × 0.5
   */
  compositeTrust(from: string, to: string, scene: string): TrustResult {
    const direct = this.directTrust(from, to, scene);
    const indirect = this.indirectTrust(from, to, scene);
    const repBonus = this._globalSuccessRate() * 0.5;

    let alpha = ALPHA;
    let beta = BETA;
    const gamma = GAMMA;

    // Transfer direct weight to indirect if no direct trust
    if (direct.trust_score === 0) {
      beta = beta + alpha;
      alpha = 0;
    }

    const score = alpha * direct.trust_score + beta * indirect.trust_score + gamma * repBonus;
    const confidence = Math.max(direct.confidence, indirect.confidence);

    return {
      trust_score: score,
      confidence,
      source: 'composite',
      path: indirect.path,
      details: {
        direct_trust: direct.trust_score,
        indirect_trust: indirect.trust_score,
        reputation_bonus: repBonus,
      },
    };
  }

  /** Global success rate across all edges. */
  private _globalSuccessRate(): number {
    let totalWeight = 0;
    let successWeight = 0;
    for (const edge of this.edges.values()) {
      totalWeight += edge.total_weight;
      successWeight += edge.successful_weight;
    }
    return totalWeight > 0 ? successWeight / totalWeight : 0;
  }

  // ── Queries ──────────────────────────────────────────────────

  /**
   * Scene reputation: average incoming trust for an agent in a scene.
   * Averages directTrust from all agents that have interacted with this agent.
   */
  sceneReputation(agentId: string, scene: string): number {
    const incoming: number[] = [];
    for (const edge of this.edges.values()) {
      if (edge.to === agentId && edge.scene === scene) {
        const dt = this.directTrust(edge.from, edge.to, scene);
        incoming.push(dt.trust_score);
      }
    }
    if (incoming.length === 0) return 0;
    return incoming.reduce((a, b) => a + b, 0) / incoming.length;
  }

  /** Top-K partners by composite trust (across all scenes). */
  topPartners(agentId: string, k: number): Array<{ agent_id: string; trust: number }> {
    const partnerMap = new Map<string, number>();
    for (const edge of this.edges.values()) {
      if (edge.from === agentId) {
        const dt = this.directTrust(edge.from, edge.to, edge.scene);
        const prev = partnerMap.get(edge.to) ?? 0;
        partnerMap.set(edge.to, Math.max(prev, dt.trust_score));
      }
    }
    return [...partnerMap.entries()]
      .map(([agent_id, trust]) => ({ agent_id, trust }))
      .sort((a, b) => b.trust - a.trust)
      .slice(0, k);
  }

  /** Top-K agents for a scene by reputation. */
  topAgentsForScene(scene: string, k: number): Array<{ agent_id: string; reputation: number }> {
    const agents = new Set<string>();
    for (const edge of this.edges.values()) {
      if (edge.scene === scene) agents.add(edge.to);
    }
    return [...agents]
      .map(agent_id => ({ agent_id, reputation: this.sceneReputation(agent_id, scene) }))
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, k);
  }

  /**
   * Strongest trust path from A to B (any depth up to 3).
   * Uses the same BFS as indirectTrust but also considers direct (1-hop).
   */
  strongestPath(from: string, to: string, scene: string): { path: string[]; trust: number } | null {
    if (from === to) return null;

    interface QueueItem { node: string; path: string[]; trust: number; }
    const queue: QueueItem[] = [{ node: from, path: [from], trust: 1.0 }];
    let bestTrust = 0;
    let bestPath: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length > DEFAULT_MAX_DEPTH + 1) continue;

      for (const edge of this.edges.values()) {
        if (edge.from !== current.node || edge.scene !== scene) continue;
        if (current.path.includes(edge.to)) continue;

        const dt = this.directTrust(edge.from, edge.to, scene);
        const hopCount = current.path.length;
        const pathTrust = current.trust * dt.trust_score * (hopCount > 1 ? Math.pow(HOP_DECAY, hopCount - 1) : 1);

        if (edge.to === to) {
          if (pathTrust > bestTrust) {
            bestTrust = pathTrust;
            bestPath = [...current.path, edge.to];
          }
        } else if (current.path.length < DEFAULT_MAX_DEPTH + 1) {
          queue.push({ node: edge.to, path: [...current.path, edge.to], trust: current.trust * dt.trust_score });
        }
      }
    }

    return bestPath.length > 0 ? { path: bestPath, trust: bestTrust } : null;
  }

  // ── Anomaly detection ────────────────────────────────────────

  /**
   * Behavior Consistency Score (BCS).
   *
   * BCS = 1 - (max_success_rate - min_success_rate) across all partners.
   * Suspicious if BCS < 0.7 (agent treats different partners very differently).
   */
  behaviorConsistencyScore(agentId: string): { score: number; suspicious: boolean; details: Record<string, number> } {
    const details: Record<string, number> = {};
    for (const edge of this.edges.values()) {
      if (edge.from === agentId && edge.total_tasks > 0) {
        const rate = edge.successful_tasks / edge.total_tasks;
        details[`${edge.to}:${edge.scene}`] = rate;
      }
    }

    const rates = Object.values(details);
    if (rates.length < 2) {
      return { score: 1.0, suspicious: false, details };
    }

    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const score = 1 - (maxRate - minRate);

    return { score, suspicious: score < BCS_THRESHOLD, details };
  }

  /**
   * Detect suspicious clusters (simplified Sybil detection).
   *
   * For each pair of agents, compute internal vs external interaction ratio.
   * Groups with internal_ratio >> external_ratio are suspicious.
   */
  detectSuspiciousClusters(minClusterSize: number = 3): Array<{ agents: string[]; suspicion_score: number }> {
    const agentIds = [...this.nodes.keys()];
    if (agentIds.length < minClusterSize) return [];

    // Build adjacency with interaction counts
    const interactions = new Map<string, Map<string, number>>();
    for (const edge of this.edges.values()) {
      if (!interactions.has(edge.from)) interactions.set(edge.from, new Map());
      const m = interactions.get(edge.from)!;
      m.set(edge.to, (m.get(edge.to) ?? 0) + edge.total_tasks);
    }

    const clusters: Array<{ agents: string[]; suspicion_score: number }> = [];

    // Bound the search space to avoid combinatorial explosion.
    const candidates = this._rankAgentsByActivity(agentIds).slice(0, MAX_CLUSTER_CANDIDATES);
    const combos = this._combinations(candidates, minClusterSize, MAX_COMBINATION_CHECKS);
    for (const combo of combos) {
      const comboSet = new Set(combo);
      let internal = 0;
      let external = 0;

      for (const agent of combo) {
        const neighbors = interactions.get(agent);
        if (!neighbors) continue;
        for (const [target, count] of neighbors) {
          if (comboSet.has(target)) {
            internal += count;
          } else {
            external += count;
          }
        }
      }

      const total = internal + external;
      if (total === 0) continue;

      const internalRatio = internal / total;
      // Suspicious if >80% of interactions are internal
      if (internalRatio > 0.8 && internal > minClusterSize) {
        clusters.push({ agents: combo, suspicion_score: internalRatio });
      }
    }

    return clusters.sort((a, b) => b.suspicion_score - a.suspicion_score);
  }

  /** Generate combinations of size k from array. */
  private _combinations(arr: string[], k: number, maxResults: number): string[][] {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const results: string[][] = [];
    for (let i = 0; i <= arr.length - k; i++) {
      if (results.length >= maxResults) break;
      const rest = this._combinations(arr.slice(i + 1), k - 1, maxResults - results.length);
      for (const combo of rest) {
        if (results.length >= maxResults) break;
        results.push([arr[i], ...combo]);
      }
    }
    return results;
  }

  private _rankAgentsByActivity(agentIds: string[]): string[] {
    const scores = new Map<string, number>();
    for (const id of agentIds) {
      scores.set(id, 0);
    }
    for (const edge of this.edges.values()) {
      scores.set(edge.from, (scores.get(edge.from) ?? 0) + edge.total_tasks);
      scores.set(edge.to, (scores.get(edge.to) ?? 0) + edge.total_tasks);
    }
    return [...agentIds].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  }

  // ── Export / Stats ──────────────────────────────────────────

  /** Export the full graph as plain objects (Sets converted to arrays). */
  exportGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  /** Aggregate statistics. */
  getStats(): {
    total_nodes: number;
    total_edges: number;
    total_interactions: number;
    scenes: string[];
    avg_trust: number;
  } {
    const scenes = new Set<string>();
    let totalInteractions = 0;
    let trustSum = 0;
    let trustCount = 0;

    for (const edge of this.edges.values()) {
      scenes.add(edge.scene);
      totalInteractions += edge.total_tasks;
      if (edge.total_weight > 0) {
        trustSum += edge.successful_weight / edge.total_weight;
        trustCount++;
      }
    }

    return {
      total_nodes: this.nodes.size,
      total_edges: this.edges.size,
      total_interactions: totalInteractions,
      scenes: [...scenes],
      avg_trust: trustCount > 0 ? trustSum / trustCount : 0,
    };
  }
}
