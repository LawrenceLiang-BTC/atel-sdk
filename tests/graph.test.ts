import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TrustGraph, calculateTaskWeight } from '../src/graph/index.js';

describe('Trust Graph', () => {
  let graph: TrustGraph;

  beforeEach(() => {
    graph = new TrustGraph();
  });

  // ── Node management ──────────────────────────────────────────

  describe('Node management', () => {
    it('should add and retrieve a node', () => {
      graph.addNode('did:agent:alice', { role: 'searcher' });
      const node = graph.getNode('did:agent:alice');
      expect(node).toBeDefined();
      expect(node!.agent_id).toBe('did:agent:alice');
      expect(node!.total_interactions).toBe(0);
      expect(node!.metadata).toEqual({ role: 'searcher' });
    });

    it('should return undefined for unknown node', () => {
      expect(graph.getNode('did:agent:unknown')).toBeUndefined();
    });

    it('should remove a node and its edges', () => {
      graph.addNode('did:agent:alice');
      graph.addNode('did:agent:bob');
      graph.recordInteraction({
        from: 'did:agent:alice', to: 'did:agent:bob',
        scene: 'search', success: true, task_weight: 1, duration_ms: 100,
      });
      graph.removeNode('did:agent:alice');
      expect(graph.getNode('did:agent:alice')).toBeUndefined();
      expect(graph.getEdges('did:agent:alice')).toHaveLength(0);
    });

    it('should update metadata on re-add', () => {
      graph.addNode('did:agent:alice', { role: 'a' });
      graph.addNode('did:agent:alice', { level: 2 });
      expect(graph.getNode('did:agent:alice')!.metadata).toEqual({ role: 'a', level: 2 });
    });
  });

  // ── Edge management / recordInteraction ──────────────────────

  describe('recordInteraction', () => {
    it('should create edge and update stats on interaction', () => {
      graph.recordInteraction({
        from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1.0, duration_ms: 500,
      });
      const edge = graph.getEdge('A', 'B', 'flight');
      expect(edge).toBeDefined();
      expect(edge!.total_tasks).toBe(1);
      expect(edge!.successful_tasks).toBe(1);
      expect(edge!.total_weight).toBe(1.0);
      expect(edge!.successful_weight).toBe(1.0);
    });

    it('should accumulate multiple interactions', () => {
      for (let i = 0; i < 5; i++) {
        graph.recordInteraction({
          from: 'A', to: 'B', scene: 'flight', success: i < 4, task_weight: 1.0, duration_ms: 100,
        });
      }
      const edge = graph.getEdge('A', 'B', 'flight')!;
      expect(edge.total_tasks).toBe(5);
      expect(edge.successful_tasks).toBe(4);
      expect(edge.failed_tasks).toBe(1);
    });

    it('should auto-create nodes', () => {
      graph.recordInteraction({
        from: 'X', to: 'Y', scene: 's', success: true, task_weight: 1, duration_ms: 10,
      });
      expect(graph.getNode('X')).toBeDefined();
      expect(graph.getNode('Y')).toBeDefined();
    });
  });

  // ── Direct trust ────────────────────────────────────────────

  describe('directTrust', () => {
    it('should return 0 when no edge exists', () => {
      graph.addNode('A');
      graph.addNode('B');
      const result = graph.directTrust('A', 'B', 'flight');
      expect(result.trust_score).toBe(0);
      expect(result.confidence).toBe(0);
    });

    it('should compute trust with history data', () => {
      // Record 20 successful interactions for full confidence
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({
          from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1.0, duration_ms: 100,
        });
      }
      const result = graph.directTrust('A', 'B', 'flight');
      expect(result.trust_score).toBeGreaterThan(0.8);
      expect(result.confidence).toBe(1);
      expect(result.source).toBe('direct');
    });

    it('should have lower trust with recency decay for old data', () => {
      graph.recordInteraction({
        from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1.0, duration_ms: 100,
      });
      // Manually set last_interaction to 100 days ago
      const edge = graph.getEdge('A', 'B', 'flight')!;
      const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
      (edge as any).last_interaction = oldDate;

      const oldResult = graph.directTrust('A', 'B', 'flight');

      // Now create a fresh interaction for comparison
      const graph2 = new TrustGraph();
      graph2.recordInteraction({
        from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1.0, duration_ms: 100,
      });
      const freshResult = graph2.directTrust('A', 'B', 'flight');

      expect(oldResult.trust_score).toBeLessThan(freshResult.trust_score);
    });

    it('should increase confidence with more tasks', () => {
      // 5 tasks → confidence = 5/20 = 0.25
      for (let i = 0; i < 5; i++) {
        graph.recordInteraction({
          from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1.0, duration_ms: 100,
        });
      }
      const r1 = graph.directTrust('A', 'B', 'flight');
      expect(r1.confidence).toBeCloseTo(0.25, 1);

      // Add 15 more → confidence = 20/20 = 1.0
      for (let i = 0; i < 15; i++) {
        graph.recordInteraction({
          from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1.0, duration_ms: 100,
        });
      }
      const r2 = graph.directTrust('A', 'B', 'flight');
      expect(r2.confidence).toBe(1);
      expect(r2.trust_score).toBeGreaterThan(r1.trust_score);
    });
  });

  // ── Indirect trust ──────────────────────────────────────────

  describe('indirectTrust', () => {
    it('should compute trust through intermediate node', () => {
      // A→M and M→B both have good trust
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'M', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'M', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const result = graph.indirectTrust('A', 'B', 's');
      expect(result.trust_score).toBeGreaterThan(0);
      expect(result.source).toBe('indirect');
      expect(result.path).toBeDefined();
      expect(result.path).toContain('M');
    });

    it('should decay with more hops', () => {
      // A→M1→M2→B (3 hops)
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'M1', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'M1', to: 'M2', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'M2', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const result3hop = graph.indirectTrust('A', 'B', 's');

      // Compare with 2-hop: A→M1→B
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'M1', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const result2hop = graph.indirectTrust('A', 'B', 's');

      // 2-hop should be stronger than 3-hop (less decay)
      expect(result2hop.trust_score).toBeGreaterThanOrEqual(result3hop.trust_score);
    });

    it('should return 0 when no path exists', () => {
      graph.addNode('A');
      graph.addNode('B');
      const result = graph.indirectTrust('A', 'B', 's');
      expect(result.trust_score).toBe(0);
    });
  });

  // ── Composite trust ────────────────────────────────────────

  describe('compositeTrust', () => {
    it('should combine direct and indirect trust', () => {
      // Direct: A→B
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      // Indirect: A→M→B
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'M', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'M', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const result = graph.compositeTrust('A', 'B', 's');
      expect(result.trust_score).toBeGreaterThan(0);
      expect(result.source).toBe('composite');
      expect(result.details.direct_trust).toBeGreaterThan(0);
    });

    it('should transfer weight to indirect when no direct trust', () => {
      // Only indirect: A→M→B
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'M', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'M', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const result = graph.compositeTrust('A', 'B', 's');
      expect(result.details.direct_trust).toBe(0);
      expect(result.details.indirect_trust).toBeGreaterThan(0);
      // With weight transfer, indirect gets 0.9 weight
      expect(result.trust_score).toBeGreaterThan(0);
    });
  });

  // ── Query tests ─────────────────────────────────────────────

  describe('sceneReputation', () => {
    it('should compute average incoming trust for a scene', () => {
      // Multiple agents trust B in 'flight' scene
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'C', to: 'B', scene: 'flight', success: true, task_weight: 1, duration_ms: 100 });
      }
      const rep = graph.sceneReputation('B', 'flight');
      expect(rep).toBeGreaterThan(0.5);
    });

    it('should return 0 for agent with no incoming edges', () => {
      graph.addNode('lonely');
      expect(graph.sceneReputation('lonely', 'flight')).toBe(0);
    });
  });

  describe('topPartners', () => {
    it('should return top-K partners sorted by trust', () => {
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'A', to: 'C', scene: 's', success: i < 10, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'A', to: 'D', scene: 's', success: i < 5, task_weight: 1, duration_ms: 100 });
      }
      const partners = graph.topPartners('A', 2);
      expect(partners).toHaveLength(2);
      expect(partners[0].agent_id).toBe('B');
      expect(partners[0].trust).toBeGreaterThan(partners[1].trust);
    });
  });

  describe('topAgentsForScene', () => {
    it('should return top agents by scene reputation', () => {
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'X', to: 'A', scene: 'hotel', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'X', to: 'B', scene: 'hotel', success: i < 10, task_weight: 1, duration_ms: 100 });
      }
      const top = graph.topAgentsForScene('hotel', 2);
      expect(top).toHaveLength(2);
      expect(top[0].agent_id).toBe('A');
    });
  });

  describe('strongestPath', () => {
    it('should find the strongest trust path', () => {
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'B', to: 'C', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const result = graph.strongestPath('A', 'C', 's');
      expect(result).not.toBeNull();
      expect(result!.path).toEqual(['A', 'B', 'C']);
      expect(result!.trust).toBeGreaterThan(0);
    });

    it('should return null when no path exists', () => {
      graph.addNode('A');
      graph.addNode('Z');
      expect(graph.strongestPath('A', 'Z', 's')).toBeNull();
    });
  });

  // ── Anomaly detection ────────────────────────────────────────

  describe('behaviorConsistencyScore', () => {
    it('should return high score for consistent agent', () => {
      // Agent A has similar success rate with all partners
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'A', to: 'C', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      const bcs = graph.behaviorConsistencyScore('A');
      expect(bcs.score).toBeGreaterThanOrEqual(0.9);
      expect(bcs.suspicious).toBe(false);
    });

    it('should flag suspicious agent with inconsistent behavior', () => {
      // Agent A: 100% success with B, 0% with C
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'A', to: 'C', scene: 's', success: false, task_weight: 1, duration_ms: 100 });
      }
      const bcs = graph.behaviorConsistencyScore('A');
      expect(bcs.score).toBeLessThan(0.7);
      expect(bcs.suspicious).toBe(true);
    });
  });

  describe('detectSuspiciousClusters', () => {
    it('should detect tightly connected clusters', () => {
      // Create a tight cluster: A, B, C interact heavily with each other
      for (let i = 0; i < 20; i++) {
        graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'B', to: 'A', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'A', to: 'C', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'C', to: 'A', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'B', to: 'C', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
        graph.recordInteraction({ from: 'C', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      }
      // Add an outsider with minimal interaction
      graph.addNode('D');
      const clusters = graph.detectSuspiciousClusters(3);
      // The cluster {A,B,C} should be detected since they have 100% internal interactions
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const first = clusters[0];
      expect(first.agents).toContain('A');
      expect(first.suspicion_score).toBeGreaterThan(0.8);
    });

    it('should return empty for well-distributed graph', () => {
      // Everyone interacts with everyone equally
      const agents = ['A', 'B', 'C', 'D', 'E'];
      for (const a of agents) {
        for (const b of agents) {
          if (a !== b) {
            for (let i = 0; i < 5; i++) {
              graph.recordInteraction({ from: a, to: b, scene: 's', success: true, task_weight: 1, duration_ms: 100 });
            }
          }
        }
      }
      const clusters = graph.detectSuspiciousClusters(3);
      // No cluster should be suspicious since interactions are evenly distributed
      expect(clusters.length).toBe(0);
    });
  });

  // ── Task weight ────────────────────────────────────────────

  describe('calculateTaskWeight', () => {
    it('should compute weight from parameters', () => {
      const weight = calculateTaskWeight({
        tool_calls: 5,
        duration_ms: 8000,
        max_cost: 5,
        risk_level: 'medium',
        similar_task_count: 0,
      });
      // complexity = min(1, 5*0.2 + 0.8*0.3) = min(1, 1.24) = 1
      // value = min(1, 5/10) = 0.5
      // risk = 1.0
      // novelty = 1/(1+ln(1)) = 1/(1+0) = 1
      // weight = 1 * 0.5 * 1.0 * 1.0 = 0.5
      expect(weight).toBeCloseTo(0.5, 1);
    });

    it('should increase weight for higher risk', () => {
      const base = { tool_calls: 3, duration_ms: 5000, max_cost: 5, similar_task_count: 0 };
      const low = calculateTaskWeight({ ...base, risk_level: 'low' });
      const high = calculateTaskWeight({ ...base, risk_level: 'critical' });
      expect(high).toBeGreaterThan(low);
    });

    it('should decrease weight for repeated tasks (novelty decay)', () => {
      const base = { tool_calls: 3, duration_ms: 5000, max_cost: 5, risk_level: 'medium' as const };
      const novel = calculateTaskWeight({ ...base, similar_task_count: 0 });
      const repeated = calculateTaskWeight({ ...base, similar_task_count: 10 });
      expect(novel).toBeGreaterThan(repeated);
    });
  });

  // ── Stats / Export ─────────────────────────────────────────

  describe('getStats', () => {
    it('should return correct statistics', () => {
      graph.recordInteraction({ from: 'A', to: 'B', scene: 'flight', success: true, task_weight: 1, duration_ms: 100 });
      graph.recordInteraction({ from: 'A', to: 'C', scene: 'hotel', success: false, task_weight: 1, duration_ms: 200 });

      const stats = graph.getStats();
      expect(stats.total_nodes).toBe(3);
      expect(stats.total_edges).toBe(2);
      expect(stats.total_interactions).toBe(2);
      expect(stats.scenes).toContain('flight');
      expect(stats.scenes).toContain('hotel');
    });
  });

  describe('exportGraph', () => {
    it('should export all nodes and edges', () => {
      graph.recordInteraction({ from: 'A', to: 'B', scene: 's', success: true, task_weight: 1, duration_ms: 100 });
      const exported = graph.exportGraph();
      expect(exported.nodes).toHaveLength(2);
      expect(exported.edges).toHaveLength(1);
    });
  });
});
