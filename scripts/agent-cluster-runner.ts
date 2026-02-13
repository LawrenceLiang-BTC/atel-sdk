/**
 * Phase 0.5 multi-agent continuous runner.
 *
 * Runs N agents for M rounds with K concurrency and outputs a JSON report.
 *
 * Env:
 * - ATEL_CLUSTER_AGENTS (default: 5)
 * - ATEL_CLUSTER_ROUNDS (default: 100)
 * - ATEL_CLUSTER_CONCURRENCY (default: 5)
 * - ATEL_CLUSTER_USE_REAL_HTTP (1 => use RealHttpTool)
 * - ATEL_CLUSTER_ANCHOR_MODE (none | mock, default: mock)
 * - ATEL_CLUSTER_REPORT (default: reports/cluster-run-latest.json)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ATELOrchestrator,
  MockAnchorProvider,
  RealHttpTool,
} from '../src/index.js';

interface RunStats {
  totalTasks: number;
  successTasks: number;
  failedTasks: number;
  proofValid: number;
  anchoredTasks: number;
  anchorVerifiedTasks: number;
  durationMsTotal: number;
  startedAt: string;
  finishedAt?: string;
}

function toInt(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pickPair(size: number, i: number): { from: number; to: number } {
  const from = i % size;
  const to = (i + 1) % size;
  return { from, to };
}

async function main(): Promise<void> {
  const agentCount = toInt(process.env.ATEL_CLUSTER_AGENTS, 5);
  const rounds = toInt(process.env.ATEL_CLUSTER_ROUNDS, 100);
  const concurrency = toInt(process.env.ATEL_CLUSTER_CONCURRENCY, 5);
  const useRealHttp = process.env.ATEL_CLUSTER_USE_REAL_HTTP === '1';
  const anchorMode = process.env.ATEL_CLUSTER_ANCHOR_MODE ?? 'mock';
  const reportPath = process.env.ATEL_CLUSTER_REPORT ?? 'reports/cluster-run-latest.json';

  const sharedMock = anchorMode === 'mock' ? new MockAnchorProvider() : null;

  const agents = Array.from({ length: agentCount }, (_, i) => new ATELOrchestrator({
    agentId: `cluster-agent-${i + 1}`,
    anchors: sharedMock ? [sharedMock] : undefined,
  }));

  const stats: RunStats = {
    totalTasks: 0,
    successTasks: 0,
    failedTasks: 0,
    proofValid: 0,
    anchoredTasks: 0,
    anchorVerifiedTasks: 0,
    durationMsTotal: 0,
    startedAt: new Date().toISOString(),
  };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= rounds) return;
      const { from, to } = pickPair(agentCount, idx);
      const delegator = agents[from];
      const executor = agents[to];
      const started = Date.now();

      try {
        const delegation = delegator.delegateTask({
          executor: executor.identity,
          intent: {
            type: 'cluster_fetch',
            goal: `round-${idx}`,
            constraints: { round: idx },
          },
          risk: 'low',
          scopes: ['tool:http:get', 'data:public_web:read'],
        });

        const exec = await executor.executeTask({
          task: delegation.task,
          consentToken: delegation.consentToken,
          tools: {
            'http.get': async (input: unknown) => {
              if (useRealHttp) {
                const req = input as { url: string };
                return RealHttpTool.get(req.url);
              }
              return { status: 200, body: { ok: true, round: idx } };
            },
          },
          execute: async (gateway) => gateway.callTool({
            tool: 'http.get',
            input: {
              url: useRealHttp
                ? 'https://jsonplaceholder.typicode.com/posts/1'
                : `https://mock.local/${idx}`,
            },
            risk_level: 'low',
            data_scope: 'public_web:read',
          }),
        });

        const verify = await delegator.verifyExecution(exec.proof, { trace: exec.trace });
        stats.totalTasks++;
        stats.successTasks += exec.success ? 1 : 0;
        stats.failedTasks += exec.success ? 0 : 1;
        stats.proofValid += verify.valid ? 1 : 0;
        stats.anchoredTasks += exec.anchor.anchored ? 1 : 0;
        stats.anchorVerifiedTasks += exec.anchor.verificationPassed ? 1 : 0;
      } catch {
        stats.totalTasks++;
        stats.failedTasks++;
      } finally {
        stats.durationMsTotal += Date.now() - started;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, rounds) }, () => worker());
  await Promise.all(workers);
  stats.finishedAt = new Date().toISOString();

  const report = {
    config: {
      agentCount,
      rounds,
      concurrency,
      useRealHttp,
      anchorMode,
    },
    stats,
    derived: {
      successRate: stats.totalTasks > 0 ? stats.successTasks / stats.totalTasks : 0,
      proofValidRate: stats.totalTasks > 0 ? stats.proofValid / stats.totalTasks : 0,
      anchoredRate: stats.totalTasks > 0 ? stats.anchoredTasks / stats.totalTasks : 0,
      anchorVerifiedRate: stats.totalTasks > 0 ? stats.anchorVerifiedTasks / stats.totalTasks : 0,
      avgTaskDurationMs: stats.totalTasks > 0 ? Math.round(stats.durationMsTotal / stats.totalTasks) : 0,
    },
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('Cluster run completed.');
  console.log(`Report: ${reportPath}`);
  console.log(`Success rate: ${(report.derived.successRate * 100).toFixed(2)}%`);
  console.log(`Proof valid rate: ${(report.derived.proofValidRate * 100).toFixed(2)}%`);
  console.log(`Anchor verified rate: ${(report.derived.anchorVerifiedRate * 100).toFixed(2)}%`);
}

main().catch((err) => {
  console.error('agent-cluster-runner failed:', err);
  process.exit(1);
});
