import { describe, it, expect } from 'vitest';
import { TrustManager } from '../src/trust/index.js';
import type { TrustSubmission } from '../src/trust/index.js';

function makeSubmission(overrides?: Partial<TrustSubmission>): TrustSubmission {
  return {
    executor: overrides?.executor ?? 'did:atel:executor1',
    issuer: overrides?.issuer ?? 'did:atel:issuer1',
    task_id: overrides?.task_id ?? `task-${Math.random().toString(36).slice(2)}`,
    task_type: overrides?.task_type ?? 'web_search',
    risk_level: overrides?.risk_level ?? 'low',
    success: overrides?.success ?? true,
    duration_ms: overrides?.duration_ms ?? 100,
    tool_calls: overrides?.tool_calls ?? 1,
    policy_violations: overrides?.policy_violations ?? 0,
    proof_id: overrides?.proof_id ?? 'proof-1',
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    ...overrides,
  };
}

describe('TrustManager', () => {
  describe('submitResult', () => {
    it('should update both score client and graph', () => {
      const tm = new TrustManager();
      tm.submitResult(makeSubmission());

      // Score client should have the executor
      const score = tm.scoreClient.getAgentScore('did:atel:executor1');
      expect(score.total_tasks).toBe(1);
      expect(score.success_rate).toBe(1);

      // Graph should have both nodes
      expect(tm.graph.getNode('did:atel:issuer1')).toBeDefined();
      expect(tm.graph.getNode('did:atel:executor1')).toBeDefined();

      // Graph should have an edge
      const edge = tm.graph.getEdge('did:atel:issuer1', 'did:atel:executor1', 'web_search');
      expect(edge).toBeDefined();
      expect(edge!.total_tasks).toBe(1);
    });

    it('should accumulate multiple submissions', () => {
      const tm = new TrustManager();
      for (let i = 0; i < 5; i++) {
        tm.submitResult(makeSubmission({ success: i < 4 }));
      }

      const score = tm.scoreClient.getAgentScore('did:atel:executor1');
      expect(score.total_tasks).toBe(5);
      expect(score.success_rate).toBe(0.8);

      const edge = tm.graph.getEdge('did:atel:issuer1', 'did:atel:executor1', 'web_search');
      expect(edge!.total_tasks).toBe(5);
      expect(edge!.successful_tasks).toBe(4);
    });

    it('should use custom scene when provided', () => {
      const tm = new TrustManager();
      tm.submitResult(makeSubmission({ scene: 'custom_scene' }));

      const edge = tm.graph.getEdge('did:atel:issuer1', 'did:atel:executor1', 'custom_scene');
      expect(edge).toBeDefined();
    });
  });

  describe('queryTrust', () => {
    it('should return comprehensive trust information', () => {
      const tm = new TrustManager();
      for (let i = 0; i < 10; i++) {
        tm.submitResult(makeSubmission());
      }

      const trust = tm.queryTrust('did:atel:issuer1', 'did:atel:executor1', 'web_search');
      expect(trust.graphTrust).toBeDefined();
      expect(trust.scoreReport).toBeDefined();
      expect(trust.combinedScore).toBeGreaterThan(0);
      expect(trust.scoreReport.total_tasks).toBe(10);
    });

    it('should return zero trust for unknown agents', () => {
      const tm = new TrustManager();
      const trust = tm.queryTrust('did:atel:a', 'did:atel:b', 'scene');
      expect(trust.combinedScore).toBe(0);
      expect(trust.graphTrust.trust_score).toBe(0);
    });
  });

  describe('getAgentScore', () => {
    it('should delegate to score client', () => {
      const tm = new TrustManager();
      tm.submitResult(makeSubmission());
      const score = tm.getAgentScore('did:atel:executor1');
      expect(score.total_tasks).toBe(1);
    });
  });

  describe('getGraphTrust', () => {
    it('should delegate to graph', () => {
      const tm = new TrustManager();
      for (let i = 0; i < 20; i++) {
        tm.submitResult(makeSubmission());
      }
      const trust = tm.getGraphTrust('did:atel:issuer1', 'did:atel:executor1', 'web_search');
      expect(trust.trust_score).toBeGreaterThan(0);
    });
  });
});
