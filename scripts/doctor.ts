/**
 * ATEL doctor command.
 *
 * Checks:
 * - core crypto (identity sign/verify)
 * - local orchestrator flow (proof + anchor receipt + trustSync receipt)
 * - optional trust service connectivity (ATEL_TRUST_BASE_URL)
 * - optional chain RPC availability checks
 *
 * Exit code:
 * - 0: all required checks pass
 * - 1: one or more required checks failed
 */

import {
  AgentIdentity,
  ATELOrchestrator,
  MockAnchorProvider,
  parseDID,
  verify,
  BaseAnchorProvider,
  BSCAnchorProvider,
  SolanaAnchorProvider,
} from '../src/index.js';

interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail?: string;
}

function result(
  name: string,
  ok: boolean,
  required: boolean = true,
  detail?: string,
): CheckResult {
  return { name, ok, required, detail };
}

async function checkCrypto(): Promise<CheckResult> {
  try {
    const identity = new AgentIdentity();
    const payload = { ping: 'atel', ts: Date.now() };
    const sig = identity.sign(payload);
    const pub = parseDID(identity.did);
    const ok = verify(payload, sig, pub);
    return result('crypto.identity_sign_verify', ok, true, ok ? 'signature verified' : 'verify=false');
  } catch (err) {
    return result('crypto.identity_sign_verify', false, true, err instanceof Error ? err.message : String(err));
  }
}

async function checkLocalFlow(): Promise<CheckResult> {
  try {
    const mock = new MockAnchorProvider();
    const delegator = new ATELOrchestrator({ agentId: 'doctor-delegator', anchors: [mock] });
    const executor = new ATELOrchestrator({ agentId: 'doctor-executor', anchors: [mock] });

    const delegation = delegator.delegateTask({
      executor: executor.identity,
      intent: { type: 'doctor_task', goal: 'self check' },
      risk: 'low',
      scopes: ['tool:http:get', 'data:public_web:read'],
    });

    const exec = await executor.executeTask({
      task: delegation.task,
      consentToken: delegation.consentToken,
      tools: {
        'http.get': async () => ({ status: 200, body: { ok: true } }),
      },
      execute: async (gateway) => gateway.callTool({
        tool: 'http.get',
        input: { url: 'https://mock.local/doctor' },
        risk_level: 'low',
        data_scope: 'public_web:read',
      }),
    });

    const verifyResult = await delegator.verifyExecution(exec.proof, {
      trace: exec.trace,
      anchorChain: 'mock',
    });

    const ok = exec.success &&
      verifyResult.valid &&
      exec.anchor.anchored &&
      exec.anchor.verificationPassed &&
      exec.trustSync.localUpdated;

    return result(
      'flow.local_orchestrator',
      ok,
      true,
      `success=${exec.success}, proof=${verifyResult.valid}, anchored=${exec.anchor.anchored}, anchorVerified=${exec.anchor.verificationPassed}`,
    );
  } catch (err) {
    return result('flow.local_orchestrator', false, true, err instanceof Error ? err.message : String(err));
  }
}

async function checkTrustServiceConnectivity(): Promise<CheckResult> {
  const baseUrl = process.env.ATEL_TRUST_BASE_URL;
  if (!baseUrl) {
    return result('network.trust_service_health', true, false, 'skipped (ATEL_TRUST_BASE_URL not set)');
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/health`);
    if (!res.ok) {
      return result('network.trust_service_health', false, false, `HTTP ${res.status}`);
    }
    return result('network.trust_service_health', true, false, 'reachable');
  } catch (err) {
    return result(
      'network.trust_service_health',
      false,
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function checkChainAvailability(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  const baseRpc = process.env.ATEL_BASE_RPC_URL;
  if (baseRpc) {
    try {
      const provider = new BaseAnchorProvider({ rpcUrl: baseRpc });
      const ok = await provider.isAvailable();
      checks.push(result('chain.base_rpc_available', ok, false, ok ? 'reachable' : 'unreachable'));
    } catch (err) {
      checks.push(result('chain.base_rpc_available', false, false, err instanceof Error ? err.message : String(err)));
    }
  }

  const bscRpc = process.env.ATEL_BSC_RPC_URL;
  if (bscRpc) {
    try {
      const provider = new BSCAnchorProvider({ rpcUrl: bscRpc });
      const ok = await provider.isAvailable();
      checks.push(result('chain.bsc_rpc_available', ok, false, ok ? 'reachable' : 'unreachable'));
    } catch (err) {
      checks.push(result('chain.bsc_rpc_available', false, false, err instanceof Error ? err.message : String(err)));
    }
  }

  const solRpc = process.env.ATEL_SOLANA_RPC_URL;
  if (solRpc) {
    try {
      const provider = new SolanaAnchorProvider({ rpcUrl: solRpc });
      const ok = await provider.isAvailable();
      checks.push(result('chain.solana_rpc_available', ok, false, ok ? 'reachable' : 'unreachable'));
    } catch (err) {
      checks.push(result('chain.solana_rpc_available', false, false, err instanceof Error ? err.message : String(err)));
    }
  }

  if (checks.length === 0) {
    checks.push(result('chain.rpc_availability', true, false, 'skipped (no chain RPC env vars set)'));
  }
  return checks;
}

async function main(): Promise<void> {
  const checks: CheckResult[] = [];
  checks.push(await checkCrypto());
  checks.push(await checkLocalFlow());
  checks.push(await checkTrustServiceConnectivity());
  checks.push(...await checkChainAvailability());

  const failedRequired = checks.filter((c) => c.required && !c.ok);
  const status = failedRequired.length === 0 ? 'PASS' : 'FAIL';

  const report = {
    status,
    checkedAt: new Date().toISOString(),
    checks,
  };
  console.log(JSON.stringify(report, null, 2));

  if (status === 'FAIL') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('doctor failed:', err);
  process.exit(1);
});
