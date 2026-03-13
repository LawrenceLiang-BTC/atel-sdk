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
  SolanaAnchorProvider, BaseAnchorProvider, BSCAnchorProvider,
  autoNetworkSetup, collectCandidates, connectToAgent,
  discoverPublicIP, checkReachable, ContentAuditor, TrustScoreClient,
  RollbackManager, rotateKey, verifyKeyRotation, ToolGateway, PolicyEngine, mintConsentToken, sign,
  TrustGraph, calculateTaskWeight,
} from '@lawrenceliang-btc/atel-sdk';
import { TunnelManager, HeartbeatManager } from './tunnel-manager.mjs';
import { initializeOllama, getOllamaStatus } from './ollama-manager.mjs';

const ATEL_DIR = resolve(process.env.ATEL_DIR || '.atel');
const IDENTITY_FILE = resolve(ATEL_DIR, 'identity.json');
const REGISTRY_URL = process.env.ATEL_REGISTRY || 'https://api.atelai.org';
const ATEL_PLATFORM = process.env.ATEL_PLATFORM || 'https://api.atelai.org';
const ATEL_RELAY = process.env.ATEL_RELAY || 'https://api.atelai.org';
const ATEL_NOTIFY_GATEWAY = process.env.ATEL_NOTIFY_GATEWAY || process.env.OPENCLAW_GATEWAY_URL || '';
const ATEL_NOTIFY_TARGET = process.env.ATEL_NOTIFY_TARGET || '';
let EXECUTOR_URL = process.env.ATEL_EXECUTOR_URL || '';
const INBOX_FILE = resolve(ATEL_DIR, 'inbox.jsonl');
const POLICY_FILE = resolve(ATEL_DIR, 'policy.json');
const TASKS_FILE = resolve(ATEL_DIR, 'tasks.json');
const SCORE_FILE = resolve(ATEL_DIR, 'trust-scores.json');
const GRAPH_FILE = resolve(ATEL_DIR, 'trust-graph.json');
const NETWORK_FILE = resolve(ATEL_DIR, 'network.json');
const TRACES_DIR = resolve(ATEL_DIR, 'traces');
const PENDING_FILE = resolve(ATEL_DIR, 'pending-tasks.json');
const RESULT_PUSH_QUEUE_FILE = resolve(ATEL_DIR, 'pending-result-pushes.json');
const KEYS_DIR = resolve(ATEL_DIR, 'keys');
const ANCHOR_FILE = resolve(KEYS_DIR, 'anchor.json');

const DEFAULT_POLICY = { rateLimit: 60, maxPayloadBytes: 1048576, maxConcurrent: 10, allowedDIDs: [], blockedDIDs: [], taskMode: 'auto', autoAcceptPlatform: true, autoAcceptP2P: true, trustPolicy: { minScore: 0, newAgentPolicy: 'allow_low_risk', riskThresholds: { low: 0, medium: 50, high: 75, critical: 90 } } };

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir() { if (!existsSync(ATEL_DIR)) mkdirSync(ATEL_DIR, { recursive: true }); }
function log(event) { ensureDir(); appendFileSync(INBOX_FILE, JSON.stringify(event) + '\n'); console.log(JSON.stringify(event)); }

function saveIdentity(id) { ensureDir(); writeFileSync(IDENTITY_FILE, JSON.stringify({ agent_id: id.agent_id, did: id.did, publicKey: Buffer.from(id.publicKey).toString('hex'), secretKey: Buffer.from(id.secretKey).toString('hex') }, null, 2)); }
function loadIdentity() { if (!existsSync(IDENTITY_FILE)) return null; const d = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8')); return new AgentIdentity({ agent_id: d.agent_id, publicKey: Uint8Array.from(Buffer.from(d.publicKey, 'hex')), secretKey: Uint8Array.from(Buffer.from(d.secretKey, 'hex')) }); }
function requireIdentity() { const id = loadIdentity(); if (!id) { console.error('No identity. Run: atel init'); process.exit(1); } return id; }

function loadCapabilities() { const f = resolve(ATEL_DIR, 'capabilities.json'); if (!existsSync(f)) return []; try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return []; } }
function saveCapabilities(c) { ensureDir(); writeFileSync(resolve(ATEL_DIR, 'capabilities.json'), JSON.stringify(c, null, 2)); }

// Parse capabilities string with optional pricing (e.g., "command_exec:10,web_search:5,file_read")
// Strict mode: validates price format and reports errors
function parseCapabilitiesWithPricing(capString) {
  if (!capString) return [];
  
  const caps = capString.split(',').map(s => s.trim()).filter(s => s);
  const errors = [];
  
  const result = caps.map((cap, index) => {
    const parts = cap.split(':');
    const type = parts[0].trim();
    
    if (!type) {
      errors.push(`Capability ${index + 1}: type is empty`);
      return null;
    }
    
    const capResult = {
      type: type,
      description: `${type} capability`
    };
    
    // If there's a colon, user wants to set a price
    if (parts.length > 1) {
      const priceStr = parts[1].trim();
      
      // Check for too many colons
      if (parts.length > 2) {
        errors.push(`Capability "${type}": invalid format (too many colons). Use "type:price"`);
        return null;
      }
      
      // Check if price is empty
      if (!priceStr) {
        errors.push(`Capability "${type}": price is empty. Use "type:price" or just "type" for free`);
        return null;
      }
      
      // Parse price
      const price = parseFloat(priceStr);
      
      // Check if price is valid
      if (isNaN(price)) {
        errors.push(`Capability "${type}": invalid price "${priceStr}". Must be a number`);
        return null;
      }
      
      // Check if price is negative
      if (price < 0) {
        errors.push(`Capability "${type}": price cannot be negative (${price})`);
        return null;
      }
      
      // Price = 0 means free (valid)
      if (price === 0) {
        return capResult;
      }
      
      // Price > 0, add pricing
      capResult.pricing = {
        minPrice: price,
        currency: 'USD',
        pricingModel: 'per_task'
      };
    }
    
    return capResult;
  }).filter(c => c !== null);
  
  // If there are errors, display and exit
  if (errors.length > 0) {
    console.error('\n❌ Capability format errors:\n');
    errors.forEach(err => console.error(`  - ${err}`));
    console.error('\nFormat: "type1:price1,type2:price2,type3" (omit price for free capabilities)');
    console.error('Examples:');
    console.error('  - "command_exec:10,web_search:5,file_read"');
    console.error('  - "command_exec:10.5,web_search:0" (0 = free)');
    console.error('  - "command_exec,web_search" (all free)');
    process.exit(1);
  }
  
  return result;
}

function loadPolicy() { if (!existsSync(POLICY_FILE)) return { ...DEFAULT_POLICY }; try { return { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(POLICY_FILE, 'utf-8')) }; } catch { return { ...DEFAULT_POLICY }; } }
function savePolicy(p) { ensureDir(); writeFileSync(POLICY_FILE, JSON.stringify(p, null, 2)); }
function loadTasks() { if (!existsSync(TASKS_FILE)) return {}; try { return JSON.parse(readFileSync(TASKS_FILE, 'utf-8')); } catch { return {}; } }
function saveTasks(t) { ensureDir(); writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2)); }
function loadNetwork() { if (!existsSync(NETWORK_FILE)) return null; try { return JSON.parse(readFileSync(NETWORK_FILE, 'utf-8')); } catch { return null; } }
function saveNetwork(n) { ensureDir(); writeFileSync(NETWORK_FILE, JSON.stringify(n, null, 2)); }
function saveTrace(taskId, trace) { if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true }); writeFileSync(resolve(TRACES_DIR, `${taskId}.jsonl`), trace.export()); }
function loadTrace(taskId) { const f = resolve(TRACES_DIR, `${taskId}.jsonl`); if (!existsSync(f)) return null; return readFileSync(f, 'utf-8'); }
function loadPending() { if (!existsSync(PENDING_FILE)) return {}; try { return JSON.parse(readFileSync(PENDING_FILE, 'utf-8')); } catch { return {}; } }
function savePending(p) { ensureDir(); writeFileSync(PENDING_FILE, JSON.stringify(p, null, 2)); }
function loadResultPushQueue() { if (!existsSync(RESULT_PUSH_QUEUE_FILE)) return []; try { const q = JSON.parse(readFileSync(RESULT_PUSH_QUEUE_FILE, 'utf-8')); return Array.isArray(q) ? q : []; } catch { return []; } }
function saveResultPushQueue(items) { ensureDir(); writeFileSync(RESULT_PUSH_QUEUE_FILE, JSON.stringify(items, null, 2)); }

// Anchor configuration (on-chain anchoring for paid orders)
function loadAnchorConfig() { 
  if (!existsSync(ANCHOR_FILE)) return null; 
  try { return JSON.parse(readFileSync(ANCHOR_FILE, 'utf-8')); } catch { return null; } 
}
function saveAnchorConfig(config) { 
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 }); 
  writeFileSync(ANCHOR_FILE, JSON.stringify(config, null, 2), { mode: 0o600 }); 
  // Verify permissions
  try {
    const stats = statSync(ANCHOR_FILE);
    if ((stats.mode & 0o777) !== 0o600) {
      console.warn('⚠️  Warning: Failed to set secure permissions on anchor.json');
      console.warn('   Run: chmod 600 .atel/keys/anchor.json');
    }
  } catch (e) {
    // Ignore permission check errors on Windows
  }
}
function getChainPrivateKey(chain) {
  // 1. Try config file first
  const config = loadAnchorConfig();
  if (config?.chains?.[chain]?.privateKey) {
    return config.chains[chain].privateKey;
  }
  // 2. Fall back to environment variables (backward compatibility)
  if (chain === 'solana') return process.env.ATEL_SOLANA_PRIVATE_KEY;
  if (chain === 'base') return process.env.ATEL_BASE_PRIVATE_KEY;
  if (chain === 'bsc') return process.env.ATEL_BSC_PRIVATE_KEY;
  return null;
}

// Derive wallet addresses from private keys (config file or env)
async function getWalletAddresses() {
  const wallets = {};
  const config = loadAnchorConfig();
  
  // Solana: base58 private key → public key
  const solKey = getChainPrivateKey('solana');
  if (solKey) {
    try {
      const { Keypair } = await import('@solana/web3.js');
      const bs58 = (await import('bs58')).default;
      const kp = Keypair.fromSecretKey(bs58.decode(solKey));
      wallets.solana = kp.publicKey.toBase58();
    } catch {}
  } else if (config?.chains?.solana?.address) {
    wallets.solana = config.chains.solana.address;
  }
  
  // Base: hex private key → address
  const baseKey = getChainPrivateKey('base');
  if (baseKey) {
    try {
      const { ethers } = await import('ethers');
      wallets.base = new ethers.Wallet(baseKey).address;
    } catch {}
  } else if (config?.chains?.base?.address) {
    wallets.base = config.chains.base.address;
  }
  
  // BSC: hex private key → address
  const bscKey = getChainPrivateKey('bsc');
  if (bscKey) {
    try {
      const { ethers } = await import('ethers');
      wallets.bsc = new ethers.Wallet(bscKey).address;
    } catch {}
  } else if (config?.chains?.bsc?.address) {
    wallets.bsc = config.chains.bsc.address;
  }
  
  return Object.keys(wallets).length > 0 ? wallets : undefined;
}

// Detect preferred chain based on configured private keys (config file or env)
function detectPreferredChain() {
  const config = loadAnchorConfig();
  if (config?.preferredChain) return config.preferredChain;
  if (getChainPrivateKey('solana')) return 'solana';
  if (getChainPrivateKey('base')) return 'base';
  if (getChainPrivateKey('bsc')) return 'bsc';
  return null;
}

// ─── Task Request Signing (for security) ─────────────────────────

// Generate unique task ID
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Sign task request (Requester signs to prove task origin)
async function signTaskRequest(taskRequest, secretKey) {
  const { default: nacl } = await import('tweetnacl');
  
  // Canonical JSON for signing (exclude orderId as it's not available yet)
  // IMPORTANT: Keys must be in alphabetical order to match Go's json.Marshal behavior
  const signable = JSON.stringify({
    capability: taskRequest.capability,
    description: taskRequest.description,
    executorDid: taskRequest.executorDid,
    payload: taskRequest.payload,
    requesterDid: taskRequest.requesterDid,
    taskId: taskRequest.taskId,
    timestamp: taskRequest.timestamp,
    version: taskRequest.version
  });
  
  console.error('[DEBUG] SDK signable JSON:', signable);
  
  const signature = nacl.sign.detached(Buffer.from(signable), secretKey);
  return Buffer.from(signature).toString('base64');
}

// Verify task request signature
async function verifyTaskSignature(taskRequest, signature, publicKeyHex) {
  const { default: nacl } = await import('tweetnacl');
  
  // Canonical JSON for verification
  const signable = JSON.stringify({
    version: taskRequest.version,
    taskId: taskRequest.taskId,
    requesterDid: taskRequest.requesterDid,
    executorDid: taskRequest.executorDid,
    capability: taskRequest.capability,
    description: taskRequest.description,
    payload: taskRequest.payload,
    timestamp: taskRequest.timestamp
  });
  
  try {
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    const sig = Buffer.from(signature, 'base64');
    return nacl.sign.detached.verify(Buffer.from(signable), sig, publicKey);
  } catch (e) {
    return false;
  }
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

async function anchorOnChain(traceRoot, metadata, preferredChain) {
  const chain = preferredChain || detectPreferredChain();
  if (!chain) return null;

  try {
    const key = getChainPrivateKey(chain);
    if (!key) return null;
    
    let provider;
    if (chain === 'solana') {
      provider = new SolanaAnchorProvider({ 
        rpcUrl: process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 
        privateKey: key 
      });
    } else if (chain === 'base') {
      provider = new BaseAnchorProvider({ 
        rpcUrl: process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org', 
        privateKey: key 
      });
    } else if (chain === 'bsc') {
      provider = new BSCAnchorProvider({ 
        rpcUrl: process.env.ATEL_BSC_RPC_URL || 'https://bsc-dataseed.binance.org', 
        privateKey: key 
      });
    } else {
      return null;
    }

    const r = await provider.anchor(traceRoot, {
      executorDid: metadata?.executorDid,
      requesterDid: metadata?.requesterDid || metadata?.task_from,
      taskId: metadata?.taskId,
      ...metadata,
    });
    log({ event: 'proof_anchored', chain, txHash: r.txHash, block: r.blockNumber, trace_root: traceRoot });
    return { ...r, chain };
  } catch (e) { 
    log({ event: 'anchor_failed', chain, error: e.message }); 
    return null; 
  }
}

// ─── Interactive Input Helpers ───────────────────────────────────

async function promptYesNo(question) {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function promptChoice(question, choices) {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log(question);
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  
  return new Promise((resolve) => {
    rl.question('Select (1-3): ', (answer) => {
      rl.close();
      const idx = parseInt(answer) - 1;
      resolve(choices[idx] || choices[0]);
    });
  });
}

async function promptInput(question) {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Anchor Configuration ────────────────────────────────────────

async function configureAnchor() {
  console.log('\n🔗 Configure On-Chain Anchoring\n');
  
  // 1. Select chain
  const chain = await promptChoice(
    'Select blockchain for anchoring:',
    ['solana', 'bsc', 'base']
  );
  
  // 2. Input private key
  const privateKey = await promptInput(
    `Enter ${chain.toUpperCase()} private key:`
  );
  
  if (!privateKey) {
    console.error('❌ Private key is required');
    process.exit(1);
  }
  
  // 3. Validate private key and derive address
  let address;
  try {
    if (chain === 'solana') {
      const { Keypair } = await import('@solana/web3.js');
      const bs58 = (await import('bs58')).default;
      const kp = Keypair.fromSecretKey(bs58.decode(privateKey));
      address = kp.publicKey.toBase58();
    } else {
      const { ethers } = await import('ethers');
      const wallet = new ethers.Wallet(privateKey);
      address = wallet.address;
    }
  } catch (e) {
    console.error(`❌ Invalid ${chain.toUpperCase()} private key: ${e.message}`);
    process.exit(1);
  }
  
  // 4. Save configuration
  const anchorConfig = {
    enabled: true,
    preferredChain: chain,
    chains: {
      [chain]: {
        privateKey: privateKey,
        address: address,
        configuredAt: new Date().toISOString()
      }
    }
  };
  
  saveAnchorConfig(anchorConfig);
  
  console.log(`✅ ${chain.toUpperCase()} anchor configured`);
  console.log(`   Address: ${address}`);
}

// ─── Commands ────────────────────────────────────────────────────

async function cmdInit(agentId) {
  const name = agentId || `agent-${Date.now()}`;
  const identity = new AgentIdentity({ agent_id: name });
  saveIdentity(identity);
  savePolicy(DEFAULT_POLICY);
  
  // Create default agent-context.md for built-in executor
  const ctxFile = resolve(ATEL_DIR, 'agent-context.md');
  if (!existsSync(ctxFile)) {
    writeFileSync(ctxFile, `# Agent Context\n\nYou are an ATEL agent (${name}) processing tasks from other agents via the ATEL protocol.\n\n## Guidelines\n- Complete the task accurately and concisely\n- Return only the requested result, no extra commentary\n- If the task is unclear, do your best interpretation\n- Do not access private files or sensitive data\n- Do not make external network requests unless the task requires it\n`);
  }
  
  // Ask about paid order services
  console.log('');
  const providePaidOrders = await promptYesNo(
    'Do you want to provide paid order services? (requires on-chain anchoring)'
  );
  
  let anchorConfigured = false;
  if (providePaidOrders) {
    try {
      await configureAnchor();
      anchorConfigured = true;
    } catch (e) {
      console.error(`❌ Failed to configure anchor: ${e.message}`);
    }
  }
  
  console.log(JSON.stringify({ 
    status: 'created', 
    agent_id: identity.agent_id, 
    did: identity.did, 
    policy: POLICY_FILE,
    anchor: anchorConfigured ? 'configured' : 'disabled',
    next: 'Run: atel start [port] — auto-configures network and registers' 
  }, null, 2));
}

async function cmdAnchor(subcommand) {
  if (subcommand === 'config') {
    await configureAnchor();
  } else if (subcommand === 'info') {
    const config = loadAnchorConfig();
    if (!config) {
      console.log(JSON.stringify({ status: 'not_configured', message: 'No anchor configuration found' }, null, 2));
      return;
    }
    const chains = Object.keys(config.chains || {});
    const addresses = {};
    for (const chain of chains) {
      addresses[chain] = config.chains[chain].address;
    }
    console.log(JSON.stringify({
      enabled: config.enabled,
      preferredChain: config.preferredChain,
      chains: chains,
      addresses: addresses
    }, null, 2));
  } else if (subcommand === 'enable') {
    const config = loadAnchorConfig();
    if (!config) {
      console.error('❌ No anchor configuration found. Run: atel anchor config');
      process.exit(1);
    }
    config.enabled = true;
    saveAnchorConfig(config);
    console.log('✅ Anchor enabled');
  } else if (subcommand === 'disable') {
    const config = loadAnchorConfig();
    if (!config) {
      console.error('❌ No anchor configuration found');
      process.exit(1);
    }
    config.enabled = false;
    saveAnchorConfig(config);
    console.log('✅ Anchor disabled');
  } else {
    console.log('Usage: atel anchor <config|info|enable|disable>');
    console.log('');
    console.log('Commands:');
    console.log('  config   Configure on-chain anchoring');
    console.log('  info     Show anchor configuration');
    console.log('  enable   Enable on-chain anchoring');
    console.log('  disable  Disable on-chain anchoring');
  }
}

async function cmdInfo() {
  const id = requireIdentity();
  console.log(JSON.stringify({ agent_id: id.agent_id, did: id.did, capabilities: loadCapabilities(), policy: loadPolicy(), network: loadNetwork(), executor: EXECUTOR_URL || 'not configured' }, null, 2));
}

async function cmdStatus() {
  const id = loadIdentity();
  const network = loadNetwork();
  const policy = loadPolicy();
  
  // Check Ollama status
  const ollamaStatus = await getOllamaStatus();
  
  // Check Gateway status
  let gatewayStatus = { available: false };
  if (ATEL_NOTIFY_GATEWAY) {
    try {
      const response = await fetch(`${ATEL_NOTIFY_GATEWAY}/status`, { signal: AbortSignal.timeout(2000) });
      gatewayStatus = { available: response.ok, url: ATEL_NOTIFY_GATEWAY };
    } catch {
      gatewayStatus = { available: false, url: ATEL_NOTIFY_GATEWAY };
    }
  }
  
  // Check Executor status
  let executorStatus = { available: false };
  const executorUrl = EXECUTOR_URL || 'http://127.0.0.1:14003';
  try {
    const response = await fetch(`${executorUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const data = await response.json();
      executorStatus = { available: true, url: executorUrl, ...data };
    }
  } catch {
    executorStatus = { available: false, url: executorUrl };
  }
  
  // Check if agent is running
  let agentStatus = { running: false };
  if (network?.port) {
    try {
      const response = await fetch(`http://localhost:${network.port}/health`, { signal: AbortSignal.timeout(2000) });
      agentStatus = { running: response.ok, port: network.port };
    } catch {
      agentStatus = { running: false, port: network.port };
    }
  }
  
  // Build status report
  const status = {
    identity: id ? { did: id.did, agent_id: id.agent_id } : null,
    agent: agentStatus,
    executor: executorStatus,
    gateway: gatewayStatus,
    ollama: ollamaStatus,
    audit: {
      enabled: true,
      strategy: gatewayStatus.available ? 'Gateway → Ollama → Rule' : (ollamaStatus.running ? 'Ollama → Rule' : 'Rule only')
    },
    registry: REGISTRY_URL,
    network: network ? {
      endpoint: network.endpoint,
      reachable: network.reachable,
      upnp: network.upnp
    } : null
  };
  
  // Pretty print with status indicators
  console.log('\n=== ATEL Agent Status ===\n');
  console.log(`Identity: ${status.identity ? '✅' : '❌'} ${status.identity?.did || 'Not initialized'}`);
  console.log(`Agent:    ${status.agent.running ? '✅' : '❌'} ${status.agent.running ? `Running (port ${status.agent.port})` : 'Not running'}`);
  console.log(`Executor: ${status.executor.available ? '✅' : '❌'} ${status.executor.available ? `Available (${status.executor.url})` : 'Not available'}`);
  console.log(`Gateway:  ${status.gateway.available ? '✅' : '❌'} ${status.gateway.available ? `Connected (${status.gateway.url})` : 'Not configured'}`);
  console.log(`Ollama:   ${status.ollama.running ? '✅' : '❌'} ${status.ollama.running ? `Running (${status.ollama.models.length} models)` : 'Not running'}`);
  
  if (status.ollama.running && status.ollama.models.length > 0) {
    console.log(`  Models: ${status.ollama.models.map(m => m.name).join(', ')}`);
  }
  
  console.log(`Audit:    ✅ Enabled (${status.audit.strategy})`);
  console.log(`Registry: ${status.registry}`);
  
  if (status.network) {
    console.log(`Network:  ${status.network.reachable ? '✅' : '⚠️'} ${status.network.endpoint}`);
  }
  
  console.log('\n');
  
  // Also output JSON for programmatic use
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
  }
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

/**
 * Start ToolGateway proxy server for verifiable execution.
 * All executor tool calls must go through this proxy to be recorded in trace.
 */
async function startToolGatewayProxy(port, identity, policy) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Each task has its own gateway + trace
  const taskGateways = new Map();

  // POST /init - Initialize task gateway
  app.post('/init', async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return; }

    const trace = new ExecutionTrace(taskId, identity);
    
    // Create a permissive policy adapter (allow all tools)
    const permissivePolicy = {
      evaluate: (action, context) => ({ decision: 'allow' }),
    };
    
    const gateway = new ToolGateway(permissivePolicy, { trace });

    taskGateways.set(taskId, { gateway, trace, tools: new Map() });
    res.json({ status: 'initialized', taskId, proxyUrl: `http://127.0.0.1:${port}` });
  });

  // POST /register - Register tool endpoint
  app.post('/register', async (req, res) => {
    const { taskId, tool, endpoint } = req.body;
    if (!taskId || !tool || !endpoint) {
      res.status(400).json({ error: 'taskId, tool, endpoint required' });
      return;
    }

    const ctx = taskGateways.get(taskId);
    if (!ctx) { res.status(404).json({ error: 'Task not initialized' }); return; }

    // Register tool: calls executor-provided endpoint
    ctx.gateway.registerTool(tool, async (input) => {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, input }),
        signal: AbortSignal.timeout(180000),
      });
      if (!resp.ok) throw new Error(`Tool ${tool} failed: ${resp.status}`);
      return await resp.json();
    });

    ctx.tools.set(tool, endpoint);
    res.json({ status: 'registered', tool });
  });

  // POST /call - Call tool through gateway
  app.post('/call', async (req, res) => {
    const { taskId, tool, input, risk_level, data_scope } = req.body;
    if (!taskId || !tool) {
      res.status(400).json({ error: 'taskId and tool required' });
      return;
    }

    const ctx = taskGateways.get(taskId);
    if (!ctx) { res.status(404).json({ error: 'Task not initialized' }); return; }

    try {
      const result = await ctx.gateway.callTool({ tool, input, risk_level, data_scope });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message, type: e.name });
    }
  });

  // POST /finalize - Finalize task, return trace
  app.post('/finalize', (req, res) => {
    const { taskId, success, result } = req.body;
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return; }

    const ctx = taskGateways.get(taskId);
    if (!ctx) { res.status(404).json({ error: 'Task not initialized' }); return; }

    if (success) {
      ctx.trace.finalize(result || {});
    } else {
      ctx.trace.fail(new Error(result?.error || 'Task failed'));
    }

    // Return trace as object with events array
    const traceObj = {
      events: ctx.trace.events,
      taskId: ctx.trace.taskId,
      executor: ctx.trace.identity.did,
    };
    taskGateways.delete(taskId);

    res.json({ status: 'finalized', trace: traceObj });
  });

  // GET /trace/:taskId - Get current trace
  app.get('/trace/:taskId', (req, res) => {
    const ctx = taskGateways.get(req.params.taskId);
    if (!ctx) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json({ trace: ctx.trace.export() });
  });

  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({ server, port, taskGateways });
    });
  });
}

async function cmdStart(port) {
  const id = requireIdentity();
  // Initialize Ollama (auto-start and download model)
  await initializeOllama().catch(err => {
    console.error(`[Ollama] Initialization failed: ${err.message}`);
    console.error(`[Ollama] Audit will use rule-based verification only`);
  });

  const p = parseInt(port || '3100');
  const caps = loadCapabilities();
  const capTypes = caps.map(c => c.type || c);
  const policy = loadPolicy();
  const enforcer = new PolicyEnforcer(policy);
  const pendingTasks = loadTasks();
  let resultPushQueue = loadResultPushQueue();

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function verifyAnchorFromChain(chain, txHash, traceRoot) {
    try {
      console.error('[DEBUG] verifyAnchorFromChain input:', { chain, txHash, traceRoot });
      
      if (!txHash || !traceRoot) return { checked: false, verified: false, reason: 'missing_anchor_or_root' };
      const c = (chain || 'solana').toLowerCase();
      
      if (c === 'solana') {
        const rpcUrl = process.env.ATEL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
        console.error('[DEBUG] Solana RPC URL:', rpcUrl);
        const provider = new SolanaAnchorProvider({ rpcUrl });
        const r = await provider.verify(traceRoot, txHash);
        console.error('[DEBUG] Solana verify result:', r);
        return { checked: true, verified: !!r?.valid, chain: 'solana', detail: r?.detail };
      }
      if (c === 'base') {
        const rpcUrl = process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org';
        console.error('[DEBUG] Base RPC URL:', rpcUrl);
        const provider = new BaseAnchorProvider({ rpcUrl });
        const r = await provider.verify(traceRoot, txHash);
        console.error('[DEBUG] Base verify result:', r);
        return { checked: true, verified: !!r?.valid, chain: 'base', detail: r?.detail };
      }
      if (c === 'bsc') {
        const rpcUrl = process.env.ATEL_BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
        console.error('[DEBUG] BSC RPC URL:', rpcUrl);
        const provider = new BSCAnchorProvider({ rpcUrl });
        const r = await provider.verify(traceRoot, txHash);
        console.error('[DEBUG] BSC verify result:', r);
        return { checked: true, verified: !!r?.valid, chain: 'bsc', detail: r?.detail };
      }
      return { checked: false, verified: false, reason: `unsupported_chain:${c}` };
    } catch (e) {
      console.error('[DEBUG] verifyAnchorFromChain error:', e);
      return { checked: true, verified: false, reason: e.message };
    }
  }

  async function pushResultOnce(task, taskId, resultPayload) {
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

    if (isRelay) {
      const relaySend = async (path, body) => {
        const resp = await fetch(targetUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'POST', path, body, from: id.did }),
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) throw new Error(`Relay ${path} failed: ${resp.status}`);
        return resp.json();
      };

      const hsManager = new HandshakeManager(id);
      const initMsg = hsManager.createInit(task.from);
      const ackMsg = await relaySend('/atel/v1/handshake', initMsg);
      const { confirm } = hsManager.processAck(ackMsg);
      await relaySend('/atel/v1/handshake', confirm);

      const msg = createMessage({ type: 'task-result', from: id.did, to: task.from, payload: resultPayload, secretKey: id.secretKey });
      await relaySend('/atel/v1/task', msg);
    } else {
      const client = new AgentClient(id);
      const hsManager = new HandshakeManager(id);
      await client.handshake(targetUrl, hsManager, task.from);
      const msg = createMessage({ type: 'task-result', from: id.did, to: task.from, payload: resultPayload, secretKey: id.secretKey });
      await client.sendTask(targetUrl, msg, hsManager);
    }

    return { targetUrl, isRelay };
  }

  async function pushResultWithRetry(task, taskId, resultPayload, opts = {}) {
    const maxAttempts = opts.maxAttempts || 3; // Reduced from 4 to 3
    const retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await pushResultOnce(task, taskId, resultPayload);
        return { ok: true, ...r, attempts: attempt };
      } catch (e) {
        lastErr = e;
        log({ event: 'result_push_retry', taskId, attempt, maxAttempts, error: e.message });
        if (attempt < maxAttempts) {
          const delay = retryDelays[attempt - 1] || 4000;
          await sleep(delay);
        }
      }
    }
    // After max retries, give up and log
    log({ event: 'result_push_failed', taskId, to: task.from, error: lastErr?.message || 'unknown_error', attempts: maxAttempts });
    return { ok: false, error: lastErr?.message || 'unknown_error', attempts: maxAttempts };
  }

  function enqueueResultPush(item) {
    const idx = resultPushQueue.findIndex(x => x.taskId === item.taskId);
    if (idx >= 0) {
      resultPushQueue[idx] = { ...resultPushQueue[idx], ...item };
    } else {
      resultPushQueue.push(item);
    }
    saveResultPushQueue(resultPushQueue);
  }

  // ── Network: collect candidates ──
  let networkConfig = loadNetwork();
  if (!networkConfig) {
    log({ event: 'network_setup', status: 'auto-detecting' });
    networkConfig = await autoNetworkSetup(p);
    for (const step of networkConfig.steps) log({ event: 'network_step', message: step });
    delete networkConfig.steps;
    saveNetwork(networkConfig);
  } else {
    log({ event: 'network_loaded', candidates: networkConfig.candidates?.length || 0 });
  }

  // ── Start endpoint ──
  const endpoint = new AgentEndpoint(id, { port: p, host: '0.0.0.0' });

  // ── Start ToolGateway Proxy Server ──
  const toolProxyPort = p + 1;
  const toolGatewayServer = await startToolGatewayProxy(toolProxyPort, id, policy);
  log({ event: 'tool_gateway_started', port: toolProxyPort });

  // ── Built-in Executor (auto-start if no external ATEL_EXECUTOR_URL) ──
  let builtinExecutor = null;
  if (!EXECUTOR_URL) {
    const executorPort = p + 2;
    try {
      const { BuiltinExecutor } = await import('../dist/executor/index.js');
      builtinExecutor = new BuiltinExecutor({
        port: executorPort,
        callbackUrl: `http://127.0.0.1:${p}/atel/v1/result`,
        gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
        contextPath: join(ATEL_DIR, 'agent-context.md'),
        log,
      });
      await builtinExecutor.start();
      EXECUTOR_URL = `http://127.0.0.1:${executorPort}`;
      log({ event: 'builtin_executor_started', port: executorPort, url: EXECUTOR_URL });
    } catch (e) {
      log({ event: 'builtin_executor_failed', error: e.message, note: 'Falling back to echo mode. Set ATEL_EXECUTOR_URL for external executor.' });
    }
  }

  // ── Trust Score Client (persistent) ──
  const trustScoreClient = new TrustScoreClient();
  // Load saved proof records
  try {
    const saved = JSON.parse(readFileSync(SCORE_FILE, 'utf-8'));
    if (saved.proofRecords) {
      for (const r of saved.proofRecords) trustScoreClient.addProofRecord(r);
    }
    if (saved.summaries) {
      for (const s of saved.summaries) trustScoreClient.submitExecutionSummary(s);
    }
    log({ event: 'trust_scores_loaded', records: (saved.proofRecords || []).length, summaries: (saved.summaries || []).length });
  } catch {}
  // Accumulated records for persistence
  const _proofRecords = [];
  const _summaries = [];
  try {
    const saved = JSON.parse(readFileSync(SCORE_FILE, 'utf-8'));
    if (saved.proofRecords) _proofRecords.push(...saved.proofRecords);
    if (saved.summaries) _summaries.push(...saved.summaries);
  } catch {}
  function saveTrustScores() {
    try { writeFileSync(SCORE_FILE, JSON.stringify({ proofRecords: _proofRecords, summaries: _summaries }, null, 2)); } catch {}
  }

  // ── Trust Graph (persistent) ──
  const trustGraph = new TrustGraph();
  const _interactions = [];
  try {
    const saved = JSON.parse(readFileSync(GRAPH_FILE, 'utf-8'));
    if (saved.interactions) {
      for (const i of saved.interactions) {
        trustGraph.recordInteraction(i);
      }
      _interactions.push(...saved.interactions);
    }
    log({ event: 'trust_graph_loaded', interactions: _interactions.length, stats: trustGraph.getStats() });
  } catch {}
  function saveTrustGraph() {
    try { writeFileSync(GRAPH_FILE, JSON.stringify({ interactions: _interactions, exported: trustGraph.exportGraph() }, null, 2)); } catch {}
  }

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

  // Approve pending task: POST /atel/v1/approve (CLI calls this)
  endpoint.app?.post?.('/atel/v1/approve', async (req, res) => {
    const { taskId } = req.body || {};
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return; }
    const pending = loadPending();
    const task = pending[taskId];
    if (!task) { res.status(404).json({ error: 'Task not found in pending queue' }); return; }
    if (task.status !== 'pending_confirm') { res.status(400).json({ error: `Task not pending (status: ${task.status})` }); return; }

    if (!EXECUTOR_URL) {
      res.status(500).json({ error: 'No executor configured' });
      return;
    }

    // Forward to executor
    try {
      log({ event: 'task_approved', taskId, from: task.from, action: task.action, timestamp: new Date().toISOString() });
      
      // Register in active tasks
      pendingTasks[taskId] = { from: task.from, action: task.action, payload: task.payload, encrypted: task.encrypted || false, acceptedAt: new Date().toISOString() };
      saveTasks(pendingTasks);
      enforcer.taskStarted();

      const execResp = await fetch(EXECUTOR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          from: task.from,
          action: task.action,
          payload: task.payload,
          encrypted: task.encrypted || false,
          toolProxy: `http://127.0.0.1:${toolProxyPort}`,
        }),
        signal: AbortSignal.timeout(600000),
      });

      if (execResp.ok) {
        task.status = 'approved';
        savePending(pending);
        res.json({ status: 'approved', taskId, forwarded: true });
      } else {
        const err = await execResp.text();
        res.status(500).json({ error: 'Executor error: ' + err });
      }
    } catch (e) {
      res.status(500).json({ error: 'Forward failed: ' + e.message });
    }
  });

  // Webhook notification: POST /atel/v1/notify (platform calls this for order events)
  endpoint.app?.post?.('/atel/v1/notify', async (req, res) => {
    const { event, payload } = req.body || {};
    if (!event || !payload) {
      res.status(400).json({ error: 'event and payload required' });
      return;
    }

    log({ event: 'webhook_received', type: event, payload });

    if (event === 'order_created') {
      // New order notification - decide whether to accept
      const { orderId, requesterDid, capabilityType, priceAmount, description } = payload;
      
      // Check capability match
      if (!capTypes.includes(capabilityType)) {
        log({ event: 'order_rejected', orderId, reason: 'capability_mismatch', required: capabilityType, available: capTypes });
        res.json({ status: 'rejected', reason: 'capability not supported' });
        return;
      }

      // ── Task Mode Check ──
      const currentPolicy = loadPolicy();
      const taskMode = currentPolicy.taskMode || 'auto';
      
      if (taskMode === 'off') {
        log({ event: 'order_rejected_mode_off', orderId, requesterDid, capabilityType });
        // Reject via Platform API
        try {
          const timestamp = new Date().toISOString();
          const rejectPayload = { reason: 'Agent task mode is off' };
          const signPayload = { did: id.did, timestamp, payload: rejectPayload };
          const signature = sign(signPayload, id.secretKey);
          await fetch(`${ATEL_PLATFORM}/trade/v1/order/${orderId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ did: id.did, timestamp, signature, payload: rejectPayload }),
            signal: AbortSignal.timeout(10000),
          });
        } catch (e) { log({ event: 'order_reject_api_error', orderId, error: e.message }); }
        res.json({ status: 'rejected', reason: 'task_mode_off' });
        return;
      }
      
      if (taskMode === 'confirm' || currentPolicy.autoAcceptPlatform === false) {
        // Queue for manual approval
        const pending = loadPending();
        pending[orderId] = {
          source: 'platform',
          from: requesterDid,
          action: capabilityType,
          payload: { orderId, priceAmount, description },
          price: priceAmount || 0,
          status: 'pending_confirm',
          receivedAt: new Date().toISOString(),
          orderId,
        };
        savePending(pending);
        log({ event: 'order_queued', orderId, requesterDid, capabilityType, reason: taskMode === 'confirm' ? 'task_mode_confirm' : 'autoAcceptPlatform_off' });
        res.json({ status: 'queued', orderId, message: 'Awaiting manual confirmation. Use: atel approve ' + orderId });
        return;
      }

      // Auto-accept (default)
      log({ event: 'order_auto_accept', orderId, requesterDid, capabilityType });
      
      // Call platform API to accept
      try {
        const timestamp = new Date().toISOString(); // RFC3339 format
        const payload = {}; // Empty payload for accept
        const signPayload = { did: id.did, timestamp, payload };
        const signature = sign(signPayload, id.secretKey);
        
        const signedRequest = {
          did: id.did,
          timestamp,
          signature,
          payload
        };
        
        log({ event: 'order_accept_calling_api', orderId, platform: ATEL_PLATFORM });
        
        const acceptResp = await fetch(`${ATEL_PLATFORM}/trade/v1/order/${orderId}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signedRequest),
          signal: AbortSignal.timeout(10000), // 10秒超时
        });
        
        log({ event: 'order_accept_response', orderId, status: acceptResp.status, ok: acceptResp.ok });
        
        if (acceptResp.ok) {
          log({ event: 'order_accepted', orderId });
          res.json({ status: 'accepted', orderId });
        } else {
          const error = await acceptResp.text();
          log({ event: 'order_accept_failed', orderId, error, status: acceptResp.status });
          res.status(500).json({ error: 'accept failed: ' + error });
        }
      } catch (err) {
        log({ event: 'order_accept_error', orderId, error: err.message, stack: err.stack });
        console.error('[ERROR] Order accept failed:', err);
        res.status(500).json({ error: err.message });
      }
      return;
    }

    if (event === 'task_start') {
      // Task execution notification - forward to executor
      const { orderId, requesterDid, capabilityType, priceAmount, chain, description } = payload;
      
      log({ event: 'task_start_received', orderId, requesterDid, chain });
      
      // Forward to executor
      if (!EXECUTOR_URL) {
        log({ event: 'task_start_no_executor', orderId });
        res.status(500).json({ error: 'no executor configured' });
        return;
      }

      // Register task in pendingTasks
      pendingTasks[orderId] = {
        from: requesterDid,
        action: capabilityType,
        chain: chain,
        priceAmount: Number(priceAmount || 0),
        payload: { orderId, priceAmount: Number(priceAmount || 0), text: description || '' },
        acceptedAt: new Date().toISOString(),
        encrypted: false
      };
      saveTasks(pendingTasks);

      // Respond immediately to relay, then forward to executor async
      res.json({ status: 'accepted', orderId });

      // Async: forward to executor (no timeout pressure from relay)
      (async () => {
        try {
          log({ event: 'task_forward_calling_executor', orderId, executor: EXECUTOR_URL });
          
          const execResp = await fetch(EXECUTOR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              taskId: orderId,
              from: requesterDid,
              action: capabilityType,
              payload: { orderId, priceAmount, text: description || '' },
              toolProxy: `http://127.0.0.1:${toolProxyPort}`,
              callbackUrl: `http://127.0.0.1:${p}/atel/v1/result`
            }),
            signal: AbortSignal.timeout(600000), // 10 min timeout
          });

          log({ event: 'task_forward_response', orderId, status: execResp.status, ok: execResp.ok });

          if (!execResp.ok) {
            const error = await execResp.text();
            log({ event: 'task_forward_failed', orderId, error, status: execResp.status });
          } else {
            log({ event: 'task_forwarded_to_executor', orderId });
          }
        } catch (err) {
          log({ event: 'task_forward_error', orderId, error: err.message, stack: err.stack });
          console.error('[ERROR] Task forward failed:', err);
        }
      })();
      return;
    }

    // Order completed notification (requester side)
    if (event === 'order_completed') {
      const { orderId, executorDid, capabilityType, priceAmount, description, traceRoot, anchorTx } = payload;
      log({ event: 'order_completed_notification', orderId, executorDid, capabilityType, priceAmount });

      // Notify owner
      if (ATEL_NOTIFY_GATEWAY && ATEL_NOTIFY_TARGET) {
        try {
          const desc = description ? description.slice(0, 150) : 'N/A';
          const msg = `📦 Order ${orderId} completed!\nExecutor: ${(executorDid || '').slice(-12)}\nType: ${capabilityType}\nPrice: $${priceAmount || 0}\nTask: ${desc}\nTrace: ${(traceRoot || '').slice(0, 16)}...${anchorTx ? '\n⛓️ On-chain: ' + anchorTx : ''}`;
          const token = (() => { try { return JSON.parse(readFileSync(join(process.env.HOME || '', '.openclaw/openclaw.json'), 'utf-8')).gateway?.auth?.token || ''; } catch { return ''; } })();
          if (token) {
            fetch(`${ATEL_NOTIFY_GATEWAY}/tools/invoke`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ tool: 'message', args: { action: 'send', message: msg, target: ATEL_NOTIFY_TARGET } }),
              signal: AbortSignal.timeout(5000),
            }).then(() => log({ event: 'order_notify_sent', orderId })).catch(e => log({ event: 'order_notify_failed', orderId, error: e.message }));
          }
        } catch (e) { log({ event: 'order_notify_error', orderId, error: e.message }); }
      }

      res.json({ status: 'received', orderId });
      return;
    }

    // Unknown event type
    res.json({ status: 'ignored', event });
  });

  // Result callback: POST /atel/v1/result (executor calls this when done)
  endpoint.app?.post?.('/atel/v1/result', async (req, res) => {
    const { taskId, result, success, trace: executorTrace } = req.body || {};
    if (!taskId || !pendingTasks[taskId]) { res.status(404).json({ error: 'Unknown taskId' }); return; }
    const task = pendingTasks[taskId];
    const startTime = new Date(task.acceptedAt).getTime();
    const durationMs = Date.now() - startTime;
    enforcer.taskFinished();

    // ── Execution Trace ──
    let trace;
    if (executorTrace && executorTrace.events && Array.isArray(executorTrace.events)) {
      // Use executor-provided trace (from ToolGateway)
      trace = new ExecutionTrace(taskId, id);
      // Import events from executor trace
      for (const event of executorTrace.events) {
        trace.events.push(event);
      }
      log({ event: 'trace_imported', taskId, event_count: executorTrace.events.length, has_tool_calls: executorTrace.events.some(e => e.type === 'TOOL_CALL') });
    } else {
      // Fallback: simple trace (for executors without ToolGateway integration)
      trace = new ExecutionTrace(taskId, id);
      trace.append('TASK_RECEIVED', { from: task.from, action: task.action, encrypted: task.encrypted });
      trace.append('POLICY_CHECK', { rateLimit: policy.rateLimit, maxConcurrent: policy.maxConcurrent, result: 'allowed' });
      trace.append('CAPABILITY_CHECK', { action: task.action, capabilities: capTypes, result: 'allowed' });
      trace.append('CONTENT_AUDIT', { result: 'passed' });
      trace.append('TASK_FORWARDED', { executor_url: EXECUTOR_URL, timestamp: task.acceptedAt });
      trace.append('EXECUTOR_RESULT', { success: success !== false, duration_ms: durationMs, result_size: JSON.stringify(result).length });
      log({ event: 'trace_fallback', taskId, warning: 'Executor did not provide trace, using simple trace' });
    }

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
      rollbackReport = await rollback.rollback();
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
    const anchor = await anchorOnChain(proof.trace_root, { proof_id: proof.proof_id, executorDid: id.did, requesterDid: task.from, taskId, action: task.action }, task.chain);

    // ── Trust Score Update (always, with or without anchor) ──
    try {
      if (anchor?.txHash) {
        const proofRecord = {
          traceRoot: proof.trace_root,
          txHash: anchor.txHash,
          chain: anchor.chain || 'solana',
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
        };
        trustScoreClient.addProofRecord(proofRecord);
        _proofRecords.push(proofRecord);
      } else {
        // No anchor — still record as legacy summary so score accumulates
        const summary = {
          executor: id.did,
          task_id: taskId,
          task_type: task.action || 'general',
          risk_level: 'low',
          success: success !== false,
          duration_ms: durationMs,
          tool_calls: trace.events.filter(e => e.type === 'TOOL_CALL').length,
          policy_violations: 0,
          proof_id: proof.proof_id,
          timestamp: new Date().toISOString(),
        };
        trustScoreClient.submitExecutionSummary(summary);
        _summaries.push(summary);
        log({ event: 'trust_score_updated_no_anchor', reason: 'No on-chain anchor — recorded as unverified. Set ATEL_SOLANA_PRIVATE_KEY for verified proofs.' });
      }
      const scoreReport = trustScoreClient.getAgentScore(id.did);
      log({ event: 'trust_score_updated', did: id.did, score: scoreReport.trust_score, total_tasks: scoreReport.total_tasks, success_rate: scoreReport.success_rate, verified_count: scoreReport.verified_count });
      saveTrustScores();

      // Update score on Registry
      try {
        const { serializePayload } = await import('@lawrenceliang-btc/atel-sdk');
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
    } catch (e) { log({ event: 'trust_score_error', error: e.message }); }

    // ── Trust Graph Update ──
    try {
      const interaction = {
        from: task.from,
        to: id.did,
        scene: task.action || 'general',
        success: success !== false,
        task_weight: calculateTaskWeight({
          tool_calls: trace.events.filter(e => e.type === 'TOOL_CALL').length,
          duration_ms: durationMs,
          max_cost: 1,
          risk_level: 'low',
          similar_task_count: _interactions.filter(i => i.from === task.from && i.scene === (task.action || 'general')).length,
        }),
        duration_ms: durationMs,
      };
      trustGraph.recordInteraction(interaction);
      _interactions.push(interaction);
      saveTrustGraph();
      const graphStats = trustGraph.getStats();
      log({ event: 'trust_graph_updated', from: task.from, to: id.did, scene: task.action, nodes: graphStats.total_nodes, edges: graphStats.total_edges, interactions: graphStats.total_interactions });
    } catch (e) { log({ event: 'trust_graph_error', error: e.message }); }

    // ── Anchoring Warning ──
    if (!anchor) {
      log({ event: 'anchor_missing', taskId, warning: 'Proof not anchored on-chain. Set ATEL_SOLANA_PRIVATE_KEY for verifiable trust.', timestamp: new Date().toISOString() });
    }


    // ── Automatic execution audit summary (moved before Platform Complete) ──
    const traceAudit = trace.verify();
    const orderPrice = Number(task?.priceAmount ?? task?.payload?.priceAmount ?? 0);
    const isPaidOrder = taskId.startsWith('ord-') && orderPrice > 0;
    const anchorTx = anchor?.txHash || null;
    let anchorAudit = { checked: false, verified: false, chain: task?.chain || anchor?.chain || null, reason: null };
    if (anchorTx) {
      anchorAudit = await verifyAnchorFromChain(task?.chain || anchor?.chain || 'solana', anchorTx, proof.trace_root);
    }

    const auditReasons = [];
    if (!traceAudit.valid) auditReasons.push('trace_hash_chain_invalid');
    if (isPaidOrder && !anchorTx) auditReasons.push('paid_order_anchor_missing');
    if (anchorTx && anchorAudit.checked && !anchorAudit.verified) auditReasons.push('anchor_verify_failed');

    const auditPassed = auditReasons.length === 0;
    const auditSummary = {
      passed: auditPassed,
      trace_hash_chain_valid: traceAudit.valid,
      trace_errors: traceAudit.errors,
      events_count: trace.events.length,
      trace_root: proof.trace_root,
      order_price: orderPrice,
      anchor_required: isPaidOrder,
      anchor_tx: anchorTx,
      anchor_verify: anchorAudit,
      reasons: auditReasons,
    };


    // ── Platform Complete (async, don't block) ──
    if (ATEL_PLATFORM && taskId.startsWith('ord-')) {
      (async () => {
        try {
          log({ event: 'platform_complete_starting', orderId: taskId, hasAnchor: !!anchor, chain: anchor?.chain });
          
          const timestamp = new Date().toISOString();
          const payload = {
            proofBundle: proof,
            traceRoot: proof.trace_root,
            anchorTx: anchor?.txHash || null,
            chain: anchor?.chain || task?.chain || 'solana',
            traceEvents: trace.events, // Include trace events for verification
            audit: auditSummary,
          };
          const signPayload = { did: id.did, timestamp, payload };
          const signature = sign(signPayload, id.secretKey);
          
          const completeResp = await fetch(`${ATEL_PLATFORM}/trade/v1/order/${taskId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ did: id.did, timestamp, signature, payload }),
            signal: AbortSignal.timeout(30000),
          });
          
          log({ event: 'platform_complete_response', orderId: taskId, status: completeResp.status, ok: completeResp.ok });
          
          if (completeResp.ok) {
            log({ event: 'platform_complete_success', orderId: taskId });
          } else {
            const error = await completeResp.text();
            log({ event: 'platform_complete_failed', orderId: taskId, error, status: completeResp.status });
            console.error('[ERROR] Platform complete failed:', error);
          }
        } catch (err) {
          log({ event: 'platform_complete_error', orderId: taskId, error: err.message, stack: err.stack });
          console.error('[ERROR] Platform complete exception:', err);
        }
      })();
    }

    // ── Automatic execution audit summary (always-on) ──
    log({ event: 'task_audit_summary', taskId, from: task.from, action: task.action, audit: auditSummary, timestamp: new Date().toISOString() });
    if (!auditPassed) {
      log({ event: 'task_audit_failed', taskId, from: task.from, action: task.action, reasons: auditReasons, timestamp: new Date().toISOString() });
    }

    log({ event: 'task_completed', taskId, from: task.from, action: task.action, success: success !== false, audit_passed: auditPassed, proof_id: proof.proof_id, trace_root: proof.trace_root, anchor_tx: anchorTx, duration_ms: durationMs, timestamp: new Date().toISOString() });

    // ── Notify owner (optional) ──
    if (ATEL_NOTIFY_GATEWAY && ATEL_NOTIFY_TARGET) {
      try {
        const resultText = typeof result === 'object' ? (result.response || JSON.stringify(result)).toString().slice(0, 300) : String(result).slice(0, 300);
        const status = (success !== false && auditPassed) ? '✅' : '❌';
        const auditLine = auditPassed ? 'Audit: PASS' : `Audit: FAIL (${auditReasons.join(',')})`;
        const msg = `${status} ATEL Task ${taskId}\nFrom: ${task.from.slice(-12)}\nAction: ${task.action}\nDuration: ${(durationMs/1000).toFixed(1)}s\n${auditLine}\nResult: ${resultText}`;
        const token = (() => { try { return JSON.parse(readFileSync(join(process.env.HOME || '', '.openclaw/openclaw.json'), 'utf-8')).gateway?.auth?.token || ''; } catch { return ''; } })();
        if (token) {
          fetch(`${ATEL_NOTIFY_GATEWAY}/tools/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ tool: 'message', args: { action: 'send', message: msg, target: ATEL_NOTIFY_TARGET } }),
            signal: AbortSignal.timeout(5000),
          }).then(() => log({ event: 'notify_sent', taskId })).catch(e => log({ event: 'notify_failed', taskId, error: e.message }));
        }
      } catch (e) { log({ event: 'notify_error', taskId, error: e.message }); }
    }

    log({ event: 'result_push_starting', taskId, hasSenderEndpoint: !!task.senderEndpoint, hasSenderCandidates: !!(task.senderCandidates?.length) });

    // Push result back to sender
    // Re-lookup sender if we don't have their endpoint (e.g., lookup failed at accept time)
    try {
    if (!task.senderCandidates && !task.senderEndpoint) {
      try {
        const r = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(task.from)}`, { signal: AbortSignal.timeout(10000) });
        if (r.ok) {
          const data = await r.json();
          task.senderEndpoint = data.endpoint;
          task.senderCandidates = data.candidates;
          log({ event: 'sender_relookup_ok', taskId, endpoint: data.endpoint, candidates: data.candidates?.length || 0 });
        }
      } catch (e) { log({ event: 'sender_relookup_failed', taskId, error: e.message }); }
    }

    if (task.senderCandidates || task.senderEndpoint) {
      const resultPayload = {
        taskId,
        status: (success !== false && auditPassed) ? 'completed' : 'failed',
        result,
        proof: { proof_id: proof.proof_id, trace_root: proof.trace_root, events_count: trace.events.length },
        anchor: anchor ? { chain: 'solana', txHash: anchor.txHash, block: anchor.blockNumber } : null,
        execution: { duration_ms: durationMs, encrypted: task.encrypted },
        audit: auditSummary,
        rollback: rollbackReport ? { total: rollbackReport.total, succeeded: rollbackReport.succeeded, failed: rollbackReport.failed } : null,
      };
      try {
        const push = await pushResultWithRetry(task, taskId, resultPayload, { maxAttempts: 4 });
        if (push.ok) {
          log({ event: 'result_pushed', taskId, to: task.from, via: push.targetUrl, relay: push.isRelay, attempts: push.attempts });
        } else {
          enqueueResultPush({
            taskId,
            task,
            resultPayload,
            retryCount: 4,
            nextRetryAt: Date.now() + 15000,
            lastError: push.error,
            createdAt: Date.now(),
          });
          log({ event: 'result_push_failed_queued', taskId, error: push.error, queue_size: resultPushQueue.length });
        }
      } catch (e) {
        enqueueResultPush({
          taskId,
          task,
          resultPayload,
          retryCount: 1,
          nextRetryAt: Date.now() + 15000,
          lastError: e.message,
          createdAt: Date.now(),
        });
        log({ event: 'result_push_failed_queued', taskId, error: e.message, queue_size: resultPushQueue.length });
      }
    } else {
      log({ event: 'result_push_skipped', taskId, to: task.from, reason: 'No sender endpoint or candidates found — sender may not be reachable' });
    }
    } catch (pushErr) { log({ event: 'result_push_outer_error', taskId, error: pushErr.message, stack: pushErr.stack?.split('\n')[1]?.trim() }); }

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
    // Reload policy on each request so DID allow/block updates take effect immediately.
    const currentPolicy = loadPolicy();
    enforcer.policy = currentPolicy;

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

    // ── Task Mode Check (P2P) ──
    const taskMode = currentPolicy.taskMode || 'auto';
    
    if (taskMode === 'off') {
      const reason = 'Agent task mode is off — not accepting tasks';
      const rp = generateRejectionProof(message.from, action, reason, 'TASK_MODE_OFF');
      log({ event: 'task_mode_rejected', from: message.from, action, reason: 'task_mode_off', timestamp: new Date().toISOString() });
      return { status: 'rejected', error: reason, proof: rp };
    }
    
    if (taskMode === 'confirm' || currentPolicy.autoAcceptP2P === false) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Queue for manual approval
      const pending = loadPending();
      pending[taskId] = {
        source: 'p2p',
        from: message.from,
        action,
        payload,
        price: 0,
        status: 'pending_confirm',
        receivedAt: new Date().toISOString(),
        encrypted: !!session?.encrypted,
      };
      savePending(pending);
      log({ event: 'task_queued', taskId, from: message.from, action, reason: taskMode === 'confirm' ? 'task_mode_confirm' : 'autoAcceptP2P_off', timestamp: new Date().toISOString() });
      return { status: 'queued', taskId, message: 'Task queued for manual confirmation. Use: atel approve ' + taskId };
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
      fetch(EXECUTOR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, from: message.from, action, payload, encrypted: !!session?.encrypted, toolProxy: `http://127.0.0.1:${toolProxyPort}` }) }).catch(e => log({ event: 'executor_forward_failed', taskId, error: e.message }));
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
      const anchor = await anchorOnChain(proof.trace_root, { proof_id: proof.proof_id, executorDid: id.did, requesterDid: message.from, action, taskId });
      const echoAcceptedAt = pendingTasks[taskId]?.acceptedAt;
      delete pendingTasks[taskId]; saveTasks(pendingTasks);

      // ── Trust Score + Graph Update (echo mode) ──
      try {
        const echoSuccess = true;
        const echoDurationMs = Date.now() - new Date(echoAcceptedAt || Date.now()).getTime();
        if (anchor?.txHash) {
          const proofRecord = {
            traceRoot: proof.trace_root, txHash: anchor.txHash, chain: anchor.chain || 'solana',
            executor: id.did, taskFrom: message.from, action, success: echoSuccess,
            durationMs: echoDurationMs, riskLevel: 'low', policyViolations: 0,
            proofId: proof.proof_id, timestamp: new Date().toISOString(), verified: true,
          };
          trustScoreClient.addProofRecord(proofRecord);
          _proofRecords.push(proofRecord);
        } else {
          const summary = {
            executor: id.did, task_id: taskId, task_type: action || 'general',
            risk_level: 'low', success: echoSuccess, duration_ms: echoDurationMs,
            tool_calls: 0, policy_violations: 0, proof_id: proof.proof_id,
            timestamp: new Date().toISOString(),
          };
          trustScoreClient.submitExecutionSummary(summary);
          _summaries.push(summary);
        }
        saveTrustScores();
        const interaction = {
          from: message.from, to: id.did, scene: action || 'general',
          success: echoSuccess, task_weight: 0.1, duration_ms: echoDurationMs,
        };
        trustGraph.recordInteraction(interaction);
        _interactions.push(interaction);
        saveTrustGraph();
      } catch (e) { log({ event: 'trust_update_error_echo', error: e.message }); }

      log({ event: 'task_completed', taskId, from: message.from, action, mode: 'echo', proof_id: proof.proof_id, anchor_tx: anchor?.txHash || null, timestamp: new Date().toISOString() });
      return { status: 'completed', taskId, result, proof, anchor };
    }
  });

  endpoint.onProof(async (message) => { log({ event: 'proof_received', from: message.from, payload: message.payload, timestamp: new Date().toISOString() }); });

  await endpoint.start();

  // Background retry for failed result pushes (durable queue)
  const flushResultPushQueue = async () => {
    if (!resultPushQueue.length) return;
    const now = Date.now();
    const remaining = [];
    for (const item of resultPushQueue) {
      if (item.nextRetryAt && now < item.nextRetryAt) {
        remaining.push(item);
        continue;
      }
      try {
        const push = await pushResultWithRetry(item.task, item.taskId, item.resultPayload, { maxAttempts: 2 });
        if (push.ok) {
          log({ event: 'result_push_recovered', taskId: item.taskId, to: item.task?.from, via: push.targetUrl, relay: push.isRelay, attempts: (item.retryCount || 0) + push.attempts });
        } else {
          const retryCount = (item.retryCount || 0) + 2;
          if (retryCount >= 6) { // Reduced from 10 to 6
            log({ event: 'result_push_give_up', taskId: item.taskId, to: item.task?.from, error: push.error, retryCount });
          } else {
            remaining.push({ ...item, retryCount, lastError: push.error, nextRetryAt: Date.now() + Math.min(60000, 5000 * Math.pow(2, Math.min(retryCount, 6))) });
          }
        }
      } catch (e) {
        const retryCount = (item.retryCount || 0) + 1;
        if (retryCount >= 6) { // Reduced from 10 to 6
          log({ event: 'result_push_give_up', taskId: item.taskId, to: item.task?.from, error: e.message, retryCount });
        } else {
          remaining.push({ ...item, retryCount, lastError: e.message, nextRetryAt: Date.now() + Math.min(60000, 5000 * Math.pow(2, Math.min(retryCount, 6))) });
        }
      }
    }
    resultPushQueue = remaining;
    saveResultPushQueue(resultPushQueue);
  };

  // Run immediately once, then periodically
  flushResultPushQueue().catch((e) => log({ event: 'result_push_flush_error', error: e.message }));
  setInterval(() => {
    flushResultPushQueue().catch((e) => log({ event: 'result_push_flush_error', error: e.message }));
  }, 15000);

  // Auto-register to Registry with candidates
  if (capTypes.length > 0 && networkConfig.candidates && networkConfig.candidates.length > 0) {
    try {
      const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
      const bestDirect = networkConfig.candidates.find(c => c.type !== 'relay') || networkConfig.candidates[0];
      const discoverable = policy.discoverable !== false;
      const wallets = await getWalletAddresses();
      const preferredChain = detectPreferredChain();
      await regClient.register({ 
        name: id.agent_id, 
        capabilities: caps, 
        endpoint: bestDirect.url, 
        candidates: networkConfig.candidates, 
        discoverable, 
        wallets, 
        metadata: { preferredChain } 
      }, id);
      log({ event: 'auto_registered', registry: REGISTRY_URL, candidates: networkConfig.candidates.length, discoverable, wallets: wallets ? Object.keys(wallets) : [], preferredChain });
    } catch (e) { log({ event: 'auto_register_failed', error: e.message }); }
  }

  // Register with relay server and start polling for relayed requests
  const relayCandidate = networkConfig.candidates?.find(c => c.type === 'relay');
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
    port: p, candidates: networkConfig.candidates || [], capabilities: capTypes,
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
    if (builtinExecutor) await builtinExecutor.stop();
    await endpoint.stop(); 
    process.exit(0); 
  });
  process.on('SIGTERM', async () => { 
    heartbeat.stop();
    if (tunnelManager) await tunnelManager.stop();
    if (builtinExecutor) await builtinExecutor.stop();
    await endpoint.stop(); 
    process.exit(0); 
  });

  // Global error handlers
  process.on('uncaughtException', (err) => {
    log({ event: 'uncaught_exception', error: err.message, stack: err.stack });
    console.error('[FATAL] Uncaught exception:', err);
    // Don't exit immediately, give time to log
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    log({ event: 'unhandled_rejection', reason: String(reason), promise: String(promise) });
    console.error('[FATAL] Unhandled rejection:', reason);
    // Don't exit immediately, give time to log
    setTimeout(() => process.exit(1), 1000);
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
  
  // Parse capabilities with optional pricing (e.g., "command_exec:10,web_search:5")
  const caps = parseCapabilitiesWithPricing(capabilities || 'general');
  saveCapabilities(caps);
  
  let ep = endpointUrl;
  const net = loadNetwork();
  if (!ep) { ep = net?.endpoint || 'http://localhost:3100'; }
  const discoverable = policy.discoverable !== false;
  const client = new RegistryClient({ registryUrl: REGISTRY_URL });
  const wallets = await getWalletAddresses();
  const preferredChain = detectPreferredChain();
  const registerPayload = {
    name: name || id.agent_id,
    capabilities: caps,
    endpoint: ep,
    discoverable,
  };
  if (net?.candidates?.length) registerPayload.candidates = net.candidates;
  if (wallets) registerPayload.wallets = wallets;
  if (preferredChain) registerPayload.metadata = { preferredChain };

  const entry = await client.register(registerPayload, id);
  if (!wallets || !preferredChain) {
    console.error('[register] INFO: registered without published chain readiness. Yellow page registration still works. Free tasks can run normally. Paid orders require an anchoring key at execution time; re-register or restart later if you want wallets/preferredChain shown in the registry.');
  }
  
  // Display registration info with pricing
  const capDisplay = caps.map(c => {
    if (c.pricing?.minPrice > 0) {
      return `${c.type} (min: $${c.pricing.minPrice.toFixed(2)})`;
    }
    return `${c.type} (free)`;
  });
  
  console.log(JSON.stringify({
    status: 'registered',
    did: entry.did,
    name: entry.name,
    capabilities: capDisplay,
    endpoint: ep,
    discoverable,
    wallets: wallets || null,
    preferredChain: preferredChain || null,
    registry: REGISTRY_URL,
  }, null, 2));
}

async function cmdSearch(capability) {
  const client = new RegistryClient({ registryUrl: REGISTRY_URL });
  const result = await client.search({ type: capability, limit: 10 });
  
  // Enhanced display with pricing info
  if (result.agents && result.agents.length > 0) {
    console.log(`\nFound ${result.agents.length} agent(s) with capability: ${capability}\n`);
    
    for (const agent of result.agents) {
      console.log(`Agent: ${agent.name} (${agent.did})`);
      console.log('Capabilities:');
      
      if (Array.isArray(agent.capabilities)) {
        for (const cap of agent.capabilities) {
          if (typeof cap === 'string') {
            console.log(`  - ${cap} (free)`);
          } else if (cap.type) {
            const price = cap.pricing?.minPrice;
            if (price && price > 0) {
              console.log(`  - ${cap.type} (min: $${price.toFixed(2)})`);
            } else {
              console.log(`  - ${cap.type} (free)`);
            }
          }
        }
      }
      
      console.log(`Endpoint: ${agent.endpoint || 'N/A'}`);
      if (agent.wallets) {
        const chains = Object.keys(agent.wallets).join(', ');
        console.log(`Chains: ${chains}`);
      }
      console.log('');
    }
  } else {
    console.log('No agents found');
  }
}

function safeReadJsonObject(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function cmdHandshake(remoteEndpoint, remoteDid) {
  const id = requireIdentity();
  const client = new AgentClient(id);
  const hsManager = new HandshakeManager(id);
  const wallets = await getWalletAddresses();
  let did = remoteDid;
  if (!did) { const h = await client.health(remoteEndpoint); did = h.did; }
  const session = await client.handshake(remoteEndpoint, hsManager, did, wallets);
  console.log(JSON.stringify({ status: 'handshake_complete', sessionId: session.sessionId, remoteDid: did, encrypted: session.encrypted, remoteWalletsVerified: session.remoteWalletsVerified, remoteWallets: session.remoteWallets }, null, 2));
  const sf = resolve(ATEL_DIR, 'sessions.json');
  let sessions = safeReadJsonObject(sf, {});
  sessions[remoteEndpoint] = { did, sessionId: session.sessionId, encrypted: session.encrypted };
  writeFileSync(sf, JSON.stringify(sessions, null, 2));
}

async function cmdTask(target, taskJson) {
  const id = requireIdentity();
  const policy = loadPolicy();
  const tp = policy.trustPolicy || DEFAULT_POLICY.trustPolicy;

  // Parse task payload and extract risk level
  const payload = typeof taskJson === 'string' ? JSON.parse(taskJson) : taskJson;
  if (!payload || typeof payload !== 'object') {
    console.error('Error: Task payload is required and must be a valid JSON object');
    console.error('Usage: atel task <DID> \'{"action":"general","payload":{"prompt":"..."}}\'');
    process.exit(1);
  }
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

    // Step 3: create task request with signature (version 2)
    const taskRequest = {
      version: 2,
      orderId: null,  // P2P mode has no order
      taskId: generateTaskId(),
      requesterDid: id.did,
      executorDid: remoteDid,
      capability: payload.action || 'general',
      description: payload.payload?.prompt || payload.payload?.description || 'P2P task',
      payload: payload.payload || {},
      timestamp: new Date().toISOString()
    };
    
    // Sign task request
    const taskSignature = await signTaskRequest(taskRequest, id.secretKey);
    
    // Embed taskRequest and signature into payload
    const enhancedPayload = {
      ...payload,
      _taskRequest: taskRequest,
      _taskSignature: taskSignature
    };
    
    // Step 4: send task
    const msg = createMessage({ type: 'task', from: id.did, to: remoteDid, payload: enhancedPayload, secretKey: id.secretKey });
    const relayAck = await relaySend('/atel/v1/task', msg);

    console.log(JSON.stringify({ status: 'task_sent', remoteDid, via: 'relay', relay_ack: relayAck, note: 'Relay mode is async. Waiting for result (up to 120s)...' }));

    // Wait for result to arrive in inbox (poll for task-result)
    // Extract taskId from relay ack (assigned by remote agent), fallback to msg fields
    const taskId = relayAck?.result?.taskId || msg.id || msg.payload?.taskId;
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
            // Match by taskId first (precise), fallback to from+event (legacy)
            if (entry.event === 'result_received' && entry.from === remoteDid && (!taskId || entry.taskId === taskId)) {
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
    let sessions = safeReadJsonObject(sf, {});
    sessions[remoteEndpoint] = { did: remoteDid };
    writeFileSync(sf, JSON.stringify(sessions, null, 2));

    // Create task request with signature (version 2)
    const taskRequest = {
      version: 2,
      orderId: null,  // P2P mode has no order
      taskId: generateTaskId(),
      requesterDid: id.did,
      executorDid: remoteDid,
      capability: payload.action || 'general',
      description: payload.payload?.prompt || payload.payload?.description || 'P2P task',
      payload: payload.payload || {},
      timestamp: new Date().toISOString()
    };
    
    // Sign task request
    const taskSignature = await signTaskRequest(taskRequest, id.secretKey);
    
    // Embed taskRequest and signature into payload
    const enhancedPayload = {
      ...payload,
      _taskRequest: taskRequest,
      _taskSignature: taskSignature
    };

    const msg = createMessage({ type: 'task', from: id.did, to: remoteDid, payload: enhancedPayload, secretKey: id.secretKey });
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

const PLATFORM_URL = process.env.ATEL_PLATFORM || process.env.ATEL_REGISTRY || 'https://api.atelai.org';

async function signedFetch(method, path, payload = {}) {
  const id = requireIdentity();
  const { default: nacl } = await import('tweetnacl');
  const { serializePayload } = await import('@lawrenceliang-btc/atel-sdk');
  const ts = new Date().toISOString();
  const signable = serializePayload({ payload, did: id.did, timestamp: ts });
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), id.secretKey)).toString('base64');
  const body = JSON.stringify({ did: id.did, payload, timestamp: ts, signature: sig });
  // Always use POST for signed requests (DIDAuth reads body, GET cannot have body)
  console.error("DEBUG URL:", `${PLATFORM_URL}${path}`); const res = await fetch(`${PLATFORM_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const text = await res.text(); console.error("DEBUG Response:", text); const data = JSON.parse(text);
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

async function cmdWithdraw(amount, channel, address) {
  if (!amount || isNaN(amount)) { console.error('Usage: atel withdraw <amount> [channel] [address]'); process.exit(1); }
  if (channel && channel.startsWith('crypto_') && !address) {
    console.error('Error: recipient wallet address required for crypto withdrawal');
    console.error('Usage: atel withdraw <amount> crypto_base <your_wallet_address>');
    process.exit(1);
  }
  const data = await signedFetch('POST', '/account/v1/withdraw', { amount: parseFloat(amount), channel: channel || 'manual', address: address || '' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdTransactions() {
  const data = await signedFetch('GET', '/account/v1/transactions');
  console.log(JSON.stringify(data, null, 2));
}

// ─── Trade Commands ──────────────────────────────────────────────

// ─── Trade Task: High-level one-shot command ────────────────────
async function cmdTradeTask(capability, description) {
  if (!capability) { console.error('Usage: atel trade-task <capability> <description> [--budget N] [--executor DID] [--timeout 300]'); process.exit(1); }
  const id = requireIdentity();
  const budget = parseFloat(rawArgs.find((a, i) => rawArgs[i-1] === '--budget') || '0');
  const executorArg = rawArgs.find((a, i) => rawArgs[i-1] === '--executor') || '';
  const timeout = parseInt(rawArgs.find((a, i) => rawArgs[i-1] === '--timeout') || '300') * 1000;
  const desc = description || capability;

  // Step 1: Find executor
  let executorDid = executorArg;
  if (!executorDid) {
    console.error(`[trade-task] Searching for executor with capability: ${capability}...`);
    const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
    const results = await regClient.search({ type: capability, limit: 5 });
    if (results.length === 0) { console.error('[trade-task] No executor found for capability: ' + capability); process.exit(1); }
    // Pick best by trust score (if available), exclude self
    const candidates = results.filter(r => r.did !== id.did);
    if (candidates.length === 0) { console.error('[trade-task] No other executor found (only self)'); process.exit(1); }
    const best = candidates[0]; // Registry returns sorted by score
    executorDid = best.did;
    console.error(`[trade-task] Found executor: ${best.name || best.did} (score: ${best.trustScore || 'N/A'})`);
  }

  // Step 2: Create order
  console.error(`[trade-task] Creating order: ${capability}, budget: $${budget}...`);
  const orderData = await signedFetch('POST', '/trade/v1/order', {
    executorDid, capabilityType: capability, priceAmount: budget, priceCurrency: 'USD', pricingModel: 'per_task',
  });
  const orderId = orderData.orderId;
  console.error(`[trade-task] Order created: ${orderId}`);

  // Step 3: Poll for status changes (executor accepts → auto-escrow → executes → completes)
  console.error(`[trade-task] Waiting for executor to accept and complete (timeout: ${timeout/1000}s)...`);
  const startTime = Date.now();
  let lastStatus = 'created';
  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const info = await signedFetch('GET', `/trade/v1/order/${orderId}`);
      if (info.status !== lastStatus) {
        console.error(`[trade-task] Status: ${lastStatus} → ${info.status}`);
        lastStatus = info.status;
      }
      if (info.status === 'completed' || info.status === 'settled') {
        console.error(`[trade-task] Task completed! Confirming delivery...`);
        // Auto-confirm if still completed (not yet settled)
        if (info.status === 'completed') {
          try {
            await signedFetch('POST', `/trade/v1/order/${orderId}/confirm`);
            console.error(`[trade-task] Delivery confirmed and settled.`);
          } catch (e) {
            console.error(`[trade-task] Auto-confirm skipped: ${e.message}`);
          }
        }
        // Output final order info
        const final = await signedFetch('GET', `/trade/v1/order/${orderId}`);
        console.log(JSON.stringify(final, null, 2));
        return;
      }
      if (info.status === 'rejected' || info.status === 'cancelled') {
        console.error(`[trade-task] Order ${info.status}. Aborting.`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`[trade-task] Poll error: ${e.message}`);
    }
  }
  console.error(`[trade-task] Timeout waiting for completion. Order: ${orderId}, last status: ${lastStatus}`);
  process.exit(1);
}

async function cmdOrder(executorDid, capType, price) {
  if (!executorDid || !capType || !price) { console.error('Usage: atel order <executorDid> <capabilityType> <price> [--desc "task description"]'); process.exit(1); }
  const description = rawArgs.find((a, i) => rawArgs[i-1] === '--desc') || '';
  const id = requireIdentity();
  
  try {
    // Create task request (version 2 with signature)
    const taskRequest = {
      version: 2,
      orderId: null,  // Will be filled by Platform
      taskId: generateTaskId(),
      requesterDid: id.did,
      executorDid: executorDid,
      capability: capType,
      description: description,
      payload: description ? { description } : {},
      timestamp: new Date().toISOString()
    };
    
    // Sign task request
    const taskSignature = await signTaskRequest(taskRequest, id.secretKey);
    
    // Send to Platform
    const data = await signedFetch('POST', '/trade/v1/order', {
      executorDid,
      capabilityType: capType,
      priceAmount: parseFloat(price),
      priceCurrency: 'USD',
      pricingModel: 'per_task',
      description,
      version: 2,  // New version with signature
      taskRequest: taskRequest,
      taskSignature: taskSignature
    });
    
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    // Try to parse error message for price validation failure
    const errorMsg = error.message || '';
    const priceMatch = errorMsg.match(/minimum ([\d.]+) (\w+) for (\w+)/);
    
    if (priceMatch) {
      const [, minPrice, currency, capability] = priceMatch;
      console.error('\n❌ Order creation failed: price too low\n');
      console.error(`Executor requires minimum $${parseFloat(minPrice).toFixed(2)} ${currency} for ${capability}`);
      console.error(`Your offer: $${parseFloat(price).toFixed(2)} ${currency}\n`);
      console.error(`Suggestion: Increase your offer to at least $${parseFloat(minPrice).toFixed(2)}`);
      process.exit(1);
    }
    
    // Other errors
    console.error('Order creation failed:', errorMsg);
    process.exit(1);
  }
}

async function cmdOrderInfo(orderId) {
  if (!orderId) { console.error('Usage: atel order-info <orderId>'); process.exit(1); }
  const res = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}`);
  const text = await res.text(); console.error("DEBUG Response:", text); const data = JSON.parse(text);
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
  console.error('⚠️  DEPRECATED: Escrow is now automatic on accept. No action needed.');
  if (!orderId) { process.exit(0); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/escrow`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdComplete(orderId, taskId) {
  if (!orderId) { console.error('Usage: atel complete <orderId> [taskId] [--proof]'); process.exit(1); }
  const id = requireIdentity();
  const policy = loadPolicy();
  const effectiveTaskId = taskId || orderId;
  const payload = {};
  if (taskId) payload.taskId = taskId;

  // Fetch order info for context
  let requesterDid = 'unknown';
  let orderInfo = null;
  try {
    orderInfo = await signedFetch('GET', `/trade/v1/order/${orderId}`);
    requesterDid = orderInfo.requesterDid || 'unknown';
  } catch (e) { console.error(`[complete] Warning: could not fetch order info: ${e.message}`); }

  // ========== Verify Requester Signature (version >= 2) ==========
  if (orderInfo && orderInfo.version >= 2) {
    if (!orderInfo.taskRequest || !orderInfo.taskSignature) {
      console.error('[complete] ERROR: Order version 2+ requires taskRequest and taskSignature');
      process.exit(1);
    }

    // Extract requester public key from DID
    const requesterPublicKey = orderInfo.requesterDid.split(':')[3]; // did:atel:ed25519:PUBLIC_KEY

    // Verify signature
    const valid = await verifyTaskSignature(
      orderInfo.taskRequest,
      orderInfo.taskSignature,
      requesterPublicKey
    );

    if (!valid) {
      console.error('[complete] ERROR: Invalid task signature from requester');
      process.exit(1);
    }

    // Verify taskRequest matches order
    if (orderInfo.taskRequest.orderId !== orderId) {
      console.error('[complete] ERROR: Order ID mismatch in taskRequest');
      process.exit(1);
    }

    if (orderInfo.taskRequest.executorDid !== id.did) {
      console.error('[complete] ERROR: Executor DID mismatch in taskRequest');
      process.exit(1);
    }

    console.error('[complete] Task signature verified successfully');
  }
  // ========== Signature Verification End ==========

  // ── ContentAuditor: audit the completion context ──
  const auditor = new ContentAuditor();
  const auditResult = auditor.audit({ orderId, taskId: effectiveTaskId, action: 'complete' }, { action: 'complete', from: requesterDid });
  if (auditResult.blocked) {
    console.error(`[complete] BLOCKED by ContentAuditor: ${auditResult.reason}`);
    process.exit(1);
  }
  if (auditResult.warnings?.length > 0) {
    console.error(`[complete] ContentAuditor warnings: ${auditResult.warnings.join(', ')}`);
  }

  // ── PolicyEnforcer: check policy compliance ──
  const enforcer = new PolicyEnforcer(policy);
  const policyCheck = enforcer.check({ from: requesterDid, action: 'complete', payload: { orderId } });
  if (policyCheck && !policyCheck.allowed) {
    console.error(`[complete] BLOCKED by PolicyEnforcer: ${policyCheck.reason}`);
    process.exit(1);
  }

  // Try to load existing trace, otherwise generate fresh proof + anchor
  let proof = null;
  let anchor = null;
  let trace = null;
  let traceEvents = [];
  const traceData = loadTrace(effectiveTaskId);
  if (traceData) {
    try {
      const lines = traceData.trim().split('\n').map(l => JSON.parse(l));
      const proofLine = lines.find(l => l.proof_id);
      if (proofLine) proof = proofLine;
      const anchorLine = lines.find(l => l.anchor_tx);
      if (anchorLine) anchor = { txHash: anchorLine.anchor_tx, trace_root: anchorLine.trace_root };
      traceEvents = lines.filter(l => l && typeof l === 'object' && typeof l.type === 'string' && typeof l.hash === 'string');
    } catch {}
  }

  // Generate fresh proof if none found
  if (!proof) {
    console.error('[complete] Generating execution trace + proof...');
    trace = new ExecutionTrace(effectiveTaskId, id);
    
    // ========== Include taskRequest and signature in trace (version >= 2) ==========
    if (orderInfo && orderInfo.version >= 2) {
      trace.append('TASK_RECEIVED', {
        orderId,
        taskId: effectiveTaskId,
        requesterDid,
        taskRequest: orderInfo.taskRequest,
        taskSignature: orderInfo.taskSignature,
        verifiedAt: new Date().toISOString()
      });
    } else {
      // Legacy: no signature
      trace.append('TASK_RECEIVED', { orderId, taskId: effectiveTaskId, requesterDid });
    }
    // ========== End ==========
    
    trace.append('CONTENT_AUDIT', { result: auditResult.blocked ? 'blocked' : 'passed', warnings: auditResult.warnings || [] });
    trace.append('POLICY_CHECK', { result: 'passed' });
    trace.append('EXECUTION', { mode: 'cli-complete', orderId });
    trace.finalize({ orderId, status: 'completed' });
    saveTrace(effectiveTaskId, trace);
    const proofGen = new ProofGenerator(trace, id);
    proof = proofGen.generate('cli-complete', `order-${orderId}`, JSON.stringify({ orderId, status: 'completed' }));
    console.error(`[complete] Proof generated: ${proof.proof_id}, trace_root: ${proof.trace_root}`);
  }

  // ── On-chain Anchoring ──
  if (!anchor) {
    console.error('[complete] Anchoring proof on-chain...');
    anchor = await anchorOnChain(proof.trace_root, { proof_id: proof.proof_id, executorDid: id.did, requesterDid, taskId: effectiveTaskId, action: 'cli-complete' });
    if (anchor) {
      console.error(`[complete] Anchored on Solana: ${anchor.txHash}`);
    } else {
      console.error('[complete] WARNING: On-chain anchoring failed. Set ATEL_SOLANA_PRIVATE_KEY for verifiable trust.');
    }
  }

  // ── Trust Score Update (persistent, with or without anchor) ──
  try {
    const trustScoreClient = new TrustScoreClient();
    // Load existing records
    try {
      const saved = JSON.parse(readFileSync(SCORE_FILE, 'utf-8'));
      if (saved.proofRecords) for (const r of saved.proofRecords) trustScoreClient.addProofRecord(r);
      if (saved.summaries) for (const s of saved.summaries) trustScoreClient.submitExecutionSummary(s);
    } catch {}
    const _pr = []; const _sm = [];
    try { const saved = JSON.parse(readFileSync(SCORE_FILE, 'utf-8')); if (saved.proofRecords) _pr.push(...saved.proofRecords); if (saved.summaries) _sm.push(...saved.summaries); } catch {}

    if (anchor?.txHash) {
      const proofRecord = {
        traceRoot: proof.trace_root, txHash: anchor.txHash, chain: anchor.chain || 'solana',
        executor: id.did, taskFrom: requesterDid, action: 'cli-complete',
        success: true, durationMs: 0, riskLevel: 'low', policyViolations: 0,
        proofId: proof.proof_id, timestamp: new Date().toISOString(), verified: true,
      };
      trustScoreClient.addProofRecord(proofRecord);
      _pr.push(proofRecord);
    } else {
      const summary = {
        executor: id.did, task_id: effectiveTaskId, task_type: 'cli-complete',
        risk_level: 'low', success: true, duration_ms: 0, tool_calls: 0,
        policy_violations: 0, proof_id: proof.proof_id, timestamp: new Date().toISOString(),
      };
      trustScoreClient.submitExecutionSummary(summary);
      _sm.push(summary);
      console.error('[complete] Trust score updated (unverified — no on-chain anchor)');
    }
    try { writeFileSync(SCORE_FILE, JSON.stringify({ proofRecords: _pr, summaries: _sm }, null, 2)); } catch {}

    const scoreReport = trustScoreClient.getAgentScore(id.did);
    console.error(`[complete] Trust score: ${scoreReport.trust_score} (tasks: ${scoreReport.total_tasks}, verified: ${scoreReport.verified_count})`);

    // ── Push score to Registry ──
    try {
      const { serializePayload } = await import('@lawrenceliang-btc/atel-sdk');
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
      console.error(`[complete] Score pushed to Registry: ${scoreReport.trust_score}`);
    } catch (e) { console.error(`[complete] Registry score push failed: ${e.message}`); }
  } catch (e) { console.error(`[complete] Trust score error: ${e.message}`); }

  const effectiveTraceEvents = trace?.events || traceEvents || [];
  const traceAudit = trace?.verify ? trace.verify() : {
    valid: effectiveTraceEvents.length > 0,
    errors: effectiveTraceEvents.length > 0 ? [] : ['trace_events_missing'],
  };
  const orderPrice = Number(orderInfo?.priceAmount ?? 0);
  const isPaidOrder = orderId.startsWith('ord-') && orderPrice > 0;
  const anchorTx = anchor?.txHash || null;
  const anchorChain = anchorTx ? (anchor?.chain || orderInfo?.chain || 'solana') : (orderInfo?.chain || null);
  const auditReasons = [];
  if (!traceAudit.valid) auditReasons.push('trace_hash_chain_invalid');
  if (isPaidOrder && !anchorTx) auditReasons.push('paid_order_anchor_missing');
  const auditPassed = auditReasons.length === 0;
  const auditSummary = {
    passed: auditPassed,
    trace_hash_chain_valid: traceAudit.valid,
    trace_errors: traceAudit.errors,
    events_count: effectiveTraceEvents.length,
    trace_root: proof.trace_root,
    order_price: orderPrice,
    anchor_required: isPaidOrder,
    anchor_tx: anchorTx,
    anchor_chain: anchorChain,
    reasons: auditReasons,
  };

  // Attach proof + anchor + audit to payload
  payload.proofBundle = proof;
  payload.traceRoot = proof.trace_root;
  payload.traceEvents = effectiveTraceEvents;
  payload.audit = auditSummary;
  if (anchorTx) payload.anchorTx = anchorTx;
  if (anchorChain) payload.chain = anchorChain;

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
  const text = await res.text(); console.error("DEBUG Response:", text); const data = JSON.parse(text);
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
  const text = await res.text(); console.error("DEBUG Response:", text); const data = JSON.parse(text);
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
  const text = await res.text(); console.error("DEBUG Response:", text); const data = JSON.parse(text);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdBoostCancel(boostId) {
  if (!boostId) { console.error('Usage: atel boost-cancel <boostId>'); process.exit(1); }
  const data = await signedFetch('DELETE', `/boost/v1/cancel/${boostId}`);
  console.log(JSON.stringify(data, null, 2));
}

// ─── Offer Commands ──────────────────────────────────────────────

async function cmdOfferCreate(cap, price) {
  if (!cap) { console.error('Usage: atel offer <capability> <price> [--title "..."] [--desc "..."]'); process.exit(1); }
  const titleIdx = rawArgs.indexOf('--title');
  const descIdx = rawArgs.indexOf('--desc');
  const title = titleIdx >= 0 ? rawArgs[titleIdx + 1] : undefined;
  const desc = descIdx >= 0 ? rawArgs[descIdx + 1] : undefined;
  const body = { capabilityType: cap, priceAmount: parseFloat(price) || 0 };
  if (title) body.title = title;
  if (desc) body.description = desc;
  const data = await signedFetch('POST', '/trade/v1/offer', body);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdOfferList(did) {
  const params = new URLSearchParams();
  if (did) params.set('did', did);
  const capIdx = rawArgs.indexOf('--capability');
  if (capIdx >= 0) params.set('capability', rawArgs[capIdx + 1]);
  const url = `/trade/v1/offers${params.toString() ? '?' + params : ''}`;
  const resp = await fetch(`${PLATFORM_URL}${url}`);
  const data = await resp.json();
  if (data.offers && data.offers.length > 0) {
    console.log(`\n  Found ${data.count} offer(s):\n`);
    for (const o of data.offers) {
      console.log(`  ${o.offerId}  ${o.executorName || o.executorDid.slice(0,20)+'...'}  ${o.capabilityType}  $${o.priceAmount}  orders:${o.totalOrders}  completed:${o.totalCompleted}  ${o.title || ''}`);
    }
    console.log('');
  } else {
    console.log('  No active offers found.');
  }
}

async function cmdOfferUpdate(offerId) {
  if (!offerId) { console.error('Usage: atel offer-update <offerId> [--price N] [--title "..."] [--desc "..."] [--status active|paused]'); process.exit(1); }
  const body = {};
  const priceIdx = rawArgs.indexOf('--price');
  const titleIdx = rawArgs.indexOf('--title');
  const descIdx = rawArgs.indexOf('--desc');
  const statusIdx = rawArgs.indexOf('--status');
  if (priceIdx >= 0) body.priceAmount = parseFloat(rawArgs[priceIdx + 1]);
  if (titleIdx >= 0) body.title = rawArgs[titleIdx + 1];
  if (descIdx >= 0) body.description = rawArgs[descIdx + 1];
  if (statusIdx >= 0) body.status = rawArgs[statusIdx + 1];
  const data = await signedFetch('POST', `/trade/v1/offer/${offerId}/update`, body);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdOfferClose(offerId) {
  if (!offerId) { console.error('Usage: atel offer-close <offerId>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/offer/${offerId}/close`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdOfferBuy(offerId, desc) {
  if (!offerId) { console.error('Usage: atel offer-buy <offerId> [description]'); process.exit(1); }
  const id = requireIdentity();
  
  // Get offer details to extract executorDid and capability (public API, no auth needed)
  const offerRes = await fetch(`${PLATFORM_URL}/trade/v1/offer/${offerId}`);
  if (!offerRes.ok) {
    console.error(`Error: Failed to fetch offer details (HTTP ${offerRes.status})`);
    process.exit(1);
  }
  const offerData = await offerRes.json();
  if (!offerData || !offerData.executorDid) {
    console.error('Error: Invalid offer data');
    process.exit(1);
  }
  
  const description = desc ? rawArgs.slice(rawArgs.indexOf(offerId) + 1).join(' ') : `Purchased from offer ${offerId}`;
  
  // Create task request (version 2 with signature)
  const taskRequest = {
    version: 2,
    orderId: null,  // Will be filled by Platform
    taskId: generateTaskId(),
    requesterDid: id.did,
    executorDid: offerData.executorDid,
    capability: offerData.capabilityType,
    description: description,
    payload: { description },
    timestamp: new Date().toISOString()
  };
  
  // Sign task request
  const taskSignature = await signTaskRequest(taskRequest, id.secretKey);
  
  const body = {
    description: description,
    version: 2,
    taskRequest: taskRequest,
    taskSignature: taskSignature
  };
  
  const data = await signedFetch('POST', `/trade/v1/offer/${offerId}/buy`, body);
  console.log(JSON.stringify(data, null, 2));
}

// ─── Task Mode Commands ──────────────────────────────────────────

async function cmdMode(newMode) {
  const policy = loadPolicy();
  if (!newMode) {
    console.log(JSON.stringify({
      taskMode: policy.taskMode || 'auto',
      autoAcceptPlatform: policy.autoAcceptPlatform !== false,
      autoAcceptP2P: policy.autoAcceptP2P !== false,
    }, null, 2));
    return;
  }
  if (!['auto', 'confirm', 'off'].includes(newMode)) {
    console.error('Usage: atel mode [auto|confirm|off]');
    console.error('  auto    - Accept and execute all tasks automatically (default)');
    console.error('  confirm - Queue tasks for manual approval');
    console.error('  off     - Reject all incoming tasks');
    process.exit(1);
  }
  policy.taskMode = newMode;
  savePolicy(policy);
  console.log(JSON.stringify({ status: 'ok', taskMode: newMode, message: `Task mode set to "${newMode}"` }));
}

async function cmdPending() {
  const pending = loadPending();
  const entries = Object.entries(pending);
  if (entries.length === 0) {
    console.log('No pending tasks.');
    return;
  }
  console.log(`Pending tasks (${entries.length}):\n`);
  for (const [taskId, t] of entries) {
    console.log(`  ${taskId}`);
    console.log(`    Source:  ${t.source}`);
    console.log(`    From:    ${t.from}`);
    console.log(`    Action:  ${t.action}`);
    console.log(`    Price:   $${t.price || 0}`);
    console.log(`    Status:  ${t.status}`);
    console.log(`    Time:    ${t.receivedAt}`);
    if (t.orderId) console.log(`    OrderId: ${t.orderId}`);
    console.log('');
  }
}

async function cmdApprove(taskId) {
  if (!taskId) { console.error('Usage: atel approve <taskId|orderId>'); process.exit(1); }
  const pending = loadPending();
  const task = pending[taskId];
  if (!task) { console.error(`Task "${taskId}" not found in pending queue.`); process.exit(1); }
  if (task.status !== 'pending_confirm') { console.error(`Task "${taskId}" is not pending (status: ${task.status}).`); process.exit(1); }

  if (task.source === 'platform') {
    // Accept via Platform API
    const data = await signedFetch('POST', `/trade/v1/order/${task.orderId}/accept`);
    task.status = 'approved';
    savePending(pending);
    console.log(JSON.stringify({ status: 'approved', taskId, orderId: task.orderId, platform: data }));
  } else {
    // P2P: notify the running agent to process this task
    // Try the agent's local approve endpoint first
    const agentPort = process.env.ATEL_PORT || '3100';
    try {
      const resp = await fetch(`http://127.0.0.1:${agentPort}/atel/v1/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (resp.ok) {
        task.status = 'approved';
        savePending(pending);
        console.log(JSON.stringify({ status: 'approved', taskId, ...data }));
      } else {
        console.error(`Agent error: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      console.error(`Cannot reach agent at port ${agentPort}. Is 'atel start' running?`);
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  }
}

// Extend reject to handle pending tasks too
const _origCmdReject = async (orderId) => {
  if (!orderId) { console.error('Usage: atel reject <orderId|taskId> [reason]'); process.exit(1); }
  // Check if it's a pending task first
  const pending = loadPending();
  if (pending[orderId] && pending[orderId].status === 'pending_confirm') {
    const task = pending[orderId];
    const reason = rawArgs.slice(1).join(' ') || 'Manually rejected';
    if (task.source === 'platform') {
      const data = await signedFetch('POST', `/trade/v1/order/${task.orderId}/reject`);
      task.status = 'rejected';
      task.rejectReason = reason;
      savePending(pending);
      console.log(JSON.stringify({ status: 'rejected', taskId: orderId, orderId: task.orderId, reason, platform: data }));
    } else {
      task.status = 'rejected';
      task.rejectReason = reason;
      savePending(pending);
      console.log(JSON.stringify({ status: 'rejected', taskId: orderId, reason }));
    }
    return;
  }
  // Fall through to Platform order reject
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/reject`);
  console.log(JSON.stringify(data, null, 2));
};

// ─── Main ────────────────────────────────────────────────────────

const [,, cmd, ...rawArgs] = process.argv;
const args = rawArgs.filter(a => !a.startsWith('--'));
const commands = {
  init: () => cmdInit(args[0]),
  info: () => cmdInfo(),
  anchor: () => cmdAnchor(args[0]),
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
  withdraw: () => cmdWithdraw(args[0], args[1], args[2]),
  transactions: () => cmdTransactions(),
  // Trade
  'trade-task': () => cmdTradeTask(args[0], args.slice(1).join(' ')),
  order: () => cmdOrder(args[0], args[1], args[2]),
  'order-info': () => cmdOrderInfo(args[0]),
  accept: () => cmdAccept(args[0]),
  reject: () => _origCmdReject(args[0]),
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
  // Offers
  offer: () => cmdOfferCreate(args[0], args[1]),
  offers: () => cmdOfferList(args[0]),
  'offer-info': () => cmdOfferList(args[0]), // alias — single offer uses GET /offer/:id
  'offer-update': () => cmdOfferUpdate(args[0]),
  'offer-close': () => cmdOfferClose(args[0]),
  'offer-buy': () => cmdOfferBuy(args[0], args[1]),
  // Task Mode
  mode: () => cmdMode(args[0]),
  pending: () => cmdPending(),
  approve: () => cmdApprove(args[0]),
};

if (!cmd || !commands[cmd]) {
  console.log(`ATEL CLI - Agent Trust & Exchange Layer

Usage: atel <command> [args]

Protocol Commands:
  init [name]                          Create agent identity + security policy
  info                                 Show identity, capabilities, network, policy
  anchor <config|info|enable|disable>  Manage on-chain anchoring configuration
  setup [port]                         Configure network (detect IP, UPnP, verify)
  verify                               Verify port reachability
  start [port]                         Start endpoint (auto network + auto register)
  inbox [count]                        Show received messages (default: 20)
  register [name] [caps] [endpoint]    Register on public registry (caps: "type1:price1,type2:price2" or "type1,type2" for free)
  search <capability>                  Search registry for agents (shows pricing info)
  handshake <endpoint> [did]           Handshake with remote agent
  task <target> <json>                 Delegate task (auto trust check)
  result <taskId> <json>               Submit execution result (from executor)
  check <did> [risk]                   Check agent trust (risk: low|medium|high|critical)
  verify-proof <anchor_tx> <root>      Verify on-chain proof
  audit <did_or_url> <taskId>          Deep audit: fetch trace + verify hash chain
  rotate                               Rotate identity key pair (backup + on-chain anchor)

Account Commands:
  balance                              Show platform account balance
  deposit <amount> [channel]           Deposit funds (channel: manual|crypto_solana|crypto_base|crypto_bsc|stripe|alipay)
  withdraw <amount> [channel] [address] Withdraw funds (address required for crypto)
  transactions                         List payment history

Trade Commands:
  trade-task <cap> <desc> [--budget N]   One-shot: search → order → wait → confirm (requester)
  order <executorDid> <cap> <price>    Create a trade order
  order-info <orderId>                 Get order details
  accept <orderId>                     Accept an order (auto-escrow for paid orders)
  reject <orderId>                     Reject an order (executor)
  escrow <orderId>                     [DEPRECATED] Escrow is now automatic on accept
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

Offer Commands (Seller Listings):
  offer <capability> <price>           Publish a service offer (--title, --desc)
  offers [did]                         Browse active offers (--capability filter)
  offer-update <offerId>               Update offer (--price, --title, --desc, --status)
  offer-close <offerId>                Close an offer
  offer-buy <offerId> [description]    Buy from an offer (creates order automatically)

Task Mode Commands:
  mode [auto|confirm|off]              Get or set task acceptance mode
  pending                              List tasks awaiting manual confirmation
  approve <taskId|orderId>             Approve a pending task (forward to executor)

Environment:
  ATEL_DIR                Identity directory (default: .atel)
  ATEL_REGISTRY           Registry URL (default: https://api.atelai.org)
  ATEL_PLATFORM           Platform URL (default: ATEL_REGISTRY value)
  ATEL_EXECUTOR_URL       Local executor HTTP endpoint
  ATEL_SOLANA_PRIVATE_KEY Solana key for on-chain anchoring
  ATEL_SOLANA_RPC_URL     Solana RPC (default: mainnet-beta)
  ATEL_BASE_PRIVATE_KEY   Base chain key for on-chain anchoring
  ATEL_BSC_PRIVATE_KEY    BSC chain key for on-chain anchoring

Trust Policy: Configure .atel/policy.json trustPolicy for automatic
pre-task trust evaluation. Use _risk in payload or --risk flag.

Task Mode: Configure .atel/policy.json taskMode (auto|confirm|off).
  auto    - Accept all tasks automatically (default)
  confirm - Queue tasks for manual approval (atel pending / atel approve)
  off     - Reject all incoming tasks (communication still works)`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
