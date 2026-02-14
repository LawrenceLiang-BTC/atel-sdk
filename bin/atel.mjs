#!/usr/bin/env node

/**
 * ATEL CLI — Command-line interface for ATEL SDK
 *
 * Commands:
 *   atel init [name]                    Create agent identity + default policy
 *   atel info                           Show identity, capabilities, policy, network
 *   atel start [port]                   Start endpoint (auto network + auto register)
 *   atel setup [port]                   Network setup only (detect IP, UPnP, verify)
 *   atel verify                         Verify port reachability
 *   atel inbox [count]                  Show received messages
 *   atel register [name] [caps] [url]   Register on public registry
 *   atel search <capability>            Search registry for agents
 *   atel handshake <endpoint> [did]     Handshake with a remote agent
 *   atel task <endpoint> <json>         Delegate a task to a remote agent
 *   atel result <taskId> <json>         Submit execution result (from executor)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentIdentity, AgentEndpoint, AgentClient, HandshakeManager,
  createMessage, RegistryClient, ExecutionTrace, ProofGenerator,
  SolanaAnchorProvider, autoNetworkSetup, collectCandidates, connectToAgent,
  discoverPublicIP, checkReachable, ContentAuditor, TrustScoreClient,
  RollbackManager,
} from '@lawreneliang/atel-sdk';
import { TunnelManager, HeartbeatManager } from './tunnel-manager.mjs';

const ATEL_DIR = resolve(process.env.ATEL_DIR || '.atel');
const IDENTITY_FILE = resolve(ATEL_DIR, 'identity.json');
const REGISTRY_URL = process.env.ATEL_REGISTRY || 'http://47.251.8.19:8100';
const EXECUTOR_URL = process.env.ATEL_EXECUTOR_URL || '';
const INBOX_FILE = resolve(ATEL_DIR, 'inbox.jsonl');
const POLICY_FILE = resolve(ATEL_DIR, 'policy.json');
const TASKS_FILE = resolve(ATEL_DIR, 'tasks.json');
const NETWORK_FILE = resolve(ATEL_DIR, 'network.json');

const DEFAULT_POLICY = { rateLimit: 60, maxPayloadBytes: 1048576, maxConcurrent: 10, allowedDIDs: [], blockedDIDs: [] };

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir() { if (!existsSync(ATEL_DIR)) mkdirSync(ATEL_DIR, { recursive: true }); }
function log(event) { ensureDir(); appendFileSync(INBOX_FILE, JSON.stringify(event) + '\n'); console.log(JSON.stringify(event)); }

function saveIdentity(id) { ensureDir(); writeFileSync(IDENTITY_FILE, JSON.stringify({ agent_id: id.agent_id, did: id.did, publicKey: Buffer.from(id.publicKey).toString('hex'), secretKey: Buffer.from(id.secretKey).toString('hex') }, null, 2)); }
function loadIdentity() { if (!existsSync(IDENTITY_FILE)) return null; const d = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8')); return new AgentIdentity({ agent_id: d.agent_id, publicKey: Uint8Array.from(Buffer.from(d.publicKey, 'hex')), secretKey: Uint8Array.from(Buffer.from(d.secretKey, 'hex')) }); }
function requireIdentity() { const id = loadIdentity(); if (!id) { console.error('No identity. Run: atel init'); process.exit(1); } return id; }

function loadCapabilities() { const f = resolve(ATEL_DIR, 'capabilities.json'); if (!existsSync(f)) return []; try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return []; } }
function saveCapabilities(c) { ensureDir(); writeFileSync(resolve(ATEL_DIR, 'capabilities.json'), JSON.stringify(c, null, 2)); }
function loadPolicy() { if (!existsSync(POLICY_FILE)) return { ...DEFAULT_POLICY }; try { return { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(POLICY_FILE, 'utf-8')) }; } catch { return { ...DEFAULT_POLICY }; } }
function savePolicy(p) { ensureDir(); writeFileSync(POLICY_FILE, JSON.stringify(p, null, 2)); }
function loadTasks() { if (!existsSync(TASKS_FILE)) return {}; try { return JSON.parse(readFileSync(TASKS_FILE, 'utf-8')); } catch { return {}; } }
function saveTasks(t) { ensureDir(); writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2)); }
function loadNetwork() { if (!existsSync(NETWORK_FILE)) return null; try { return JSON.parse(readFileSync(NETWORK_FILE, 'utf-8')); } catch { return null; } }
function saveNetwork(n) { ensureDir(); writeFileSync(NETWORK_FILE, JSON.stringify(n, null, 2)); }

// ─── Policy Enforcer ─────────────────────────────────────────────

class PolicyEnforcer {
  constructor(policy) { this.policy = policy; this.requestLog = []; this.activeTasks = 0; }
  check(message) {
    const p = this.policy, from = message.from, size = JSON.stringify(message.payload || {}).length, now = Date.now();
    if (p.blockedDIDs.length > 0 && p.blockedDIDs.includes(from)) return { allowed: false, reason: `DID blocked` };
    if (p.allowedDIDs.length > 0 && !p.allowedDIDs.includes(from)) return { allowed: false, reason: `DID not in allowlist` };
    this.requestLog = this.requestLog.filter(t => now - t < 60000);
    if (this.requestLog.length >= p.rateLimit) return { allowed: false, reason: `Rate limit (${p.rateLimit}/min)` };
    if (size > p.maxPayloadBytes) return { allowed: false, reason: `Payload too large (${size} > ${p.maxPayloadBytes})` };
    if (this.activeTasks >= p.maxConcurrent) return { allowed: false, reason: `Max concurrent (${p.maxConcurrent})` };
    this.requestLog.push(now);
    return { allowed: true };
  }
  taskStarted() { this.activeTasks++; }
  taskFinished() { this.activeTasks = Math.max(0, this.activeTasks - 1); }
}

// ─── On-chain Anchoring ──────────────────────────────────────────

async function anchorOnChain(traceRoot, metadata) {
  const key = process.env.ATEL_SOLANA_PRIVATE_KEY;
  if (!key) return null;
  try {
    const s = new SolanaAnchorProvider({ rpcUrl: process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', privateKey: key });
    const r = await s.anchor(traceRoot, metadata);
    log({ event: 'proof_anchored', chain: 'solana', txHash: r.txHash, block: r.blockNumber, trace_root: traceRoot });
    return r;
  } catch (e) { log({ event: 'anchor_failed', chain: 'solana', error: e.message }); return null; }
}

// ─── Commands ────────────────────────────────────────────────────

async function cmdInit(agentId) {
  const name = agentId || `agent-${Date.now()}`;
  const identity = new AgentIdentity({ agent_id: name });
  saveIdentity(identity);
  savePolicy(DEFAULT_POLICY);
  console.log(JSON.stringify({ status: 'created', agent_id: identity.agent_id, did: identity.did, policy: POLICY_FILE, next: 'Run: atel start [port] — auto-configures network and registers' }, null, 2));
}

async function cmdInfo() {
  const id = requireIdentity();
  console.log(JSON.stringify({ agent_id: id.agent_id, did: id.did, capabilities: loadCapabilities(), policy: loadPolicy(), network: loadNetwork(), executor: EXECUTOR_URL || 'not configured' }, null, 2));
}

async function cmdSetup(port) {
  const p = parseInt(port || '3100');
  console.log(JSON.stringify({ event: 'network_setup', port: p }));
  const net = await autoNetworkSetup(p);
  for (const step of net.steps) console.log(JSON.stringify({ event: 'step', message: step }));
  if (net.endpoint) {
    saveNetwork({ publicIP: net.publicIP, port: p, endpoint: net.endpoint, upnp: net.upnpSuccess, reachable: net.reachable, configuredAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'ready', endpoint: net.endpoint }));
  } else if (net.publicIP) {
    const ep = `http://${net.publicIP}:${p}`;
    saveNetwork({ publicIP: net.publicIP, port: p, endpoint: ep, upnp: false, reachable: false, needsManualPortForward: true, configuredAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'needs_port_forward', publicIP: net.publicIP, port: p, instruction: `Forward external TCP port ${p} to this machine's port ${p} on your router. Then run: atel verify` }));
  } else {
    console.log(JSON.stringify({ status: 'failed', error: 'Could not determine public IP' }));
  }
}

async function cmdVerify() {
  const net = loadNetwork();
  if (!net) { console.error('No network config. Run: atel setup'); process.exit(1); }
  console.log(JSON.stringify({ event: 'verifying', ip: net.publicIP, port: net.port }));
  const result = await verifyPortReachable(net.publicIP, net.port);
  console.log(JSON.stringify({ status: result.reachable ? 'reachable' : 'not_reachable', detail: result.detail }));
  if (result.reachable) { net.reachable = true; net.needsManualPortForward = false; saveNetwork(net); }
}

async function cmdStart(port) {
  const id = requireIdentity();
  const p = parseInt(port || '3100');
  const caps = loadCapabilities();
  const capTypes = caps.map(c => c.type || c);
  const policy = loadPolicy();
  const enforcer = new PolicyEnforcer(policy);
  const pendingTasks = loadTasks();

  // ── Network: collect candidates ──
  let networkConfig = loadNetwork();
  if (!networkConfig) {
    log({ event: 'network_setup', status: 'auto-detecting' });
    networkConfig = await autoNetworkSetup(p);
    for (const step of networkConfig.steps) log({ event: 'network_step', message: step });
    delete networkConfig.steps;
    saveNetwork(networkConfig);
  } else {
    log({ event: 'network_loaded', candidates: networkConfig.candidates.length });
  }

  // ── Start endpoint ──
  const endpoint = new AgentEndpoint(id, { port: p, host: '0.0.0.0' });

  // ── Trust Score Client ──
  const trustScoreClient = new TrustScoreClient();

  // ── Nonce Store (anti-replay) ──
  const nonceFile = join(ATEL_DIR, 'nonces.json');
  const usedNonces = new Set((() => { try { return JSON.parse(readFileSync(nonceFile, 'utf8')); } catch { return []; } })());
  const saveNonces = () => { try { writeFileSync(nonceFile, JSON.stringify([...usedNonces].slice(-10000))); } catch {} };

  // ── Helper: generate rejection Proof (local only, no on-chain) ──
  function generateRejectionProof(from, action, reason, stage) {
    const rejectId = `reject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const trace = new ExecutionTrace(rejectId, id);
    trace.append('TASK_RECEIVED', { from, action });
    trace.append(stage, { result: 'rejected', reason });
    trace.fail(new Error(reason));
    const proofGen = new ProofGenerator(trace, id);
    const proof = proofGen.generate(capTypes.join(',') || 'no-policy', `rejected-from-${from}`, reason);
    log({ event: 'rejection_proof', rejectId, from, action, stage, reason, proof_id: proof.proof_id, trace_root: proof.trace_root, timestamp: new Date().toISOString() });
    return { proof_id: proof.proof_id, trace_root: proof.trace_root };
  }

  // Result callback: POST /atel/v1/result (executor calls this when done)
  endpoint.app?.post?.('/atel/v1/result', async (req, res) => {
    const { taskId, result, success } = req.body || {};
    if (!taskId || !pendingTasks[taskId]) { res.status(404).json({ error: 'Unknown taskId' }); return; }
    const task = pendingTasks[taskId];
    const startTime = new Date(task.acceptedAt).getTime();
    const durationMs = Date.now() - startTime;
    enforcer.taskFinished();

    // ── Execution Trace (detailed) ──
    const trace = new ExecutionTrace(taskId, id);
    trace.append('TASK_RECEIVED', { from: task.from, action: task.action, encrypted: task.encrypted });
    trace.append('POLICY_CHECK', { rateLimit: policy.rateLimit, maxConcurrent: policy.maxConcurrent, result: 'allowed' });
    trace.append('CAPABILITY_CHECK', { action: task.action, capabilities: capTypes, result: 'allowed' });
    trace.append('CONTENT_AUDIT', { result: 'passed' });
    trace.append('TASK_FORWARDED', { executor_url: EXECUTOR_URL, timestamp: task.acceptedAt });
    trace.append('EXECUTOR_RESULT', { success: success !== false, duration_ms: durationMs, result_size: JSON.stringify(result).length });

    // ── Rollback on failure ──
    let rollbackReport = null;
    if (success === false) {
      trace.append('TASK_FAILED', { error: result?.error || 'Execution failed' });
      const rollback = new RollbackManager();
      // Register compensation: notify sender of failure
      rollback.registerCompensation('Notify sender of task failure', async () => {
        log({ event: 'rollback_notify', taskId, to: task.from, message: 'Task failed, compensating' });
      });
      // If executor reported side effects that need rollback
      if (result?.sideEffects && Array.isArray(result.sideEffects)) {
        for (const effect of result.sideEffects) {
          rollback.registerCompensation(effect.description || 'Undo side effect', async () => {
            if (effect.compensateUrl) {
              await fetch(effect.compensateUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(effect.compensatePayload || {}), signal: AbortSignal.timeout(10000) });
            }
          });
        }
      }
      rollbackReport = await rollback.rollbackAll();
      trace.append('ROLLBACK', { total: rollbackReport.total, succeeded: rollbackReport.succeeded, failed: rollbackReport.failed });
      trace.fail(new Error(result?.error || 'Execution failed'));
      log({ event: 'rollback_executed', taskId, total: rollbackReport.total, succeeded: rollbackReport.succeeded, failed: rollbackReport.failed });
    } else {
      trace.finalize(typeof result === 'object' ? result : { result });
    }

    // ── Proof Generation ──
    const proofGen = new ProofGenerator(trace, id);
    const proof = proofGen.generate(capTypes.join(',') || 'no-policy', `task-from-${task.from}`, JSON.stringify(result));

    // ── On-chain Anchoring ──
    const anchor = await anchorOnChain(proof.trace_root, { proof_id: proof.proof_id, task_from: task.from, action: task.action, taskId });

    // ── Trust Score Update ──
    try {
      if (anchor?.txHash) {
        trustScoreClient.addProofRecord({
          traceRoot: proof.trace_root,
          txHash: anchor.txHash,
          chain: 'solana',
          executor: id.did,
          taskFrom: task.from,
          action: task.action,
          success: success !== false,
          durationMs,
          riskLevel: 'low',
          policyViolations: 0,
          proofId: proof.proof_id,
          timestamp: new Date().toISOString(),
          verified: true,
        });
        const scoreReport = trustScoreClient.getAgentScore(id.did);
        log({ event: 'trust_score_updated', did: id.did, score: scoreReport.trust_score, total_tasks: scoreReport.total_tasks, success_rate: scoreReport.success_rate });

        // Update score on Registry (direct API call)
        try {
          const { serializePayload } = await import('@lawreneliang/atel-sdk');
          const ts = new Date().toISOString();
          const scorePayload = { did: id.did, trustScore: scoreReport.trust_score };
          const signable = serializePayload({ payload: scorePayload, did: id.did, timestamp: ts });
          const { default: nacl } = await import('tweetnacl');
          const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), id.secretKey)).toString('base64');
          await fetch(`${REGISTRY_URL}/registry/v1/score/update`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: scorePayload, did: id.did, timestamp: ts, signature: sig }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (e) { log({ event: 'score_registry_update_failed', error: e.message }); }
      } else {
        log({ event: 'trust_score_skipped', reason: 'No on-chain anchor — score requires verified proof' });
      }
    } catch (e) { log({ event: 'trust_score_error', error: e.message }); }

    // ── Anchoring Warning ──
    if (!anchor) {
      log({ event: 'anchor_missing', taskId, warning: 'Proof not anchored on-chain. Set ATEL_SOLANA_PRIVATE_KEY for verifiable trust.', timestamp: new Date().toISOString() });
    }

    log({ event: 'task_completed', taskId, from: task.from, action: task.action, success: success !== false, proof_id: proof.proof_id, trace_root: proof.trace_root, anchor_tx: anchor?.txHash || null, duration_ms: durationMs, timestamp: new Date().toISOString() });

    // Push result back to sender
    if (task.senderCandidates || task.senderEndpoint) {
      try {
        // Determine connection type and target
        let targetUrl = task.senderEndpoint;
        let isRelay = false;

        if (task.senderCandidates && task.senderCandidates.length > 0) {
          const conn = await connectToAgent(task.senderCandidates, task.from);
          if (conn) {
            targetUrl = conn.url;
            isRelay = conn.candidateType === 'relay';
          }
        }
        if (!targetUrl) throw new Error('No reachable endpoint');

        const resultPayload = {
          taskId,
          status: success !== false ? 'completed' : 'failed',
          result,
          proof: { proof_id: proof.proof_id, trace_root: proof.trace_root, events_count: trace.events.length },
          anchor: anchor ? { chain: 'solana', txHash: anchor.txHash, block: anchor.blockNumber } : null,
          execution: { duration_ms: durationMs, encrypted: task.encrypted },
          rollback: rollbackReport ? { total: rollbackReport.total, succeeded: rollbackReport.succeeded, failed: rollbackReport.failed } : null,
        };

        if (isRelay) {
          // Relay mode: use relay send API
          const relaySend = async (path, body) => {
            const resp = await fetch(targetUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ method: 'POST', path, body, from: id.did }),
              signal: AbortSignal.timeout(60000),
            });
            if (!resp.ok) throw new Error(`Relay ${path} failed: ${resp.status}`);
            return resp.json();
          };

          // Handshake via relay
          const hsManager = new HandshakeManager(id);
          const initMsg = hsManager.createInit(task.from);
          const ackMsg = await relaySend('/atel/v1/handshake', initMsg);
          const { confirm } = hsManager.processAck(ackMsg);
          await relaySend('/atel/v1/handshake', confirm);

          // Send result via relay
          const msg = createMessage({ type: 'task-result', from: id.did, to: task.from, payload: resultPayload, secretKey: id.secretKey });
          await relaySend('/atel/v1/task', msg);
        } else {
          // Direct mode
          const client = new AgentClient(id);
          const hsManager = new HandshakeManager(id);
          await client.handshake(targetUrl, hsManager, task.from);
          const msg = createMessage({ type: 'task-result', from: id.did, to: task.from, payload: resultPayload, secretKey: id.secretKey });
          await client.sendTask(targetUrl, msg, hsManager);
        }

        log({ event: 'result_pushed', taskId, to: task.from, via: targetUrl, relay: isRelay });
      } catch (e) { log({ event: 'result_push_failed', taskId, error: e.message }); }
    }

    delete pendingTasks[taskId]; saveTasks(pendingTasks);
    res.json({ status: 'ok', proof_id: proof.proof_id, anchor_tx: anchor?.txHash || null });
  });

  // Task handler
  endpoint.onTask(async (message, session) => {
    const payload = message.payload || {};

    // Ignore task-result messages (these are responses, not new tasks)
    if (message.type === 'task-result' || payload.status === 'completed' || payload.status === 'failed') {
      log({ event: 'result_received', from: message.from, taskId: payload.taskId, status: payload.status, timestamp: new Date().toISOString() });
      return { status: 'ok', message: 'Result received' };
    }

    const action = payload.action || payload.type || 'unknown';

    // ── Nonce anti-replay check ──
    const nonce = payload.nonce || message.nonce;
    if (nonce) {
      if (usedNonces.has(nonce)) {
        const rp = generateRejectionProof(message.from, action, 'Replay detected: nonce already used', 'REPLAY_REJECTED');
        log({ event: 'task_rejected', from: message.from, action, reason: 'Replay: duplicate nonce', nonce, timestamp: new Date().toISOString() });
        return { status: 'rejected', error: 'Replay detected: nonce already used', proof: rp };
      }
      usedNonces.add(nonce);
      saveNonces();
    }

    // ── Protocol-level content audit (SDK layer) ──
    const auditor = new ContentAuditor();
    const auditResult = auditor.audit(payload, { action, from: message.from });
    if (!auditResult.safe) {
      const rp = generateRejectionProof(message.from, action, `Content audit: ${auditResult.reason}`, 'CONTENT_AUDIT_FAILED');
      log({ event: 'task_rejected', from: message.from, action, reason: `Content audit: ${auditResult.reason}`, severity: auditResult.severity, pattern: auditResult.pattern, timestamp: new Date().toISOString() });
      return { status: 'rejected', error: `Security: ${auditResult.reason}`, severity: auditResult.severity, proof: rp };
    }

    // ── Policy check ──
    const pc = enforcer.check(message);
    if (!pc.allowed) {
      const rp = generateRejectionProof(message.from, action, pc.reason, 'POLICY_VIOLATION');
      log({ event: 'task_rejected', from: message.from, action, reason: pc.reason, timestamp: new Date().toISOString() });
      return { status: 'rejected', error: pc.reason, proof: rp };
    }

    // ── Capability check ──
    if (capTypes.length > 0 && !capTypes.includes(action) && !capTypes.includes('general')) {
      const reason = `Outside capability: [${capTypes.join(',')}]`;
      const rp = generateRejectionProof(message.from, action, reason, 'CAPABILITY_REJECTED');
      log({ event: 'task_rejected', from: message.from, action, reason, timestamp: new Date().toISOString() });
      return { status: 'rejected', error: `Action "${action}" outside capability boundary`, capabilities: capTypes, proof: rp };
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    enforcer.taskStarted();

    // Lookup sender endpoint/candidates for result push-back
    let senderEndpoint = null;
    let senderCandidates = null;
    try {
      const r = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(message.from)}`);
      if (r.ok) {
        const data = await r.json();
        senderEndpoint = data.endpoint;
        senderCandidates = data.candidates;
      }
    } catch {}

    pendingTasks[taskId] = { from: message.from, action, payload, senderEndpoint, senderCandidates, encrypted: !!session?.encrypted, acceptedAt: new Date().toISOString() };
    saveTasks(pendingTasks);
    log({ event: 'task_accepted', taskId, from: message.from, action, encrypted: !!session?.encrypted, timestamp: new Date().toISOString() });

    // Forward to executor or echo
    if (EXECUTOR_URL) {
      fetch(EXECUTOR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, from: message.from, action, payload, encrypted: !!session?.encrypted }) }).catch(e => log({ event: 'executor_forward_failed', taskId, error: e.message }));
      return { status: 'accepted', taskId, message: 'Task accepted. Result will be pushed when ready.' };
    } else {
      // Echo mode
      enforcer.taskFinished();
      const trace = new ExecutionTrace(taskId, id);
      trace.append('TASK_ACCEPTED', { from: message.from, action, payload });
      const result = { status: 'no_executor', agent: id.agent_id, action, received_payload: payload };
      trace.append('TASK_ECHO', { result }); trace.finalize(result);
      const proofGen = new ProofGenerator(trace, id);
      const proof = proofGen.generate(capTypes.join(',') || 'no-policy', `task-from-${message.from}`, JSON.stringify(result));
      const anchor = await anchorOnChain(proof.trace_root, { proof_id: proof.proof_id, task_from: message.from, action, taskId });
      delete pendingTasks[taskId]; saveTasks(pendingTasks);
      log({ event: 'task_completed', taskId, from: message.from, action, mode: 'echo', proof_id: proof.proof_id, anchor_tx: anchor?.txHash || null, timestamp: new Date().toISOString() });
      return { status: 'completed', taskId, result, proof, anchor };
    }
  });

  endpoint.onProof(async (message) => { log({ event: 'proof_received', from: message.from, payload: message.payload, timestamp: new Date().toISOString() }); });

  await endpoint.start();

  // Auto-register to Registry with candidates
  if (capTypes.length > 0 && networkConfig.candidates.length > 0) {
    try {
      const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
      const bestDirect = networkConfig.candidates.find(c => c.type !== 'relay') || networkConfig.candidates[0];
      await regClient.register({ name: id.agent_id, capabilities: caps, endpoint: bestDirect.url, candidates: networkConfig.candidates }, id);
      log({ event: 'auto_registered', registry: REGISTRY_URL, candidates: networkConfig.candidates.length });
    } catch (e) { log({ event: 'auto_register_failed', error: e.message }); }
  }

  // Register with relay server and start polling for relayed requests
  const relayCandidate = networkConfig.candidates.find(c => c.type === 'relay');
  if (relayCandidate) {
    const relayUrl = relayCandidate.url;

    // Register
    try {
      const resp = await fetch(`${relayUrl}/relay/v1/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: id.did }), signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) log({ event: 'relay_registered', relay: relayUrl });
      else log({ event: 'relay_register_failed', error: await resp.text() });
    } catch (e) { log({ event: 'relay_register_failed', error: e.message }); }

    // Poll loop: check relay for incoming requests, forward to local endpoint
    const pollRelay = async () => {
      try {
        const resp = await fetch(`${relayUrl}/relay/v1/poll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ did: id.did }), signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return;
        const { requests } = await resp.json();
        for (const req of requests) {
          // Forward to local endpoint
          try {
            const localResp = await fetch(`http://127.0.0.1:${p}${req.path}`, {
              method: req.method || 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body),
              signal: AbortSignal.timeout(30000),
            });
            const body = await localResp.json();
            // Send response back to relay
            await fetch(`${relayUrl}/relay/v1/respond`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId: req.requestId, status: localResp.status, body }),
              signal: AbortSignal.timeout(5000),
            });
          } catch (e) {
            // Send error response
            await fetch(`${relayUrl}/relay/v1/respond`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId: req.requestId, status: 500, body: { error: e.message } }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
          }
        }
      } catch {}
    };

    // Poll every 2 seconds + re-register every 2 minutes
    setInterval(pollRelay, 2000);
    setInterval(async () => {
      try {
        await fetch(`${relayUrl}/relay/v1/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ did: id.did }), signal: AbortSignal.timeout(5000),
        });
      } catch {}
    }, 120000);
  }

  console.log(JSON.stringify({
    status: 'listening', agent_id: id.agent_id, did: id.did,
    port: p, candidates: networkConfig.candidates, capabilities: capTypes,
    policy: { rateLimit: policy.rateLimit, maxPayloadBytes: policy.maxPayloadBytes, maxConcurrent: policy.maxConcurrent, allowedDIDs: policy.allowedDIDs.length, blockedDIDs: policy.blockedDIDs.length },
    executor: EXECUTOR_URL || 'echo mode', inbox: INBOX_FILE,
  }, null, 2));

  // ── Tunnel (optional) ──
  let tunnelManager = null;
  const tunnelType = process.env.ATEL_TUNNEL; // 'localtunnel' or 'ngrok'
  if (tunnelType) {
    const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
    tunnelManager = new TunnelManager(tunnelType, p, regClient, id);
    await tunnelManager.start();
  }

  // ── Heartbeat ──
  const heartbeat = new HeartbeatManager(REGISTRY_URL, id);
  heartbeat.start();

  process.on('SIGINT', async () => { 
    heartbeat.stop();
    if (tunnelManager) await tunnelManager.stop();
    await endpoint.stop(); 
    process.exit(0); 
  });
  process.on('SIGTERM', async () => { 
    heartbeat.stop();
    if (tunnelManager) await tunnelManager.stop();
    await endpoint.stop(); 
    process.exit(0); 
  });
}

async function cmdInbox(count) {
  const n = parseInt(count || '20');
  if (!existsSync(INBOX_FILE)) { console.log(JSON.stringify({ messages: [], count: 0 })); return; }
  const lines = readFileSync(INBOX_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  const messages = lines.slice(-n).map(l => JSON.parse(l));
  console.log(JSON.stringify({ messages, count: messages.length, total: lines.length }, null, 2));
}

async function cmdRegister(name, capabilities, endpointUrl) {
  const id = requireIdentity();
  const caps = (capabilities || 'general').split(',').map(c => ({ type: c.trim(), description: c.trim() }));
  saveCapabilities(caps);
  // If no endpoint provided, use saved network config
  let ep = endpointUrl;
  if (!ep) { const net = loadNetwork(); ep = net?.endpoint || 'http://localhost:3100'; }
  const client = new RegistryClient({ registryUrl: REGISTRY_URL });
  const entry = await client.register({ name: name || id.agent_id, capabilities: caps, endpoint: ep }, id);
  console.log(JSON.stringify({ status: 'registered', did: entry.did, name: entry.name, capabilities: caps.map(c => c.type), endpoint: ep, registry: REGISTRY_URL }, null, 2));
}

async function cmdSearch(capability) {
  const client = new RegistryClient({ registryUrl: REGISTRY_URL });
  const result = await client.search({ type: capability, limit: 10 });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdHandshake(remoteEndpoint, remoteDid) {
  const id = requireIdentity();
  const client = new AgentClient(id);
  const hsManager = new HandshakeManager(id);
  let did = remoteDid;
  if (!did) { const h = await client.health(remoteEndpoint); did = h.did; }
  const session = await client.handshake(remoteEndpoint, hsManager, did);
  console.log(JSON.stringify({ status: 'handshake_complete', sessionId: session.sessionId, remoteDid: did, encrypted: session.encrypted }, null, 2));
  const sf = resolve(ATEL_DIR, 'sessions.json');
  let sessions = {}; if (existsSync(sf)) sessions = JSON.parse(readFileSync(sf, 'utf-8'));
  sessions[remoteEndpoint] = { did, sessionId: session.sessionId, encrypted: session.encrypted };
  writeFileSync(sf, JSON.stringify(sessions, null, 2));
}

async function cmdTask(target, taskJson) {
  const id = requireIdentity();

  let remoteEndpoint = target;
  let remoteDid;
  let connectionType = 'direct';

  // If target looks like a DID or name, search Registry and try candidates
  if (!target.startsWith('http')) {
    const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
    let entry;
    // Try as DID first
    try {
      const resp = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(target)}`);
      if (resp.ok) entry = await resp.json();
    } catch {}
    // Try as capability search
    if (!entry) {
      const results = await regClient.search({ type: target, limit: 5 });
      if (results.length > 0) entry = results[0];
    }
    if (!entry) { console.error(`Agent not found: ${target}`); process.exit(1); }

    remoteDid = entry.did;

    // Try candidates if available
    if (entry.candidates && entry.candidates.length > 0) {
      console.log(JSON.stringify({ event: 'connecting', did: remoteDid, candidates: entry.candidates.length }));
      const conn = await connectToAgent(entry.candidates, remoteDid);
      if (conn) {
        remoteEndpoint = conn.url;
        connectionType = conn.candidateType;
        console.log(JSON.stringify({ event: 'connected', type: conn.candidateType, url: conn.url, latencyMs: conn.latencyMs }));
      } else {
        console.error('All candidates unreachable'); process.exit(1);
      }
    } else {
      remoteEndpoint = entry.endpoint;
    }
  }

  if (connectionType === 'relay') {
    // Relay mode: all requests go through relay's /relay/v1/send/:did API
    const relayUrl = remoteEndpoint; // e.g. http://47.251.8.19:9000/relay/v1/send/did:atel:xxx

    async function relaySend(path, body) {
      const resp = await fetch(relayUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'POST', path, body, from: id.did }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(`Relay request to ${path} failed: ${resp.status} ${JSON.stringify(err)}`);
      }
      return resp.json();
    }

    // Step 1: handshake init
    const hsManager = new HandshakeManager(id);
    const initMsg = hsManager.createInit(remoteDid);
    const ackMsg = await relaySend('/atel/v1/handshake', initMsg);

    // Step 2: handshake confirm
    const { confirm } = hsManager.processAck(ackMsg);
    await relaySend('/atel/v1/handshake', confirm);

    // Step 3: send task
    const payload = typeof taskJson === 'string' ? JSON.parse(taskJson) : taskJson;
    const msg = createMessage({ type: 'task', from: id.did, to: remoteDid, payload, secretKey: id.secretKey });
    const result = await relaySend('/atel/v1/task', msg);

    console.log(JSON.stringify({ status: 'task_sent', remoteDid, via: 'relay', result }, null, 2));
  } else {
    // Direct mode: standard handshake + task
    const client = new AgentClient(id);
    const hsManager = new HandshakeManager(id);
    const sf = resolve(ATEL_DIR, 'sessions.json');
    if (!remoteDid) {
      const h = await client.health(remoteEndpoint); remoteDid = h.did;
    }
    await client.handshake(remoteEndpoint, hsManager, remoteDid);
    let sessions = {}; if (existsSync(sf)) sessions = JSON.parse(readFileSync(sf, 'utf-8'));
    sessions[remoteEndpoint] = { did: remoteDid };
    writeFileSync(sf, JSON.stringify(sessions, null, 2));

    const payload = typeof taskJson === 'string' ? JSON.parse(taskJson) : taskJson;
    const msg = createMessage({ type: 'task', from: id.did, to: remoteDid, payload, secretKey: id.secretKey });
    const result = await client.sendTask(remoteEndpoint, msg, hsManager);
    console.log(JSON.stringify({ status: 'task_sent', remoteDid, via: remoteEndpoint, result }, null, 2));
  }
}

async function cmdResult(taskId, resultJson) {
  const result = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
  const resp = await fetch(`http://localhost:${process.env.ATEL_PORT || '3100'}/atel/v1/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, result, success: true }) });
  console.log(JSON.stringify(await resp.json(), null, 2));
}

// ─── Main ────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;
const commands = {
  init: () => cmdInit(args[0]),
  info: () => cmdInfo(),
  setup: () => cmdSetup(args[0]),
  verify: () => cmdVerify(),
  start: () => cmdStart(args[0]),
  inbox: () => cmdInbox(args[0]),
  register: () => cmdRegister(args[0], args[1], args[2]),
  search: () => cmdSearch(args[0]),
  handshake: () => cmdHandshake(args[0], args[1]),
  task: () => cmdTask(args[0], args[1]),
  result: () => cmdResult(args[0], args[1]),
};

if (!cmd || !commands[cmd]) {
  console.log(`ATEL CLI - Agent Trust & Exchange Layer

Usage: atel <command> [args]

Commands:
  init [name]                          Create agent identity + security policy
  info                                 Show identity, capabilities, network, policy
  setup [port]                         Configure network (detect IP, UPnP, verify)
  verify                               Verify port reachability
  start [port]                         Start endpoint (auto network + auto register)
  inbox [count]                        Show received messages (default: 20)
  register [name] [caps] [endpoint]    Register on public registry
  search <capability>                  Search registry for agents
  handshake <endpoint> [did]           Handshake with remote agent
  task <endpoint> <json>               Delegate task to remote agent
  result <taskId> <json>               Submit execution result (from executor)

Environment:
  ATEL_DIR                Identity directory (default: .atel)
  ATEL_REGISTRY           Registry URL (default: http://47.251.8.19:8100)
  ATEL_EXECUTOR_URL       Local executor HTTP endpoint
  ATEL_SOLANA_PRIVATE_KEY Solana key for on-chain anchoring
  ATEL_SOLANA_RPC_URL     Solana RPC (default: mainnet-beta)

Network: atel start auto-detects public IP, attempts UPnP port mapping,
and registers to the Registry. If UPnP fails, configure port forwarding
on your router and run: atel verify`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
