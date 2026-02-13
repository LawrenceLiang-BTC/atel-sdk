import { describe, it, expect } from 'vitest';
import {
  TrustScoreClient,
  FLAG_LOW_SUCCESS_RATE,
  FLAG_HAS_VIOLATIONS,
  FLAG_LOW_RISK_ONLY,
  FLAG_RECENT_FAILURES,
} from '../src/score/index.js';
import type { ExecutionSummary } from '../src/score/index.js';

function makeSummary(overrides?: Partial<ExecutionSummary>): ExecutionSummary {
  return {
    executor: overrides?.executor ?? 'did:atel:agent1',
    task_id: overrides?.task_id ?? `task-${Math.random().toString(36).slice(2)}`,
    task_type: overrides?.task_type ?? 'http.get',
    risk_level: overrides?.risk_level ?? 'low',
    success: overrides?.success ?? true,
    duration_ms: overrides?.duration_ms ?? 100,
    tool_calls: overrides?.tool_calls ?? 1,
    policy_violations: overrides?.policy_violations ?? 0,
    proof_id: overrides?.proof_id ?? 'proof-1',
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
  };
}

describe('score', () => {
  describe('submitExecutionSummary', () => {
    it('should accept a valid summary', () => {
      const client = new TrustScoreClient();
      expect(() => client.submitExecutionSummary(makeSummary())).not.toThrow();
    });

    it('should throw on missing executor', () => {
      const client = new TrustScoreClient();
      expect(() =>
        client.submitExecutionSummary(makeSummary({ executor: '' }))
      ).toThrow();
    });

    it('should throw on missing task_id', () => {
      const client = new TrustScoreClient();
      expect(() =>
        client.submitExecutionSummary(makeSummary({ task_id: '' }))
      ).toThrow();
    });

    it('should throw on negative duration', () => {
      const client = new TrustScoreClient();
      expect(() =>
        client.submitExecutionSummary(makeSummary({ duration_ms: -1 }))
      ).toThrow();
    });
  });

  describe('getAgentScore', () => {
    it('should return zero score for unknown agent', () => {
      const client = new TrustScoreClient();
      const report = client.getAgentScore('did:atel:unknown');
      expect(report.trust_score).toBe(0);
      expect(report.total_tasks).toBe(0);
    });

    it('should increase score with successful tasks', () => {
      const client = new TrustScoreClient();
      for (let i = 0; i < 5; i++) {
        client.submitExecutionSummary(makeSummary({ success: true }));
      }
      const report = client.getAgentScore('did:atel:agent1');
      expect(report.trust_score).toBeGreaterThan(0);
      expect(report.success_rate).toBe(1);
      expect(report.total_tasks).toBe(5);
    });

    it('should decrease score with failed tasks', () => {
      const client = new TrustScoreClient();
      // All successful
      const clientA = new TrustScoreClient();
      for (let i = 0; i < 10; i++) {
        clientA.submitExecutionSummary(makeSummary({ success: true }));
      }
      const scoreAllSuccess = clientA.getAgentScore('did:atel:agent1').trust_score;

      // Mix of success and failure
      const clientB = new TrustScoreClient();
      for (let i = 0; i < 10; i++) {
        clientB.submitExecutionSummary(makeSummary({ success: i < 5 }));
      }
      const scoreMixed = clientB.getAgentScore('did:atel:agent1').trust_score;

      expect(scoreAllSuccess).toBeGreaterThan(scoreMixed);
    });
  });

  describe('risk flags', () => {
    it('should flag LOW_SUCCESS_RATE when success rate < 50%', () => {
      const client = new TrustScoreClient();
      // 2 success, 5 failures
      for (let i = 0; i < 2; i++) {
        client.submitExecutionSummary(makeSummary({ success: true }));
      }
      for (let i = 0; i < 5; i++) {
        client.submitExecutionSummary(makeSummary({ success: false }));
      }
      const report = client.getAgentScore('did:atel:agent1');
      expect(report.risk_flags).toContain(FLAG_LOW_SUCCESS_RATE);
    });

    it('should flag HAS_VIOLATIONS when there are policy violations', () => {
      const client = new TrustScoreClient();
      client.submitExecutionSummary(makeSummary({ policy_violations: 2 }));
      const report = client.getAgentScore('did:atel:agent1');
      expect(report.risk_flags).toContain(FLAG_HAS_VIOLATIONS);
    });

    it('should flag LOW_RISK_ONLY when all tasks are low risk and > 50 tasks', () => {
      const client = new TrustScoreClient();
      for (let i = 0; i < 51; i++) {
        client.submitExecutionSummary(makeSummary({ risk_level: 'low' }));
      }
      const report = client.getAgentScore('did:atel:agent1');
      expect(report.risk_flags).toContain(FLAG_LOW_RISK_ONLY);
    });

    it('should not flag LOW_RISK_ONLY when there are high risk tasks', () => {
      const client = new TrustScoreClient();
      for (let i = 0; i < 51; i++) {
        client.submitExecutionSummary(makeSummary({ risk_level: 'low' }));
      }
      client.submitExecutionSummary(makeSummary({ risk_level: 'high' }));
      const report = client.getAgentScore('did:atel:agent1');
      expect(report.risk_flags).not.toContain(FLAG_LOW_RISK_ONLY);
    });
  });

  describe('multiple agents', () => {
    it('should track agents independently', () => {
      const client = new TrustScoreClient();
      client.submitExecutionSummary(makeSummary({ executor: 'did:atel:a', success: true }));
      client.submitExecutionSummary(makeSummary({ executor: 'did:atel:a', success: true }));
      client.submitExecutionSummary(makeSummary({ executor: 'did:atel:b', success: false }));

      const reportA = client.getAgentScore('did:atel:a');
      const reportB = client.getAgentScore('did:atel:b');

      expect(reportA.total_tasks).toBe(2);
      expect(reportA.success_rate).toBe(1);
      expect(reportB.total_tasks).toBe(1);
      expect(reportB.success_rate).toBe(0);
      expect(reportA.trust_score).toBeGreaterThan(reportB.trust_score);
    });
  });

  describe('exportData', () => {
    it('should export data in correct format', () => {
      const client = new TrustScoreClient();
      client.submitExecutionSummary(makeSummary({ executor: 'did:atel:x' }));
      client.submitExecutionSummary(makeSummary({ executor: 'did:atel:y' }));

      const exported = client.exportData();
      expect(exported.exported_at).toBeTruthy();
      expect(exported.agent_count).toBe(2);
      expect(exported.summaries['did:atel:x']).toBeDefined();
      expect(exported.summaries['did:atel:x'].length).toBe(1);
      expect(exported.summaries['did:atel:y']).toBeDefined();
      expect(exported.reports.length).toBe(2);
    });

    it('should include score reports for all agents', () => {
      const client = new TrustScoreClient();
      for (let i = 0; i < 3; i++) {
        client.submitExecutionSummary(makeSummary({ executor: `did:atel:agent${i}` }));
      }
      const exported = client.exportData();
      expect(exported.reports.length).toBe(3);
      for (const report of exported.reports) {
        expect(report.agent_id).toBeTruthy();
        expect(report.trust_score).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
