#!/usr/bin/env node

/**
 * ATEL CLI — Command-line interface for ATEL SDK
 *
 * Protocol Commands:
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
 *
 * Account Commands:
 *   atel balance                        Show platform account balance
 *   atel deposit <amount> [channel]     Deposit funds
 *   atel withdraw <amount> [channel]    Withdraw funds
 *   atel transactions                   List payment history
 *
 * Trade Commands:
 *   atel order <did> <cap> <price>      Create a trade order
 *   atel accept <orderId>               Accept an order (executor)
 *   atel reject <orderId>               Reject an order (executor)
 *   atel escrow <orderId>               Freeze funds for order (requester)
 *   atel complete <orderId> [taskId]    Mark order complete (executor)
 *   atel confirm <orderId>              Confirm delivery + settle (requester)
 *   atel rate <orderId> <1-5> [comment] Rate the other party
 *   atel orders [role] [status]         List orders
 *
 * Dispute Commands:
 *   atel dispute <orderId> <reason>     Open a dispute
 *   atel evidence <disputeId> <json>    Submit dispute evidence
 *   atel disputes                       List your disputes
 *
 * Certification & Boost Commands:
 *   atel cert-apply [level]             Apply for certification
 *   atel cert-status [did]              Check certification status
 *   atel boost <tier> <weeks>           Purchase boost
 *   atel boost-status [did]             Check boost status
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  AgentIdentity, AgentEndpoint, AgentClient, HandshakeManager,
  createMessage, RegistryClient, ExecutionTrace, ProofGenerator,
  SolanaAnchorProvider, autoNetworkSetup, collectCandidates, connectToAgent,
  discoverPublicIP, checkReachable, ContentAuditor, TrustScoreClient,
  RollbackManager, rotateKey, verifyKeyRotation,
} from '@lawrenceliang-btc/atel-sdk';
import { TunnelManager, HeartbeatManager } from './tunnel-manager.mjs';

const ATEL_DIR = resolve(process.env.ATEL_DIR || '.atel');
const IDENTITY_FILE = resolve(ATEL_DIR, 'identity.json');
const REGISTRY_URL = process.env.ATEL_REGISTRY || 'http://47.251.8.19:8100';
const EXECUTOR_URL = process.env.ATEL_EXECUTOR_URL || '';
const INBOX_FILE = resolve(ATEL_DIR, 'inbox.jsonl');
const POLICY_FILE = resolve(ATEL_DIR, 'policy.json');
const TASKS_FILE = resolve(ATEL_DIR, 'tasks.json');
const NETWORK_FILE = resolve(ATEL_DIR, 'network.json');
const TRACES_DIR = resolve(ATEL_DIR, 'traces');

const DEFAULT_POLICY = { rateLimit: 60, maxPayloadBytes: 1048576, maxConcurrent: 10, allowedDIDs: [], blockedDIDs: [], trustPolicy: { minScore: 0, newAgentPolicy: 'allow_low_risk', riskThresholds: { low: 0, medium: 50, high: 75, critical: 90 } } };

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
function saveTrace(taskId, trace) { if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true }); writeFileSync(resolve(TRACES_DIR, `${taskId}.jsonl`), trace.export()); }
function loadTrace(taskId) { const f = resolve(TRACES_DIR, `${taskId}.jsonl`); if (!existsSync(f)) return null; return readFileSync(f, 'utf-8'); }

// Derive wallet addresses from env private keys
async function getWalletAddresses() {
  const wallets = {};
  // Solana: base58 private key → public key
  const solKey = process.env.ATEL_SOLANA_PRIVATE_KEY;
  if (solKey) {
    try {
      const { Keypair } = await import('@solana/web3.js');
      const bs58 = (await import('bs58')).default;
      const kp = Keypair.fromSecretKey(bs58.decode(solKey));
      wallets.solana = kp.publicKey.toBase58();
    } catch {}
  }
  // Base: hex private key → address
  const baseKey = process.env.ATEL_BASE_PRIVATE_KEY;
  if (baseKey) {
    try {
      const { ethers } = await import('ethers');
      wallets.base = new ethers.Wallet(baseKey).address;
    } catch {}
  }
  // BSC: hex private key → address
  const bscKey = process.env.ATEL_BSC_PRIVATE_KEY;
  if (bscKey) {
    try {
      const { ethers } = await import('ethers');
      wallets.bsc = new ethers.Wallet(bscKey).address;
    } catch {}
  }
  return Object.keys(wallets).length > 0 ? wallets : undefined;
}

// ─── Unified Trust Score & Level System ──────────────────────────
// Single source of truth: computeTrustScore() calculates score,
// trustLevel is derived from score. No independent logic.
//
// DUAL MODE:
//   - Local mode (default): Only uses local trust-history.json
//     Passive, only knows about direct interactions. Fast, no network.
//   - Chain-verified mode: Verifies anchor_tx on-chain + accepts peer-provided proofs
//     Active, can assess agents never interacted with. Requires RPC access.
//
// Score formula (0-100):
//   - Success rate:    successRate * 40  (max 40, baseline competence)
//   - Task volume:     min(tasks/30, 1) * 30  (max 30, needs 30 tasks for full credit)
//   - Verified proofs: verifiedRatio * 20 * sqrt(volFactor)  (max 20, scales with experience)
//   - Chain bonus:     +10 if 5+ verified proofs (sustained chain participation)
//
// Level mapping (derived from score):
//   Level 0 (zero_trust):       score < 30   → max risk: low
//   Level 1 (basic_trust):      score 30-64  → max risk: medium
//   Level 2 (verified_trust):   score 65-89  → max risk: high
//   Level 3 (enterprise_trust): score >= 90  → max risk: critical
//
// Upgrade path (best case, 100% success + all verified):
//   1 task  → 44 pts → L1    |  8 tasks → 68 pts → L2
//   25 tasks → 93 pts → L3   |  No proofs → capped at ~50 pts (L1)

function computeTrustScore(agentHistory) {
  if (!agentHistory || agentHistory.tasks === 0) return 0;
  const successRate = agentHistory.successes / agentHistory.tasks;
  const volFactor = Math.min(agentHistory.tasks / 30, 1);
  const successScore = successRate * 40;
  const volumeScore = volFactor * 30;
  const verifiedProofs = agentHistory.proofs ? agentHistory.proofs.filter(p => p.verified).length : 0;
  const verifiedRatio = agentHistory.proofs?.length > 0 ? verifiedProofs / agentHistory.proofs.length : 0;
  const proofScore = verifiedRatio * 20 * Math.sqrt(volFactor);
  const chainBonus = verifiedProofs >= 5 ? 10 : 0;
  return Math.min(100, Math.round((successScore + volumeScore + proofScore + chainBonus) * 100) / 100);
}

function computeTrustLevel(score) {
  if (score >= 90) return { level: 3, name: 'enterprise_trust', maxRisk: 'critical' };
  if (score >= 65) return { level: 2, name: 'verified_trust', maxRisk: 'high' };
  if (score >= 30) return { level: 1, name: 'basic_trust', maxRisk: 'medium' };
  return { level: 0, name: 'zero_trust', maxRisk: 'low' };
}

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
function riskAllowed(maxRisk, requestedRisk) { return (RISK_ORDER[requestedRisk] || 0) <= (RISK_ORDER[maxRisk] || 0); }

// Verify anchor_tx list on-chain, return count of valid proofs
async function verifyAnchorTxList(anchorTxList, targetDid) {
  if (!anchorTxList || anchorTxList.length === 0) return { verified: 0, total: 0, proofs: [] };
  const rpcUrl = process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const provider = new SolanaAnchorProvider({ rpcUrl });
  let verified = 0;
  const proofs = [];
  for (const tx of anchorTxList) {
    try {
      const result = await provider.verify(tx.trace_root || '', tx.txHash || tx.anchor_tx || '');
      if (result.valid) {
        verified++;
        proofs.push({ proof_id: tx.proof_id || tx.txHash, trace_root: tx.trace_root, verified: true, anchor_tx: tx.txHash || tx.anchor_tx, timestamp: new Date().toISOString() });
      }
    } catch {}
  }
  return { verified, total: anchorTxList.length, proofs };
}

// Unified trust check — single function used by all code paths
function checkTrust(remoteDid, risk, policy, force) {
  if (force) return { passed: true };
  const tp = policy.trustPolicy || DEFAULT_POLICY.trustPolicy;
  const localHistoryFile = resolve(ATEL_DIR, 'trust-history.json');
  let history = {};
  try { history = JSON.parse(readFileSync(localHistoryFile, 'utf-8')); } catch {}
  const agentHistory = history[remoteDid] || { tasks: 0, successes: 0, failures: 0, proofs: [] };
  const isNewAgent = agentHistory.tasks === 0;

  // New agent policy
  if (isNewAgent) {
    if (tp.newAgentPolicy === 'deny') return { passed: false, reason: 'Trust policy denies unknown agents', did: remoteDid, risk };
    if (tp.newAgentPolicy === 'allow_low_risk' && (risk === 'high' || risk === 'critical')) return { passed: false, reason: `New agent, policy only allows low risk (requested: ${risk})`, did: remoteDid };
  }

  // Compute score and level
  const score = computeTrustScore(agentHistory);
  const trustLevel = computeTrustLevel(score);
  const threshold = tp.riskThresholds?.[risk] ?? 0;

  // Check score threshold
  if (!isNewAgent && threshold > 0 && score < threshold) {
    return { passed: false, reason: `Score ${score} below threshold ${threshold} for ${risk} risk`, did: remoteDid, score, threshold, risk, level: trustLevel.level };
  }

  // Check level-based risk cap
  if (!riskAllowed(trustLevel.maxRisk, risk)) {
    return { passed: false, reason: `Trust level ${trustLevel.level} (${trustLevel.name}) only allows up to ${trustLevel.maxRisk} risk, requested ${risk}`, did: remoteDid, level: trustLevel.level, maxRisk: trustLevel.maxRisk };
  }

  return { passed: true, score, level: trustLevel.level, levelName: trustLevel.name, threshold };
}

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
    // Pass DID info for v2 structured memo: ATEL:1:<executorDID>:<requesterDID>:<taskId>:<trace_root>
    const r = await s.anchor(traceRoot, {
      executorDid: metadata?.executorDid,
      requesterDid: metadata?.requesterDid || metadata?.task_from,
      taskId: metadata?.taskId,
      ...metadata,
    });
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

  // ── Trace endpoint (for audit requests from other agents) ──
  endpoint.app?.get?.('/atel/v1/trace/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    const traceData = loadTrace(taskId);
    if (!traceData) { res.status(404).json({ error: 'Trace not found' }); return; }
    const events = traceData.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    res.json({ taskId, events, agent: id.did });
  });

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

    // ── Save Trace (for audit requests) ──
    saveTrace(taskId, trace);

    // ── Proof Generation ──
    const proofGen = new ProofGenerator(trace, id);
    const proof = proofGen.generate(capTypes.join(',') || 'no-policy', `task-from-${task.from}`, JSON.stringify(result));

    // ── On-chain Anchoring ──
    const anchor = await anchorOnChain(proof.trace_root, { proof_id: proof.proof_id, executorDid: id.did, requesterDid: task.from, taskId, action: task.action });

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
      log({ event: 'result_received', type: 'task-result', from: message.from, taskId: payload.taskId, status: payload.status, proof: payload.proof || null, anchor: payload.anchor || null, execution: payload.execution || null, result: payload.result || null, timestamp: new Date().toISOString() });
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

    // ── Capability check (strict matching, no wildcards) ──
    if (capTypes.length > 0 && !capTypes.includes(action)) {
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
      saveTrace(taskId, trace);
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
      const discoverable = policy.discoverable !== false;
      const wallets = await getWalletAddresses();
      await regClient.register({ name: id.agent_id, capabilities: caps, endpoint: bestDirect.url, candidates: networkConfig.candidates, discoverable, wallets }, id);
      log({ event: 'auto_registered', registry: REGISTRY_URL, candidates: networkConfig.candidates.length, discoverable, wallets: wallets ? Object.keys(wallets) : [] });
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
            const method = req.method || 'POST';
            const fetchOpts = {
              method,
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(30000),
            };
            if (method !== 'GET' && method !== 'HEAD') fetchOpts.body = JSON.stringify(req.body);
            const localResp = await fetch(`http://127.0.0.1:${p}${req.path}`, fetchOpts);
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
  const policy = loadPolicy();
  const caps = (capabilities || 'general').split(',').map(c => ({ type: c.trim(), description: c.trim() }));
  saveCapabilities(caps);
  let ep = endpointUrl;
  if (!ep) { const net = loadNetwork(); ep = net?.endpoint || 'http://localhost:3100'; }
  const discoverable = policy.discoverable !== false;
  const client = new RegistryClient({ registryUrl: REGISTRY_URL });
  const entry = await client.register({ name: name || id.agent_id, capabilities: caps, endpoint: ep, discoverable }, id);
  console.log(JSON.stringify({ status: 'registered', did: entry.did, name: entry.name, capabilities: caps.map(c => c.type), endpoint: ep, discoverable, registry: REGISTRY_URL }, null, 2));
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
  const policy = loadPolicy();
  const tp = policy.trustPolicy || DEFAULT_POLICY.trustPolicy;

  // Parse task payload and extract risk level
  const payload = typeof taskJson === 'string' ? JSON.parse(taskJson) : taskJson;
  const risk = payload._risk || 'low';
  delete payload._risk;
  const force = payload._force || false;
  delete payload._force;

  let remoteEndpoint = target;
  let remoteDid;
  let connectionType = 'direct';

  // If target looks like a DID or name, search Registry and try candidates
  if (!target.startsWith('http')) {
    const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
    let entry;
    try {
      const resp = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(target)}`);
      if (resp.ok) entry = await resp.json();
    } catch {}
    if (!entry) {
      const results = await regClient.search({ type: target, limit: 5 });
      if (results.length > 0) entry = results[0];
    }
    if (!entry) { console.error(`Agent not found: ${target}`); process.exit(1); }

    remoteDid = entry.did;

    // ── Pre-task trust check (unified) ──
    const trustResult = checkTrust(remoteDid, risk, policy, force);
    if (!trustResult.passed) {
      console.log(JSON.stringify({ status: 'blocked', ...trustResult }));
      process.exit(1);
    }
    if (!force) {
      console.log(JSON.stringify({ event: 'trust_check_passed', did: remoteDid, risk, score: trustResult.score, level: trustResult.level, level_name: trustResult.levelName }));
    }

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

  // ── Helper: update local trust history after task ──
  function updateTrustHistory(did, success, proofInfo) {
    const localHistoryFile = resolve(ATEL_DIR, 'trust-history.json');
    let history = {};
    try { history = JSON.parse(readFileSync(localHistoryFile, 'utf-8')); } catch {}
    if (!history[did]) history[did] = { tasks: 0, successes: 0, failures: 0, lastSeen: null, proofs: [] };
    history[did].tasks++;
    if (success) history[did].successes++; else history[did].failures++;
    history[did].lastSeen = new Date().toISOString();
    if (proofInfo) history[did].proofs.push(proofInfo);
    writeFileSync(localHistoryFile, JSON.stringify(history, null, 2));
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
    const msg = createMessage({ type: 'task', from: id.did, to: remoteDid, payload, secretKey: id.secretKey });
    const relayAck = await relaySend('/atel/v1/task', msg);

    console.log(JSON.stringify({ status: 'task_sent', remoteDid, via: 'relay', relay_ack: relayAck, note: 'Relay mode is async. Waiting for result (up to 120s)...' }));

    // Wait for result to arrive in inbox (poll for task-result)
    const taskId = msg.id || msg.payload?.taskId;
    let result = null;
    const waitStart = Date.now();
    const WAIT_TIMEOUT = 120000; // 2 minutes
    while (Date.now() - waitStart < WAIT_TIMEOUT) {
      await new Promise(r => setTimeout(r, 3000)); // poll every 3s
      if (existsSync(INBOX_FILE)) {
        const lines = readFileSync(INBOX_FILE, 'utf-8').split('\n').filter(l => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            // Look for result_received from the target
            if (entry.event === 'result_received' && entry.from === remoteDid) {
              result = { taskId: entry.taskId, status: entry.status, result: entry.result, proof: entry.proof, anchor: entry.anchor, execution: entry.execution };
              break;
            }
          } catch {}
        }
        if (result) break;
      }
    }

    if (result) {
      console.log(JSON.stringify({ status: 'task_completed', remoteDid, via: 'relay', result }, null, 2));
    } else {
      console.log(JSON.stringify({ status: 'task_sent_no_result', remoteDid, via: 'relay', note: 'Result not received within timeout. Check: atel inbox' }, null, 2));
    }

    // Update local trust history
    const success = result?.status === 'completed' || (result && result?.status !== 'rejected' && result?.status !== 'failed');
    const proofInfo = result?.proof ? { proof_id: result.proof.proof_id, trace_root: result.proof.trace_root, verified: !!result?.anchor?.txHash, anchor_tx: result?.anchor?.txHash || null, timestamp: new Date().toISOString() } : null;
    if (remoteDid) updateTrustHistory(remoteDid, success, proofInfo);
  } else {
    // Direct mode: standard handshake + task
    const client = new AgentClient(id);
    const hsManager = new HandshakeManager(id);
    const sf = resolve(ATEL_DIR, 'sessions.json');
    if (!remoteDid) {
      const h = await client.health(remoteEndpoint); remoteDid = h.did;
    }

    // Trust check for direct mode too (unified)
    if (!force && remoteDid) {
      const trustResult = checkTrust(remoteDid, risk, policy, false);
      if (!trustResult.passed) {
        console.log(JSON.stringify({ status: 'blocked', ...trustResult }));
        process.exit(1);
      }
    }
    await client.handshake(remoteEndpoint, hsManager, remoteDid);
    let sessions = {}; if (existsSync(sf)) sessions = JSON.parse(readFileSync(sf, 'utf-8'));
    sessions[remoteEndpoint] = { did: remoteDid };
    writeFileSync(sf, JSON.stringify(sessions, null, 2));

    const msg = createMessage({ type: 'task', from: id.did, to: remoteDid, payload, secretKey: id.secretKey });
    const result = await client.sendTask(remoteEndpoint, msg, hsManager);
    console.log(JSON.stringify({ status: 'task_sent', remoteDid, via: remoteEndpoint, result }, null, 2));

    // Update local trust history
    const success = result?.status !== 'rejected' && result?.status !== 'failed';
    const proofInfo = result?.proof ? { proof_id: result.proof.proof_id, trace_root: result.proof.trace_root, verified: !!result?.anchor?.txHash, anchor_tx: result?.anchor?.txHash || null, timestamp: new Date().toISOString() } : null;
    if (remoteDid) updateTrustHistory(remoteDid, success, proofInfo);
  }
}

async function cmdResult(taskId, resultJson) {
  const result = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
  const resp = await fetch(`http://localhost:${process.env.ATEL_PORT || '3100'}/atel/v1/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, result, success: true }) });
  console.log(JSON.stringify(await resp.json(), null, 2));
}

// ─── Trust Verification Commands ─────────────────────────────────

async function cmdCheck(targetDid, riskLevel, options) {
  const risk = riskLevel || 'low';
  const chainMode = options?.chain || !!process.env.ATEL_SOLANA_RPC_URL;
  const policy = loadPolicy();
  const tp = policy.trustPolicy || DEFAULT_POLICY.trustPolicy;

  console.log(JSON.stringify({ event: 'checking_trust', did: targetDid, risk, mode: chainMode ? 'chain-verified' : 'local-only' }));

  // 1. Get Registry info (reference only, includes wallets)
  let registryScore = null;
  let agentName = null;
  let peerWallets = null;
  try {
    const r = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(targetDid)}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json();
      registryScore = d.trustScore;
      agentName = d.name;
      if (d.wallets) peerWallets = d.wallets;
    }
  } catch {}

  // 2. Local interaction history
  const localHistoryFile = resolve(ATEL_DIR, 'trust-history.json');
  let history = {};
  try { history = JSON.parse(readFileSync(localHistoryFile, 'utf-8')); } catch {}
  const agentHistory = history[targetDid] || { tasks: 0, successes: 0, failures: 0, lastSeen: null, proofs: [] };

  // 3. Chain-verified mode: query all three chains by wallet address
  let chainVerification = null;
  if (chainMode) {
    const chainResults = { solana: null, base: null, bsc: null, totalRecords: 0, matchingDid: 0 };

    // 3a. Verify unverified local proofs on-chain
    const unverifiedProofs = agentHistory.proofs.filter(p => !p.verified && p.anchor_tx);
    if (unverifiedProofs.length > 0) {
      console.log(JSON.stringify({ event: 'verifying_local_proofs', count: unverifiedProofs.length }));
      const result = await verifyAnchorTxList(unverifiedProofs, targetDid);
      for (const vp of result.proofs) {
        const existing = agentHistory.proofs.find(p => p.anchor_tx === vp.anchor_tx);
        if (existing) existing.verified = true;
      }
      history[targetDid] = agentHistory;
      try { writeFileSync(localHistoryFile, JSON.stringify(history, null, 2)); } catch {}
    }

    // 3b. Query peer's wallet addresses on all three chains
    if (peerWallets) {
      console.log(JSON.stringify({ event: 'querying_chain_history', wallets: peerWallets }));

      // Solana
      if (peerWallets.solana) {
        try {
          const rpcUrl = process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
          const provider = new SolanaAnchorProvider({ rpcUrl });
          const records = await provider.queryByWallet(peerWallets.solana, { limit: 100, filterDid: targetDid });
          chainResults.solana = { wallet: peerWallets.solana, records: records.length, asExecutor: records.filter(r => r.executorDid === targetDid).length, asRequester: records.filter(r => r.requesterDid === targetDid).length };
          chainResults.totalRecords += records.length;
          chainResults.matchingDid += records.length;
        } catch (e) { chainResults.solana = { error: e.message }; }
      }

      // Base
      if (peerWallets.base) {
        try {
          const { BaseAnchorProvider } = await import('@lawrenceliang-btc/atel-sdk');
          const baseRpc = process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org';
          const provider = new BaseAnchorProvider({ rpcUrl: baseRpc });
          const explorerApi = process.env.ATEL_BASE_EXPLORER_API || 'https://api.basescan.org/api';
          const apiKey = process.env.ATEL_BASE_EXPLORER_KEY;
          const records = await provider.queryByWallet(peerWallets.base, explorerApi, apiKey, { limit: 100, filterDid: targetDid });
          chainResults.base = { wallet: peerWallets.base, records: records.length, asExecutor: records.filter(r => r.executorDid === targetDid).length, asRequester: records.filter(r => r.requesterDid === targetDid).length };
          chainResults.totalRecords += records.length;
          chainResults.matchingDid += records.length;
        } catch (e) { chainResults.base = { error: e.message }; }
      }

      // BSC
      if (peerWallets.bsc) {
        try {
          const { BSCAnchorProvider } = await import('@lawrenceliang-btc/atel-sdk');
          const bscRpc = process.env.ATEL_BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
          const provider = new BSCAnchorProvider({ rpcUrl: bscRpc });
          const explorerApi = process.env.ATEL_BSC_EXPLORER_API || 'https://api.bscscan.com/api';
          const apiKey = process.env.ATEL_BSC_EXPLORER_KEY;
          const records = await provider.queryByWallet(peerWallets.bsc, explorerApi, apiKey, { limit: 100, filterDid: targetDid });
          chainResults.bsc = { wallet: peerWallets.bsc, records: records.length, asExecutor: records.filter(r => r.executorDid === targetDid).length, asRequester: records.filter(r => r.requesterDid === targetDid).length };
          chainResults.totalRecords += records.length;
          chainResults.matchingDid += records.length;
        } catch (e) { chainResults.bsc = { error: e.message }; }
      }
    }

    chainVerification = chainResults;
  }

  // 4. Compute unified trust score and level
  const computedScore = computeTrustScore(agentHistory);
  const trustLevel = computeTrustLevel(computedScore);

  // 5. Apply trust policy
  const threshold = tp.riskThresholds?.[risk] ?? 0;
  const effectiveScore = computedScore > 0 ? computedScore : (registryScore || 0);
  const isNewAgent = agentHistory.tasks === 0;
  let decision = 'allow';
  let reason = '';

  if (isNewAgent) {
    if (tp.newAgentPolicy === 'deny') { decision = 'deny'; reason = 'New agent, policy denies unknown agents'; }
    else if (tp.newAgentPolicy === 'allow_low_risk' && (risk === 'high' || risk === 'critical')) { decision = 'deny'; reason = `New agent, policy only allows low risk (requested: ${risk})`; }
    else { decision = 'allow'; reason = `New agent, policy: ${tp.newAgentPolicy}`; }
  } else if (effectiveScore < threshold) {
    decision = 'deny';
    reason = `Score ${effectiveScore} below threshold ${threshold} for ${risk} risk`;
  } else if (!riskAllowed(trustLevel.maxRisk, risk)) {
    decision = 'deny';
    reason = `Trust level ${trustLevel.level} (${trustLevel.name}) only allows up to ${trustLevel.maxRisk} risk, requested ${risk}`;
  } else {
    decision = 'allow';
    reason = `Score ${effectiveScore} meets threshold ${threshold} for ${risk} risk`;
  }

  const output = {
    did: targetDid,
    name: agentName,
    mode: chainMode ? 'chain-verified' : 'local-only',
    trust: {
      computed_score: computedScore,
      registry_score: registryScore,
      effective_score: effectiveScore,
      level: trustLevel.level,
      level_name: trustLevel.name,
      max_risk: trustLevel.maxRisk,
      total_tasks: agentHistory.tasks,
      successes: agentHistory.successes,
      failures: agentHistory.failures,
      verified_proofs: agentHistory.proofs.filter(p => p.verified).length,
      total_proofs: agentHistory.proofs.length,
    },
    policy: { risk, threshold, decision, reason },
  };
  if (chainVerification) output.chain_verification = chainVerification;
  if (!chainMode) output.note = 'Local-only mode: score based on direct interaction history only. Set ATEL_SOLANA_RPC_URL or use --chain for on-chain verification.';

  console.log(JSON.stringify(output, null, 2));
}

async function cmdVerifyProof(anchorTx, traceRoot) {
  if (!anchorTx || !traceRoot) { console.error('Usage: atel verify-proof <anchor_tx> <trace_root>'); process.exit(1); }

  console.log(JSON.stringify({ event: 'verifying_proof', anchor_tx: anchorTx, trace_root: traceRoot }));

  const rpcUrl = process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    const provider = new SolanaAnchorProvider({ rpcUrl });
    const result = await provider.verify(traceRoot, anchorTx);
    console.log(JSON.stringify({
      verified: result.valid,
      chain: 'solana',
      anchor_tx: anchorTx,
      trace_root: traceRoot,
      detail: result.detail || (result.valid ? 'Memo matches trace_root' : 'Memo does not match'),
      block: result.blockNumber,
      timestamp: result.timestamp,
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ verified: false, error: e.message }));
  }
}

async function cmdAudit(targetDidOrUrl, taskId) {
  if (!targetDidOrUrl || !taskId) { console.error('Usage: atel audit <did_or_endpoint> <taskId>'); process.exit(1); }

  const id = requireIdentity();

  // Resolve endpoint
  let endpoint = targetDidOrUrl;
  let connectionType = 'direct';
  if (targetDidOrUrl.startsWith('did:')) {
    try {
      const r = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(targetDidOrUrl)}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        if (d.candidates && d.candidates.length > 0) {
          const conn = await connectToAgent(d.candidates, targetDidOrUrl);
          if (conn) { endpoint = conn.url; connectionType = conn.candidateType; }
        }
        if (endpoint === targetDidOrUrl && d.endpoint) endpoint = d.endpoint;
      }
    } catch {}
  }

  if (endpoint.startsWith('did:')) { console.error('Could not resolve endpoint for DID'); process.exit(1); }

  console.log(JSON.stringify({ event: 'auditing', target: endpoint, taskId, via: connectionType }));

  try {
    let traceData;
    if (connectionType === 'relay') {
      // Relay mode: send GET-like request through relay
      const resp = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', path: `/atel/v1/trace/${taskId}`, from: id.did }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) { console.log(JSON.stringify({ audit: 'failed', error: `Relay trace fetch failed: ${resp.status}` })); return; }
      traceData = await resp.json();
    } else {
      // Direct mode
      const traceUrl = endpoint.replace(/\/$/, '') + `/atel/v1/trace/${taskId}`;
      const resp = await fetch(traceUrl, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) { console.log(JSON.stringify({ audit: 'failed', error: `Trace fetch failed: ${resp.status}` })); return; }
      traceData = await resp.json();
    }

    // Verify hash chain
    const events = traceData.events || [];
    let chainValid = true;
    const chainErrors = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const expectedPrev = i === 0 ? '0x00' : events[i - 1].hash;
      if (e.prev !== expectedPrev) {
        chainValid = false;
        chainErrors.push(`Event #${e.seq}: prev mismatch (expected ${expectedPrev}, got ${e.prev})`);
      }
    }

    // Recompute merkle root
    const { createHash } = await import('node:crypto');
    const hashes = events.map(e => e.hash);
    let level = [...hashes];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : left;
        next.push(createHash('sha256').update(left + right).digest('hex'));
      }
      level = next;
    }
    const computedRoot = level[0] || '';

    console.log(JSON.stringify({
      audit: 'complete',
      taskId,
      agent: traceData.agent,
      events_count: events.length,
      hash_chain_valid: chainValid,
      chain_errors: chainErrors,
      computed_merkle_root: computedRoot,
      event_types: events.map(e => e.type),
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ audit: 'failed', error: e.message }));
  }
}

// ─── Key Rotation ────────────────────────────────────────────────

async function cmdRotate() {
  const oldId = requireIdentity();
  const oldDid = oldId.did;

  // Backup old identity
  const backupFile = resolve(ATEL_DIR, `identity.backup.${Date.now()}.json`);
  writeFileSync(backupFile, readFileSync(IDENTITY_FILE, 'utf-8'));

  // Rotate
  const { newIdentity, proof } = rotateKey(oldId);
  saveIdentity(newIdentity);

  // Save rotation proof
  const proofsDir = resolve(ATEL_DIR, 'rotation-proofs');
  if (!existsSync(proofsDir)) mkdirSync(proofsDir, { recursive: true });
  writeFileSync(resolve(proofsDir, `${Date.now()}.json`), JSON.stringify(proof, null, 2));

  // Anchor rotation on-chain if possible
  let anchor = null;
  const key = process.env.ATEL_SOLANA_PRIVATE_KEY;
  if (key) {
    try {
      const s = new SolanaAnchorProvider({ rpcUrl: process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', privateKey: key });
      const { createHash } = await import('node:crypto');
      const rotationHash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
      anchor = await s.anchor(`rotation:${rotationHash}`, { oldDid, newDid: newIdentity.did, type: 'key_rotation' });
    } catch (e) { console.log(JSON.stringify({ warning: 'On-chain anchor failed', error: e.message })); }
  }

  // Update Registry
  try {
    const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
    const caps = loadCapabilities();
    const net = loadNetwork();
    const policy = loadPolicy();
    const ep = net?.endpoint || 'http://localhost:3100';
    const discoverable = policy.discoverable !== false;
    await regClient.register({ name: newIdentity.agent_id, capabilities: caps, endpoint: ep, candidates: net?.candidates || [], discoverable }, newIdentity);
    console.log(JSON.stringify({ event: 'registry_updated', newDid: newIdentity.did }));
  } catch (e) { console.log(JSON.stringify({ warning: 'Registry update failed', error: e.message })); }

  console.log(JSON.stringify({
    status: 'rotated',
    oldDid,
    newDid: newIdentity.did,
    backup: backupFile,
    proof_valid: verifyKeyRotation(proof),
    anchor: anchor ? { chain: 'solana', txHash: anchor.txHash } : null,
    next: 'Restart endpoint: atel start [port]',
  }, null, 2));
}

// ─── Platform API Helpers ────────────────────────────────────────

const PLATFORM_URL = process.env.ATEL_PLATFORM || process.env.ATEL_REGISTRY || 'http://47.251.8.19:8100';

async function signedFetch(method, path, payload = {}) {
  const id = requireIdentity();
  const { default: nacl } = await import('tweetnacl');
  const { serializePayload } = await import('@lawrenceliang-btc/atel-sdk');
  const ts = new Date().toISOString();
  const signable = serializePayload({ payload, did: id.did, timestamp: ts });
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), id.secretKey)).toString('base64');
  const body = JSON.stringify({ did: id.did, payload, timestamp: ts, signature: sig });
  // Always use POST for signed requests (DIDAuth reads body, GET cannot have body)
  const res = await fetch(`${PLATFORM_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Account Commands ────────────────────────────────────────────

async function cmdBalance() {
  const data = await signedFetch('GET', '/account/v1/balance');
  console.log(JSON.stringify(data, null, 2));
}

async function cmdDeposit(amount, channel) {
  if (!amount || isNaN(amount)) { console.error('Usage: atel deposit <amount> [channel]'); process.exit(1); }
  const data = await signedFetch('POST', '/account/v1/deposit', { amount: parseFloat(amount), channel: channel || 'manual' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdWithdraw(amount, channel) {
  if (!amount || isNaN(amount)) { console.error('Usage: atel withdraw <amount> [channel]'); process.exit(1); }
  const data = await signedFetch('POST', '/account/v1/withdraw', { amount: parseFloat(amount), channel: channel || 'manual' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdTransactions() {
  const data = await signedFetch('GET', '/account/v1/transactions');
  console.log(JSON.stringify(data, null, 2));
}

// ─── Trade Commands ──────────────────────────────────────────────

async function cmdOrder(executorDid, capType, price) {
  if (!executorDid || !capType || !price) { console.error('Usage: atel order <executorDid> <capabilityType> <price> [currency]'); process.exit(1); }
  const data = await signedFetch('POST', '/trade/v1/order', {
    executorDid, capabilityType: capType, priceAmount: parseFloat(price), priceCurrency: 'USD', pricingModel: 'per_task',
  });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdOrderInfo(orderId) {
  if (!orderId) { console.error('Usage: atel order-info <orderId>'); process.exit(1); }
  const res = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdAccept(orderId) {
  if (!orderId) { console.error('Usage: atel accept <orderId>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/accept`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdReject(orderId) {
  if (!orderId) { console.error('Usage: atel reject <orderId>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/reject`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdEscrow(orderId) {
  if (!orderId) { console.error('Usage: atel escrow <orderId>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/escrow`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdComplete(orderId, taskId) {
  if (!orderId) { console.error('Usage: atel complete <orderId> [taskId] [--proof]'); process.exit(1); }
  const payload = {};
  if (taskId) payload.taskId = taskId;
  // Auto-attach proof if trace exists for this task
  if (taskId) {
    const traceData = loadTrace(taskId);
    if (traceData) {
      try {
        const lines = traceData.trim().split('\n').map(l => JSON.parse(l));
        const proofLine = lines.find(l => l.proof_id);
        if (proofLine) payload.proofBundle = proofLine;
        const anchorLine = lines.find(l => l.anchor_tx);
        if (anchorLine) { payload.anchorTx = anchorLine.anchor_tx; payload.traceRoot = anchorLine.trace_root; }
      } catch {}
    }
  }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/complete`, payload);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdConfirm(orderId) {
  if (!orderId) { console.error('Usage: atel confirm <orderId>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/confirm`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdRate(orderId, rating, comment) {
  if (!orderId || !rating) { console.error('Usage: atel rate <orderId> <1-5> [comment]'); process.exit(1); }
  const r = parseInt(rating);
  if (r < 1 || r > 5) { console.error('Rating must be 1-5'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/rate`, { rating: r, comment: comment || '' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdOrders(role, status) {
  const params = new URLSearchParams();
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  const qs = params.toString() ? '?' + params.toString() : '';
  const data = await signedFetch('GET', `/trade/v1/orders${qs}`);
  console.log(JSON.stringify(data, null, 2));
}

// ─── Dispute Commands ────────────────────────────────────────────

async function cmdDispute(orderId, reason, description) {
  if (!orderId || !reason) { console.error('Usage: atel dispute <orderId> <reason> [description]\nReasons: quality, incomplete, timeout, fraud, malicious, other'); process.exit(1); }
  const data = await signedFetch('POST', '/dispute/v1/open', { orderId, reason, description: description || '' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdEvidence(disputeId, evidenceJson) {
  if (!disputeId || !evidenceJson) { console.error('Usage: atel evidence <disputeId> <json>'); process.exit(1); }
  let evidence;
  try { evidence = JSON.parse(evidenceJson); } catch { console.error('Invalid JSON'); process.exit(1); }
  const data = await signedFetch('POST', `/dispute/v1/${disputeId}/evidence`, { evidence });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdDisputes() {
  const data = await signedFetch('GET', '/dispute/v1/list');
  console.log(JSON.stringify(data, null, 2));
}

async function cmdDisputeInfo(disputeId) {
  if (!disputeId) { console.error('Usage: atel dispute-info <disputeId>'); process.exit(1); }
  const res = await fetch(`${PLATFORM_URL}/dispute/v1/${disputeId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
}

// ─── Cert Commands ───────────────────────────────────────────────

async function cmdCertApply(level) {
  const data = await signedFetch('POST', '/cert/v1/apply', { level: level || 'certified' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdCertStatus(did) {
  const targetDid = did || requireIdentity().did;
  const res = await fetch(`${PLATFORM_URL}/cert/v1/status/${encodeURIComponent(targetDid)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdCertRenew(level) {
  const data = await signedFetch('POST', '/cert/v1/renew', { level: level || 'certified' });
  console.log(JSON.stringify(data, null, 2));
}

// ─── Boost Commands ──────────────────────────────────────────────

async function cmdBoost(tier, weeks) {
  if (!tier || !weeks) { console.error('Usage: atel boost <tier> <weeks>\nTiers: basic ($10/wk), premium ($30/wk), featured ($100/wk)'); process.exit(1); }
  const data = await signedFetch('POST', '/boost/v1/purchase', { tier, weeks: parseInt(weeks) });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdBoostStatus(did) {
  const targetDid = did || requireIdentity().did;
  const res = await fetch(`${PLATFORM_URL}/boost/v1/status/${encodeURIComponent(targetDid)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdBoostCancel(boostId) {
  if (!boostId) { console.error('Usage: atel boost-cancel <boostId>'); process.exit(1); }
  const data = await signedFetch('DELETE', `/boost/v1/cancel/${boostId}`);
  console.log(JSON.stringify(data, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────

const [,, cmd, ...rawArgs] = process.argv;
const args = rawArgs.filter(a => !a.startsWith('--'));
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
  check: () => cmdCheck(args[0], args[1], { chain: rawArgs.includes('--chain') }),
  'verify-proof': () => cmdVerifyProof(args[0], args[1]),
  audit: () => cmdAudit(args[0], args[1]),
  rotate: () => cmdRotate(),
  // Account
  balance: () => cmdBalance(),
  deposit: () => cmdDeposit(args[0], args[1]),
  withdraw: () => cmdWithdraw(args[0], args[1]),
  transactions: () => cmdTransactions(),
  // Trade
  order: () => cmdOrder(args[0], args[1], args[2]),
  'order-info': () => cmdOrderInfo(args[0]),
  accept: () => cmdAccept(args[0]),
  reject: () => cmdReject(args[0]),
  escrow: () => cmdEscrow(args[0]),
  complete: () => cmdComplete(args[0], args[1]),
  confirm: () => cmdConfirm(args[0]),
  rate: () => cmdRate(args[0], args[1], args[2]),
  orders: () => cmdOrders(args[0], args[1]),
  // Dispute
  dispute: () => cmdDispute(args[0], args[1], args[2]),
  evidence: () => cmdEvidence(args[0], args[1]),
  disputes: () => cmdDisputes(),
  'dispute-info': () => cmdDisputeInfo(args[0]),
  // Cert
  'cert-apply': () => cmdCertApply(args[0]),
  'cert-status': () => cmdCertStatus(args[0]),
  'cert-renew': () => cmdCertRenew(args[0]),
  // Boost
  boost: () => cmdBoost(args[0], args[1]),
  'boost-status': () => cmdBoostStatus(args[0]),
  'boost-cancel': () => cmdBoostCancel(args[0]),
};

if (!cmd || !commands[cmd]) {
  console.log(`ATEL CLI - Agent Trust & Exchange Layer

Usage: atel <command> [args]

Protocol Commands:
  init [name]                          Create agent identity + security policy
  info                                 Show identity, capabilities, network, policy
  setup [port]                         Configure network (detect IP, UPnP, verify)
  verify                               Verify port reachability
  start [port]                         Start endpoint (auto network + auto register)
  inbox [count]                        Show received messages (default: 20)
  register [name] [caps] [endpoint]    Register on public registry
  search <capability>                  Search registry for agents
  handshake <endpoint> [did]           Handshake with remote agent
  task <target> <json>                 Delegate task (auto trust check)
  result <taskId> <json>               Submit execution result (from executor)
  check <did> [risk]                   Check agent trust (risk: low|medium|high|critical)
  verify-proof <anchor_tx> <root>      Verify on-chain proof
  audit <did_or_url> <taskId>          Deep audit: fetch trace + verify hash chain
  rotate                               Rotate identity key pair (backup + on-chain anchor)

Account Commands:
  balance                              Show platform account balance
  deposit <amount> [channel]           Deposit funds (channel: manual|crypto_sol|stripe|alipay)
  withdraw <amount> [channel]          Withdraw funds
  transactions                         List payment history

Trade Commands:
  order <executorDid> <cap> <price>    Create a trade order
  order-info <orderId>                 Get order details
  accept <orderId>                     Accept an order (executor)
  reject <orderId>                     Reject an order (executor)
  escrow <orderId>                     Freeze funds for order (requester)
  complete <orderId> [taskId]          Mark order complete + attach proof (executor)
  confirm <orderId>                    Confirm delivery + settle (requester)
  rate <orderId> <1-5> [comment]       Rate the other party
  orders [role] [status]               List orders (role: requester|executor|all)

Dispute Commands:
  dispute <orderId> <reason> [desc]    Open a dispute (reason: quality|incomplete|timeout|fraud|malicious|other)
  evidence <disputeId> <json>          Submit dispute evidence
  disputes                             List your disputes
  dispute-info <disputeId>             Get dispute details

Certification Commands:
  cert-apply [level]                   Apply for certification (level: certified|enterprise)
  cert-status [did]                    Check certification status
  cert-renew [level]                   Renew certification

Boost Commands:
  boost <tier> <weeks>                 Purchase boost (tier: basic|premium|featured)
  boost-status [did]                   Check boost status
  boost-cancel <boostId>               Cancel a boost

Environment:
  ATEL_DIR                Identity directory (default: .atel)
  ATEL_REGISTRY           Registry URL (default: http://47.251.8.19:8100)
  ATEL_PLATFORM           Platform URL (default: ATEL_REGISTRY value)
  ATEL_EXECUTOR_URL       Local executor HTTP endpoint
  ATEL_SOLANA_PRIVATE_KEY Solana key for on-chain anchoring
  ATEL_SOLANA_RPC_URL     Solana RPC (default: mainnet-beta)
  ATEL_BASE_PRIVATE_KEY   Base chain key for on-chain anchoring
  ATEL_BSC_PRIVATE_KEY    BSC chain key for on-chain anchoring

Trust Policy: Configure .atel/policy.json trustPolicy for automatic
pre-task trust evaluation. Use _risk in payload or --risk flag.`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
