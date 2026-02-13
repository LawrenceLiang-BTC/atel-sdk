/**
 * Deployment acceptance script.
 *
 * Verifies end-to-end deployable behavior:
 * 1) Start TrustScoreService (self-hosted network trust layer)
 * 2) Run orchestrator flow with local trust + HttpTrustSyncAdapter
 * 3) Verify proof + anchor receipt + trust sync receipt
 * 4) Query service endpoints for score and graph trust
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATELOrchestrator,
  HttpTrustSyncAdapter,
  MockAnchorProvider,
  TrustScoreService,
} from '../src/index.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`ACCEPTANCE_ASSERT_FAIL: ${message}`);
  }
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'atel-acceptance-'));
  const port = parseInt(process.env.ATEL_ACCEPT_PORT ?? '3210', 10);
  const baseUrl = `http://127.0.0.1:${port}`;

  const service = new TrustScoreService({ port, dataDir });
  const sharedMock = new MockAnchorProvider();

  try {
    await service.start();

    const delegator = new ATELOrchestrator({
      agentId: 'accept-delegator',
      anchors: [sharedMock],
    });

    const executor = new ATELOrchestrator({
      agentId: 'accept-executor',
      anchors: [sharedMock],
      trustSync: new HttpTrustSyncAdapter({
        baseUrl,
        timeoutMs: 5000,
      }),
    });

    const delegation = delegator.delegateTask({
      executor: executor.identity,
      intent: {
        type: 'acceptance_fetch',
        goal: 'Deployment acceptance task',
      },
      risk: 'low',
      scopes: ['tool:http:get', 'data:public_web:read'],
    });

    const execution = await executor.executeTask({
      task: delegation.task,
      consentToken: delegation.consentToken,
      tools: {
        'http.get': async () => ({ status: 200, body: { ok: true, source: 'acceptance' } }),
      },
      execute: async (gateway) => gateway.callTool({
        tool: 'http.get',
        input: { url: 'https://mock.local/acceptance' },
        risk_level: 'low',
        data_scope: 'public_web:read',
      }),
    });

    const verify = await delegator.verifyExecution(execution.proof, {
      trace: execution.trace,
      anchorChain: 'mock',
    });

    assert(execution.success, 'execution should succeed');
    assert(verify.valid, 'proof verification should pass');
    assert(execution.anchor.anchored, 'anchor should be present');
    assert(execution.anchor.verificationPassed, 'anchor verification should pass');
    assert(execution.trustSync.mode === 'local+network', 'trust sync mode should be local+network');
    assert(execution.trustSync.networkSynced, 'network trust sync should succeed');

    // Query score endpoint
    const scoreRes = await fetch(`${baseUrl}/api/v1/score/${encodeURIComponent(executor.identity.did)}`);
    assert(scoreRes.ok, 'score endpoint should return 200');
    const scoreJson = await scoreRes.json() as { total_tasks?: number };
    assert((scoreJson.total_tasks ?? 0) >= 1, 'score should include synced task');

    // Query graph trust endpoint
    const trustRes = await fetch(`${baseUrl}/api/v1/graph/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: delegator.identity.did,
        to: executor.identity.did,
        scene: 'acceptance_fetch',
      }),
    });
    assert(trustRes.ok, 'graph trust endpoint should return 200');

    const summary = {
      status: 'PASS',
      service: { port, dataDir },
      executor: executor.identity.did,
      proofValid: verify.valid,
      anchor: execution.anchor,
      trustSync: execution.trustSync,
      scoreTotalTasks: scoreJson.total_tasks ?? 0,
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Deployment acceptance failed:', err);
  process.exit(1);
});
