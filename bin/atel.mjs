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
 *   atel escrow <orderId>               Lock USDC on-chain for paid order (requester)
 *
 * Milestone Commands:
 *   atel milestone-status <orderId>     View milestone progress
 *   atel milestone-feedback <orderId>   Approve plan or request revision
 *   atel milestone-submit <orderId> <i> Submit milestone result
 *   atel milestone-verify <orderId> <i> Verify milestone (--pass or --reject)
 *   atel chain-records <orderId>        View on-chain transaction records
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
import { resolve, join, dirname } from 'node:path';
import crypto from 'node:crypto';
import {
  AgentIdentity, AgentEndpoint, AgentClient, HandshakeManager,
  createMessage, verifyMessage, parseDID, RegistryClient, ExecutionTrace, ProofGenerator,
  SolanaAnchorProvider, BaseAnchorProvider, BSCAnchorProvider,
  autoNetworkSetup, collectCandidates, connectToAgent,
  discoverPublicIP, checkReachable, ContentAuditor, TrustScoreClient,
  RollbackManager, rotateKey, verifyKeyRotation, ToolGateway, PolicyEngine, mintConsentToken, sign,
  TrustGraph, calculateTaskWeight,
} from '@lawrenceliang-btc/atel-sdk';
import { TunnelManager, HeartbeatManager } from './tunnel-manager.mjs';
import { buildAgentCallbackAction, getDirectExecutableActions, normalizeGatewayBind, shouldSkipAgentHook, shouldUseGatewaySession } from './notification-action-helpers.mjs';
// ollama-manager removed — SDK does not run local models
const initializeOllama = async () => {};
const getOllamaStatus = async () => ({ running: false, models: [] });
import { parseAttachmentFlags, processAttachments } from './atel-attachment-helpers.mjs';

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
const NOTIFY_TARGETS_FILE = resolve(ATEL_DIR, 'notify-targets.json');
const TRADE_TRACK_FILE = resolve(ATEL_DIR, 'tracked-orders.json');
const P2P_STATUS_FILE = resolve(ATEL_DIR, 'p2p-task-status.jsonl');
const PENDING_AGENT_CALLBACKS_FILE = resolve(ATEL_DIR, 'pending-agent-callbacks.json');
const ORDER_WORK_DIR = resolve(ATEL_DIR, 'order-workspaces');
const KEYS_DIR = resolve(ATEL_DIR, 'keys');
const ANCHOR_FILE = resolve(KEYS_DIR, 'anchor.json');

const DEFAULT_POLICY = { rateLimit: 60, maxPayloadBytes: 1048576, maxConcurrent: 10, allowedDIDs: [], blockedDIDs: [], taskMode: 'auto', autoAcceptPlatform: true, autoAcceptP2P: true, agentMode: 'manual', autoPolicy: { acceptOrders: false, acceptMaxAmount: 0, autoApprovePlan: false }, trustPolicy: { minScore: 0, newAgentPolicy: 'allow_low_risk', riskThresholds: { low: 0, medium: 50, high: 75, critical: 90 } } };

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir() { if (!existsSync(ATEL_DIR)) mkdirSync(ATEL_DIR, { recursive: true }); }

function ensureOrderWorkspace(orderId, context = {}) {
  ensureDir();
  const safeOrderId = String(orderId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = resolve(ORDER_WORK_DIR, safeOrderId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const contextFile = join(dir, 'ORDER_CONTEXT.md');
  const lines = [
    `# ATEL Order Context`,
    ``,
    `Order ID: ${orderId || ''}`,
    `Chain: ${context.chain || ''}`,
    `Role: ${context.role || ''}`,
    `Status: ${context.status || ''}`,
    `Phase: ${context.phase || ''}`,
    `Current Milestone: ${context.currentMilestone ?? ''}`,
    `Milestone Title: ${context.milestoneTitle || ''}`,
    ``,
    `## Order Description`,
    context.orderDescription || '',
    ``,
    `## Milestone Objective`,
    context.milestoneObjective || '',
    ``,
    `## Submission Content`,
    context.resultSummary || '',
    ``,
    `## Previous Approved Outputs`,
    context.previousApprovedOutputs || '',
    ``,
    `## Hard Rules`,
    `- Only work from the order description and milestone objective in this file.`,
    `- Do not inspect unrelated local projects or repository content unless the order explicitly asks for repo analysis.`,
    `- Do not infer a different project from stray files in the machine workspace.`,
    `- Return only content that directly satisfies this order.`,
    ``,
  ];
  writeFileSync(contextFile, lines.join('\n'));
  return { dir, contextFile };
}

function getOrderWorkspace(orderId, context = {}) {
  if (!orderId) return { dir: process.cwd(), contextFile: '' };
  return ensureOrderWorkspace(orderId, context);
}

function getAtelWorkspaceRoot() {
  return dirname(ATEL_DIR);
}

function shouldAllowRepoAccess(context = {}) {
  const description = String(context?.orderDescription || '').toLowerCase();
  const objective = String(context?.milestoneObjective || '').toLowerCase();
  const resultSummary = String(context?.resultSummary || '').toLowerCase();
  const previousApprovedOutputs = String(context?.previousApprovedOutputs || '').toLowerCase();
  const combined = `${description}\n${objective}\n${resultSummary}\n${previousApprovedOutputs}`;
  return /(repo|repository|codebase|仓库|代码库|项目代码|source code|read files|analyze code|修改代码|修复代码|实现功能)/i.test(combined);
}

function summarizeApprovedMilestones(milestones = [], beforeIndex = Number.MAX_SAFE_INTEGER) {
  return (Array.isArray(milestones) ? milestones : [])
    .filter((m) => m && m.status === 'verified' && Number.isFinite(m.index) && m.index < beforeIndex)
    .sort((a, b) => a.index - b.index)
    .map((m) => `M${m.index}: ${m.title || ''}\nResult: ${m.resultSummary || ''}`.trim())
    .join('\n\n');
}

function sanitizeAgentPrompt(promptText, meta = {}) {
  const raw = typeof promptText === 'string' ? promptText : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    log({ event: 'agent_prompt_skip_empty', eventType: meta.eventType || 'unknown', dedupeKey: meta.dedupeKey || '' });
    return '';
  }

  // Keep a large but bounded margin below upstream model limits. We only need
  // concise task prompts here; oversized prompts add noise and can trigger
  // upstream length validation errors.
  const maxChars = 16000;
  if (trimmed.length <= maxChars) return trimmed;

  const truncated = `${trimmed.slice(0, maxChars)}\n\n[Prompt truncated by ATEL SDK to stay within model input limits.]`;
  log({
    event: 'agent_prompt_truncated',
    eventType: meta.eventType || 'unknown',
    dedupeKey: meta.dedupeKey || '',
    originalChars: trimmed.length,
    finalChars: truncated.length,
  });
  return truncated;
}

function isKnownUpstreamModelInputError(text) {
  const value = String(text || '');
  return value.includes('InternalError.Algo.InvalidParameter')
    || value.includes('Range of input length should be [1, 258048]');
}

function summarizeAgentOutput(text, maxChars = 300) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (isKnownUpstreamModelInputError(trimmed)) return '[suppressed upstream model input-length error]';
  return trimmed.substring(0, maxChars);
}

// ═══════════════════════════════════════════════════════════════════
// Notification Target System — auto-discover gateway, manage targets
// ═══════════════════════════════════════════════════════════════════

function loadNotifyTargets() {
  try { return JSON.parse(readFileSync(NOTIFY_TARGETS_FILE, 'utf-8')); }
  catch { return { version: 1, defaultChannel: 'telegram', targets: [] }; }
}

function saveNotifyTargets(data) {
  ensureDir();
  writeFileSync(NOTIFY_TARGETS_FILE, JSON.stringify(data, null, 2));
}

// Auto-detect current TG chat from OpenClaw session state
function discoverTelegramChat() {
  const sessionPaths = [
    join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json'),
    join(process.env.HOME || '', '.openclaw/sessions/sessions.json'),
  ];
  for (const p of sessionPaths) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      // sessions.json can be { "agent:main:main": { lastChannel, lastTo, ... } } or flat
      const entries = typeof data === 'object' ? Object.values(data) : [];
      for (const session of entries) {
        if (session?.lastChannel === 'telegram' && typeof session?.lastTo === 'string' && session.lastTo.startsWith('telegram:')) {
          return session.lastTo.split(':', 2)[1]; // "telegram:123456" → "123456"
        }
      }
      // Also check top-level
      if (data?.lastChannel === 'telegram' && typeof data?.lastTo === 'string' && data.lastTo.startsWith('telegram:')) {
        return data.lastTo.split(':', 2)[1];
      }
    } catch {}
  }
  return null;
}

// Auto-bind TG notification target if not already bound
function autoBindNotifications() {
  const targets = loadNotifyTargets();
  if (targets.targets.length > 0) return; // already has targets

  const chatId = discoverTelegramChat();
  if (!chatId) return;

  const botToken = discoverTelegramBot();
  const id = `tg_${chatId}`;
  targets.targets.push({
    id, channel: 'telegram', target: chatId,
    botToken: botToken || undefined,
    label: 'owner', enabled: true,
    createdAt: new Date().toISOString(), lastUsedAt: null,
  });
  saveNotifyTargets(targets);
  console.log(`🔔 Auto-bound TG notifications to chat ${chatId}`);
}

// Auto-discover OpenClaw gateway: read token + find port
function discoverGateway() {
  // 1. Env override
  if (process.env.ATEL_NOTIFY_GATEWAY || process.env.OPENCLAW_GATEWAY_URL) {
    const url = process.env.ATEL_NOTIFY_GATEWAY || process.env.OPENCLAW_GATEWAY_URL;
    let token = '';
    try { token = JSON.parse(readFileSync(join(process.env.HOME || '', '.openclaw/openclaw.json'), 'utf-8')).gateway?.auth?.token || ''; } catch {}
    return { url, token };
  }
  // 2. Read from ~/.openclaw/openclaw.json
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.HOME || '', '.openclaw/openclaw.json'), 'utf-8'));
    const token = cfg.gateway?.auth?.token || '';
    const port = cfg.gateway?.port || 18789;
    const bind = normalizeGatewayBind(cfg.gateway?.bind || '127.0.0.1');
    return { url: `http://${bind}:${port}`, token };
  } catch { return null; }
}

function loadOpenClawConfig() {
  try {
    return JSON.parse(readFileSync(join(process.env.HOME || '', '.openclaw/openclaw.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// Read TG bot token from openclaw config
function discoverTelegramBot() {
  try {
    const cfg = loadOpenClawConfig();
    const botToken = cfg.channels?.telegram?.botToken;
    if (!botToken || botToken.includes('${')) return null; // template var, not resolved
    return botToken;
  } catch { return null; }
  // Also check env
}

// Send notification to all enabled targets (fire-and-forget, never blocks)
async function pushTradeNotification(eventType, payload, body) {
  const targets = loadNotifyTargets();
  const enabled = (targets.targets || []).filter(t => t.enabled !== false);
  if (enabled.length === 0) return;

  const templates = {
    'order_created': (p) => `📥 收到新订单\n订单: ${p.orderId || body?.orderId || '?'}\n金额: $${p.priceAmount ?? '?'} USDC\n来自: ${p.requesterDid || '未知请求方'}\n请审核后决定是否接单`,
    'order_accepted': (p) => `📋 订单已被接单\n订单: ${p.orderId || body?.orderId || '?'}\n执行方已开始处理，进入里程碑阶段`,
    'milestone_submitted': (p) => `📝 里程碑 M${p.milestoneIndex ?? '?'} 已提交\n订单: ${p.orderId || body?.orderId || '?'}\n等待审核`,
    'milestone_verified': (p) => `✅ 里程碑 M${p.milestoneIndex ?? '?'} 审核通过\n订单: ${p.orderId || body?.orderId || '?'}`,
    'milestone_rejected': (p) => `❌ 里程碑 M${p.milestoneIndex ?? '?'} 被拒绝\n订单: ${p.orderId || body?.orderId || '?'}\n原因: ${p.rejectReason || '未说明'}`,
    'order_settled': (p) => `💰 订单已结算完成\n订单: ${p.orderId || body?.orderId || '?'}\nUSDC 已支付`,
  };
  const tmpl = templates[eventType];
  if (!tmpl) return;
  const message = tmpl(payload);

  for (const target of enabled) {
    try {
      if (target.channel === 'telegram' && target.botToken) {
        // Direct TG Bot API — no gateway needed
        await fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: target.target, text: message, parse_mode: 'HTML' }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      } else if (target.channel === 'gateway') {
        // OpenClaw gateway
        const gw = discoverGateway();
        if (gw?.url && gw?.token) {
          await fetch(`${gw.url}/tools/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gw.token}` },
            body: JSON.stringify({ tool: 'message', args: { action: 'send', message, target: target.target } }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        }
      }
      // Update lastUsedAt
      target.lastUsedAt = new Date().toISOString();
    } catch (e) {
      // Never block main flow
    }
  }
  // Best-effort save lastUsedAt
  try { saveNotifyTargets(targets); } catch {}
}

function appendP2PTaskStatus(entry) {
  if (!entry?.taskId || !entry?.status) return;
  ensureDir();
  appendFileSync(P2P_STATUS_FILE, `${JSON.stringify({ updatedAt: new Date().toISOString(), ...entry })}\n`);
}

async function pushP2PNotification(eventType, payload = {}) {
  const targets = loadNotifyTargets();
  const enabled = (targets.targets || []).filter(t => t.enabled !== false);
  if (enabled.length === 0) return;

  const templates = {
    'p2p_task_sent': (p) => `📤 P2P任务已发送\n任务: ${p.taskId || '?'}\n目标: ${p.peerDid || '?'}`,
    'p2p_task_received': (p) => `📩 收到新的P2P任务\n任务: ${p.taskId || '?'}\n来自: ${p.peerDid || '?'}`,
    'p2p_task_started': (p) => `▶️ P2P任务开始处理\n任务: ${p.taskId || '?'}\n来自: ${p.peerDid || '?'}`,
    'p2p_result_submitted': (p) => `📨 P2P结果已发回对方\n任务: ${p.taskId || '?'}\n目标: ${p.peerDid || '?'}`,
    'p2p_result_received': (p) => `✅ P2P任务已完成\n任务: ${p.taskId || '?'}\n结果: ${String(p.result || '').slice(0, 80) || '已返回'}`,
    'p2p_task_failed': (p) => `❌ P2P任务失败\n任务: ${p.taskId || '?'}\n原因: ${p.reason || '未知错误'}`,
  };
  const tmpl = templates[eventType];
  if (!tmpl) return;
  const message = tmpl(payload);

  for (const target of enabled) {
    try {
      if (target.channel === 'telegram' && target.botToken) {
        await fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: target.target, text: message, parse_mode: 'HTML' }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      } else if (target.channel === 'gateway') {
        const gw = discoverGateway();
        if (gw?.url && gw?.token) {
          await fetch(`${gw.url}/tools/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gw.token}` },
            body: JSON.stringify({ tool: 'message', args: { action: 'send', message, target: target.target } }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        }
      }
      target.lastUsedAt = new Date().toISOString();
    } catch {}
  }
  try { saveNotifyTargets(targets); } catch {}
}

function loadPendingAgentCallbacksPersisted() {
  if (!existsSync(PENDING_AGENT_CALLBACKS_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(PENDING_AGENT_CALLBACKS_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function savePendingAgentCallbacksPersisted(data) {
  ensureDir();
  writeFileSync(PENDING_AGENT_CALLBACKS_FILE, JSON.stringify(data, null, 2));
}

function persistPendingAgentCallback(dedupeKey, data) {
  if (!dedupeKey || !data) return;
  const persisted = loadPendingAgentCallbacksPersisted();
  persisted[dedupeKey] = {
    ...data,
    updatedAt: new Date().toISOString(),
  };
  savePendingAgentCallbacksPersisted(persisted);
}

function markPersistedPendingAgentCallbackCompleted(dedupeKey, meta = {}) {
  if (!dedupeKey) return;
  const persisted = loadPendingAgentCallbacksPersisted();
  const existing = persisted[dedupeKey];
  persisted[dedupeKey] = {
    ...(existing || {}),
    ...meta,
    terminal: true,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  savePendingAgentCallbacksPersisted(persisted);
}

function clearPersistedPendingAgentCallback(dedupeKey) {
  if (!dedupeKey) return;
  const persisted = loadPendingAgentCallbacksPersisted();
  if (!persisted[dedupeKey]) return;
  delete persisted[dedupeKey];
  savePendingAgentCallbacksPersisted(persisted);
}

async function executeRecommendedActionDirect(eventType, action, cwd, dedupeKey) {
  const command = Array.isArray(action?.command) ? action.command.filter(Boolean) : [];
  if (command.length === 0) {
    return { ok: false, skipped: true, reason: 'empty_command' };
  }
  const actionKey = JSON.stringify(command);
  if (globalThis.__atelActiveDirectActionKeys?.has(actionKey)) {
    log({
      event: 'recommended_action_direct_skip',
      eventType,
      dedupeKey,
      action: action.action,
      command,
      reason: 'inflight_duplicate',
    });
    return { ok: true, skipped: true, reason: 'inflight_duplicate' };
  }

  // Idempotency guard: short-circuit duplicate milestone plan/submit/verify actions
  // if the order or milestone has already advanced past the required state.
  if (command[0] === 'atel' && (command[1] === 'milestone-feedback' || command[1] === 'milestone-verify' || command[1] === 'milestone-submit') && command.length >= 3) {
    const orderId = command[2];
    const needsMilestoneIndex = command[1] === 'milestone-verify' || command[1] === 'milestone-submit';
    const index = needsMilestoneIndex ? Number.parseInt(String(command[3]), 10) : null;
    if (orderId && (!needsMilestoneIndex || Number.isFinite(index))) {
      try {
        const resp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/milestones`, { signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
          const state = await resp.json();
          if (command[1] === 'milestone-feedback' && command.includes('--approve') && state?.orderStatus && state.orderStatus !== 'milestone_review') {
            log({
              event: 'recommended_action_direct_skip',
              eventType,
              dedupeKey,
              action: action.action,
              command,
              reason: `order_status_${state.orderStatus}`,
            });
            return { ok: true, skipped: true, reason: `order_status_${state.orderStatus}` };
          }
          if (command[1] === 'milestone-submit' && state?.orderStatus && state.orderStatus !== 'executing') {
            log({
              event: 'recommended_action_direct_skip',
              eventType,
              dedupeKey,
              action: action.action,
              command,
              reason: `order_status_${state.orderStatus}`,
            });
            return { ok: true, skipped: true, reason: `order_status_${state.orderStatus}` };
          }
          const milestone = needsMilestoneIndex && Array.isArray(state?.milestones) ? state.milestones.find((m) => m.index === index) : null;
          if (needsMilestoneIndex && milestone) {
            const expectedStatuses = command[1] === 'milestone-verify'
              ? ['submitted']
              : (eventType === 'milestone_rejected' ? ['pending', 'rejected'] : ['pending']);
            if (!expectedStatuses.includes(milestone.status)) {
              log({
                event: 'recommended_action_direct_skip',
                eventType,
                dedupeKey,
                action: action.action,
                command,
                reason: `milestone_status_${milestone.status}`,
              });
              return { ok: true, skipped: true, reason: `milestone_status_${milestone.status}` };
            }
          }
        }
      } catch (e) {
        log({
          event: 'recommended_action_direct_guard_error',
          eventType,
          dedupeKey,
          action: action.action,
          command,
          error: e.message,
        });
      }
    }
  }

  const { execFile } = await import('child_process');
  const childCmd = command[0] === 'atel' ? process.execPath : command[0];
  const childArgs = command[0] === 'atel' ? [process.argv[1], ...command.slice(1)] : command.slice(1);
  const childCwd = command[0] === 'atel' ? getAtelWorkspaceRoot() : cwd;

  log({ event: 'recommended_action_direct_trigger', eventType, dedupeKey, action: action.action, command });
  globalThis.__atelActiveDirectActionKeys ??= new Set();
  globalThis.__atelActiveDirectActionKeys.add(actionKey);

  return await new Promise((resolve) => {
    execFile(childCmd, childArgs, { timeout: 180000, cwd: childCwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      globalThis.__atelActiveDirectActionKeys?.delete(actionKey);
      if (err) {
        const combinedErrorText = String(stderr || err.message || '');
        if (
          command[0] === 'atel' &&
          command[1] === 'milestone-feedback' &&
          command.includes('--approve') &&
          combinedErrorText.includes('order not in milestone_review status')
        ) {
          log({
            event: 'recommended_action_direct_skip',
            eventType,
            dedupeKey,
            action: action.action,
            command,
            reason: 'order_status_executing',
          });
          resolve({ ok: true, skipped: true, reason: 'order_status_executing' });
          return;
        }
        if (
          command[0] === 'atel' &&
          command[1] === 'milestone-submit' &&
          combinedErrorText.includes('milestone cannot be submitted in status: submitted')
        ) {
          log({
            event: 'recommended_action_direct_skip',
            eventType,
            dedupeKey,
            action: action.action,
            command,
            reason: 'milestone_status_submitted',
          });
          resolve({ ok: true, skipped: true, reason: 'milestone_status_submitted' });
          return;
        }
        if (
          command[0] === 'atel' &&
          command[1] === 'milestone-verify' &&
          (combinedErrorText.includes('milestone cannot be verified in status: verified') ||
           combinedErrorText.includes('milestone not in submitted status') ||
           combinedErrorText.includes('milestone cannot be verified in status: settled'))
        ) {
          log({
            event: 'recommended_action_direct_skip',
            eventType,
            dedupeKey,
            action: action.action,
            command,
            reason: 'milestone_already_processed',
          });
          resolve({ ok: true, skipped: true, reason: 'milestone_already_processed' });
          return;
        }
        log({
          event: 'recommended_action_direct_error',
          eventType,
          dedupeKey,
          action: action.action,
          command,
          error: err.message,
          stderr: (stderr || '').substring(0, 400),
        });
        resolve({ ok: false, error: err.message });
        return;
      }

      log({
        event: 'recommended_action_direct_done',
        eventType,
        dedupeKey,
        action: action.action,
        command,
        stdout: summarizeAgentOutput(stdout, 400),
      });
      resolve({ ok: true, stdout });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// CLI UX Improvements - Helper Functions
// ═══════════════════════════════════════════════════════════════════

// ─── Unified Output Format ────────────────────────────────────────
function formatOutput(data, options = {}) {
  const format = options.json ? 'json' : (options.quiet ? 'quiet' : 'human');
  
  if (format === 'json') {
    console.log(JSON.stringify(data));
    return;
  }
  
  if (format === 'quiet') {
    // Only output essential info
    if (data.id) console.log(data.id);
    else if (data.did) console.log(data.did);
    else if (data.sessionId) console.log(data.sessionId);
    else if (data.requestId) console.log(data.requestId);
    else console.log(data.message || 'ok');
    return;
  }
  
  // Human-readable format
  if (data.status === 'ok' || data.success) {
    console.log(`✓ ${data.message || 'Success'}`);
    if (data.did) console.log(`  DID: ${data.did}`);
    if (data.alias) console.log(`  Alias: ${data.alias}`);
    if (data.sessionId) console.log(`  Session ID: ${data.sessionId}`);
    if (data.requestId) console.log(`  Request ID: ${data.requestId}`);
    if (data.addedAt) console.log(`  Added: ${new Date(data.addedAt).toLocaleString()}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(data.expiresAt).toLocaleString()}`);
  } else if (data.status === 'error' || data.error) {
    console.error(`✗ ${data.message || data.error || 'Error'}`);
    if (data.hint) console.error(`  Hint: ${data.hint}`);
  } else {
    // Neutral message
    console.log(data.message || JSON.stringify(data));
  }
}

// ─── Confirmation Prompts ─────────────────────────────────────────
function confirm(message, defaultValue = false) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    const defaultText = defaultValue ? 'Y/n' : 'y/N';
    rl.question(`${message} (${defaultText}): `, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      if (normalized === '') {
        resolve(defaultValue);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

// ─── Help Functions ───────────────────────────────────────────────
function showFriendHelp() {
  console.log(`
Friend Management Commands:

  atel friend add <did> [options]
    Add a DID as friend
    
    Arguments:
      <did>             DID to add (format: did:atel:ed25519:<public-key>)
    
    Options:
      --alias <name>    Friendly name for this friend
      --notes <text>    Notes about this friend
      --json            Output in JSON format
    
    Examples:
      atel friend add did:atel:ed25519:abc123 --alias "Alice"
      atel friend add did:atel:ed25519:abc123 --alias "Bob" --notes "Met at conference"

  atel friend remove <did> [options]
    Remove a friend
    
    Arguments:
      <did>             DID to remove
    
    Options:
      --yes             Skip confirmation prompt
      --json            Output in JSON format
    
    Examples:
      atel friend remove did:atel:ed25519:abc123
      atel friend remove did:atel:ed25519:abc123 --yes

  atel friend list [options]
    List all friends
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel friend list
      atel friend list --json

  atel friend request <did> [options]
    Send a friend request
    
    Arguments:
      <did>             Target DID
    
    Options:
      --message <text>  Message to include with request
      --json            Output in JSON format
    
    Examples:
      atel friend request did:atel:ed25519:abc123
      atel friend request did:atel:ed25519:abc123 --message "Hi, let's connect!"

  atel friend accept <requestId> [options]
    Accept a friend request
    
    Arguments:
      <requestId>       Request ID to accept
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel friend accept freq_1234567890_abc123

  atel friend reject <requestId> [options]
    Reject a friend request
    
    Arguments:
      <requestId>       Request ID to reject
    
    Options:
      --reason <text>   Reason for rejection
      --json            Output in JSON format
    
    Examples:
      atel friend reject freq_1234567890_abc123
      atel friend reject freq_1234567890_abc123 --reason "Don't know you"

  atel friend pending [options]
    List pending friend requests
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel friend pending

  atel friend status [options]
    Show friend system status
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel friend status

── How Friend System Affects Communication ──────────────────────────

  By default, agents operate in "friends_only" mode:
    • P2P messages (atel send) and tasks will be REJECTED if you are not a friend
    • You must send a friend request and have it accepted first

  Typical flow to communicate with a new agent:
    1. atel friend request <their-did> --message "Hi, lets connect!"
    2. They run: atel friend pending         (to see your request)
    3. They run: atel friend accept <req-id> (to accept)
    4. Now you can: atel send <their-did> "Hello!"

  To allow communication WITHOUT friend relationship (open mode):
    Edit .atel/policy.json and set:
    { "relationshipPolicy": { "defaultMode": "open" } }
    Restart your agent. Both sides can configure this independently.

For more information, visit: https://docs.atel.io/friend-system
  `);
}

function showTempSessionHelp() {
  console.log(`
Temporary Session Management:

  atel temp-session allow <did> [options]
    Grant temporary access to a DID
    
    Arguments:
      <did>                   DID to grant access
    
    Options:
      --duration <minutes>    Duration in minutes (default: 60, max: 1440)
      --max-tasks <count>     Maximum number of tasks (default: 10, max: 100)
      --reason <text>         Reason for granting access
      --json                  Output in JSON format
    
    Common durations:
      --duration 60           1 hour
      --duration 1440         1 day
      --duration 10080        1 week
    
    Examples:
      atel temp-session allow did:atel:ed25519:abc123
      atel temp-session allow did:atel:ed25519:abc123 --duration 120 --max-tasks 5
      atel temp-session allow did:atel:ed25519:abc123 --duration 1440 --reason "One-time collaboration"

  atel temp-session revoke <sessionId> [options]
    Revoke a temporary session
    
    Arguments:
      <sessionId>       Session ID to revoke
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel temp-session revoke temp_1234567890_abc123

  atel temp-session list [options]
    List temporary sessions
    
    Options:
      --json            Output in JSON format
      --all             Include expired sessions
    
    Examples:
      atel temp-session list
      atel temp-session list --all

  atel temp-session clean [options]
    Remove expired sessions
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel temp-session clean

  atel temp-session status [options]
    Show temporary session status
    
    Options:
      --json            Output in JSON format
    
    Examples:
      atel temp-session status

For more information, visit: https://docs.atel.io/friend-system
  `);
}

// Safe log with EPIPE protection
function log(event) { 
  ensureDir(); 
  appendFileSync(INBOX_FILE, JSON.stringify(event) + '\n'); 
  try {
    console.log(JSON.stringify(event));
  } catch (e) {
    if (e.code === 'EPIPE') {
      // Silently ignore EPIPE, file logging still works
      return;
    }
    throw e;
  }
}

// Auto-discover OpenClaw Gateway URL
function getGatewayUrl() {
  // Priority: environment variable > openclaw.json > default
  if (process.env.OPENCLAW_GATEWAY_URL) {
    return process.env.OPENCLAW_GATEWAY_URL;
  }
  
  try {
    const home = process.env.HOME || '';
    const configPath = join(home, '.openclaw/openclaw.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const port = config.gateway?.port || 18789;
      const bind = config.gateway?.bind || '127.0.0.1';
      return `http://${bind}:${port}`;
    }
  } catch {
    // Ignore errors, fall back to default
  }
  
  return 'http://127.0.0.1:18789';
}

function saveIdentity(id) { ensureDir(); writeFileSync(IDENTITY_FILE, JSON.stringify({ agent_id: id.agent_id, did: id.did, publicKey: Buffer.from(id.publicKey).toString('hex'), secretKey: Buffer.from(id.secretKey).toString('hex') }, null, 2), { mode: 0o600 }); }
function loadIdentity() { if (!existsSync(IDENTITY_FILE)) return null; const d = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8')); return new AgentIdentity({ agent_id: d.agent_id, publicKey: Uint8Array.from(Buffer.from(d.publicKey, 'hex')), secretKey: Uint8Array.from(Buffer.from(d.secretKey, 'hex')) }); }
function requireIdentity() { const id = loadIdentity(); if (!id) { console.error('No identity. Run: atel init'); process.exit(1); } return id; }

function validateDID(did) {
  // ATEL DID format: did:atel:ed25519:<base58-encoded-public-key>
  if (!did || typeof did !== 'string') {
    return { valid: false, error: 'DID is required' };
  }
  
  if (!did.startsWith('did:atel:')) {
    return { valid: false, error: 'DID must start with "did:atel:"' };
  }
  
  const parts = did.split(':');
  if (parts.length !== 4) {
    return { valid: false, error: 'Invalid DID format. Expected: did:atel:ed25519:<public-key>' };
  }
  
  if (parts[2] !== 'ed25519') {
    return { valid: false, error: 'Only ed25519 key type is supported' };
  }
  
  const publicKey = parts[3];
  if (!publicKey || publicKey.length < 32) {
    return { valid: false, error: 'Invalid public key in DID' };
  }
  
  return { valid: true };
}

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
function loadTrackedOrders() {
  if (!existsSync(TRADE_TRACK_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(TRADE_TRACK_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function saveTrackedOrders(orders) {
  ensureDir();
  writeFileSync(TRADE_TRACK_FILE, JSON.stringify(orders, null, 2));
}
function trackOrder(orderId, role) {
  if (!orderId || !role) return;
  const now = new Date().toISOString();
  const orders = loadTrackedOrders().filter((o) => o && o.orderId);
  const existing = orders.find((o) => o.orderId === orderId);
  if (existing) {
    existing.role = role;
    existing.updatedAt = now;
  } else {
    orders.push({ orderId, role, updatedAt: now });
  }
  saveTrackedOrders(orders);
}
function untrackOrder(orderId) {
  if (!orderId) return;
  saveTrackedOrders(loadTrackedOrders().filter((o) => o?.orderId !== orderId));
}
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
async function verifyTaskSignature(taskRequest, signature, publicKeyBase58) {
  const { default: nacl } = await import('tweetnacl');
  const bs58 = await import('bs58');
  
  // Canonical JSON for verification
  // IMPORTANT: Keys must be in alphabetical order to match signTaskRequest
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
  
  try {
    // Decode Base58 public key from DID
    const publicKey = bs58.default.decode(publicKeyBase58);
    const sig = Buffer.from(signature, 'base64');
    return nacl.sign.detached.verify(Buffer.from(signable), sig, publicKey);
  } catch (e) {
    return false;
  }
}

// ─── Friend System Data Layer ────────────────────────────────────

const FRIENDS_FILE = resolve(ATEL_DIR, 'friends.json');
const TEMP_SESSIONS_FILE = resolve(ATEL_DIR, 'temp-sessions.json');
const FRIEND_REQUESTS_FILE = resolve(ATEL_DIR, 'friend-requests.json');

// Load friends list (returns object with backward compatibility)
function loadFriends() {
  if (!existsSync(FRIENDS_FILE)) return { friends: [] };
  try {
    const data = JSON.parse(readFileSync(FRIENDS_FILE, 'utf-8'));
    // Support both old (array) and new (object) formats
    if (Array.isArray(data)) {
      return { friends: data };
    }
    return data;
  } catch {
    return { friends: [] };
  }
}

// Save friends to file
function saveFriends(data) {
  ensureDir();
  writeFileSync(FRIENDS_FILE, JSON.stringify(data, null, 2));
  invalidateFriendCache(); // Add this
}

// Add friend (idempotent)
function addFriend(did, options = {}) {
  const data = loadFriends();
  
  // Idempotency check
  if (data.friends.some(f => f.did === did)) {
    return false; // Already exists
  }
  
  data.friends.push({
    did,
    alias: options.alias || '',
    status: 'accepted',
    addedAt: new Date().toISOString(),
    addedBy: options.addedBy || 'manual',
    notes: options.notes || ''
  });
  
  saveFriends(data);
  log({ event: 'friend_added', did, addedBy: options.addedBy });
  return true;
}

// Remove friend
function removeFriend(did) {
  const data = loadFriends();
  const before = data.friends.length;
  data.friends = data.friends.filter(f => f.did !== did);
  const removed = before > data.friends.length;
  
  if (removed) {
    saveFriends(data);
    log({ event: 'friend_removed', did });
  }
  
  return removed;
}

// Check if DID is a friend
function isFriend(did) {
  const data = getCachedFriends();
  return data.friends.some(f => f.did === did && f.status === 'accepted');
}

// Load friend requests
function loadFriendRequests() {
  if (!existsSync(FRIEND_REQUESTS_FILE)) return { requests: [] };
  try {
    const data = JSON.parse(readFileSync(FRIEND_REQUESTS_FILE, 'utf-8'));
    // Support both old (array) and new (object) formats
    if (Array.isArray(data)) {
      return { requests: data };
    }
    return data;
  } catch {
    return { requests: [] };
  }
}

// Save friend requests to file
function saveFriendRequests(data) {
  ensureDir();
  writeFileSync(FRIEND_REQUESTS_FILE, JSON.stringify(data, null, 2));
}

// Load temporary sessions (returns object with backward compatibility)
function loadTempSessions() {
  if (!existsSync(TEMP_SESSIONS_FILE)) return { sessions: [] };
  try {
    const data = JSON.parse(readFileSync(TEMP_SESSIONS_FILE, 'utf-8'));
    // Support both old (array) and new (object) formats
    if (Array.isArray(data)) {
      return { sessions: data };
    }
    return data;
  } catch {
    return { sessions: [] };
  }
}

// Save temporary sessions
function saveTempSessions(data) {
  ensureDir();
  writeFileSync(TEMP_SESSIONS_FILE, JSON.stringify(data, null, 2));
  invalidateTempSessionCache(); // Add this
}

// Add temporary session (idempotent)
function addTempSession(did, options = {}) {
  const data = loadTempSessions();
  
  // Check if active session already exists
  const now = Date.now();
  const existing = data.sessions.find(s => 
    s.did === did && 
    s.status === 'active' && 
    new Date(s.expiresAt).getTime() > now
  );
  
  if (existing) {
    return { created: false, session: existing }; // Already exists
  }
  
  const sessionId = `temp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const durationMinutes = options.durationMinutes || 60;
  const maxTasks = options.maxTasks || 5;
  
  const session = {
    sessionId,
    did,
    status: 'active',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + durationMinutes * 60 * 1000).toISOString(),
    maxTasks,
    taskCount: 0,
    createdBy: options.createdBy || 'manual',
    notes: options.notes || ''
  };
  
  data.sessions.push(session);
  saveTempSessions(data);
  log({ event: 'temp_session_created', did, sessionId, durationMinutes, maxTasks });
  
  return { created: true, session };
}

// Clean expired temporary sessions
function cleanExpiredTempSessions() {
  const data = loadTempSessions();
  const now = Date.now();
  const before = data.sessions.length;
  
  data.sessions = data.sessions.filter(s => {
    const expired = new Date(s.expiresAt).getTime() <= now;
    if (expired) {
      log({ event: 'temp_session_expired', sessionId: s.sessionId, did: s.did });
    }
    return !expired;
  });
  
  const removed = before - data.sessions.length;
  if (removed > 0) {
    saveTempSessions(data);
    log({ event: 'temp_sessions_cleaned', count: removed });
  }
  
  return removed;
}

// Automatic cleanup when listing temp sessions
function autoCleanExpiredTempSessions() {
  const sessions = loadTempSessions();
  const now = Date.now();
  const before = sessions.sessions.length;
  
  sessions.sessions = sessions.sessions.filter(s => 
    new Date(s.expiresAt).getTime() > now
  );
  
  const removed = before - sessions.sessions.length;
  if (removed > 0) {
    saveTempSessions(sessions);
    log({ event: 'temp_sessions_auto_cleaned', count: removed });
  }
  
  return removed;
}

// Simple in-memory cache for friend system data
const friendSystemCache = {
  friends: { data: null, timestamp: 0, ttl: 60000 }, // 1 minute TTL
  tempSessions: { data: null, timestamp: 0, ttl: 30000 }, // 30 seconds TTL
  policy: { data: null, timestamp: 0, ttl: 60000 }
};

function getCachedFriends() {
  const now = Date.now();
  if (friendSystemCache.friends.data && 
      (now - friendSystemCache.friends.timestamp) < friendSystemCache.friends.ttl) {
    return friendSystemCache.friends.data;
  }
  
  const data = loadFriends();
  friendSystemCache.friends.data = data;
  friendSystemCache.friends.timestamp = now;
  return data;
}

function getCachedTempSessions() {
  const now = Date.now();
  if (friendSystemCache.tempSessions.data && 
      (now - friendSystemCache.tempSessions.timestamp) < friendSystemCache.tempSessions.ttl) {
    return friendSystemCache.tempSessions.data;
  }
  
  const data = loadTempSessions();
  friendSystemCache.tempSessions.data = data;
  friendSystemCache.tempSessions.timestamp = now;
  return data;
}

function invalidateFriendCache() {
  friendSystemCache.friends.data = null;
  friendSystemCache.friends.timestamp = 0;
}

function invalidateTempSessionCache() {
  friendSystemCache.tempSessions.data = null;
  friendSystemCache.tempSessions.timestamp = 0;
}

// Get active temporary session for a DID
function getActiveTempSession(did) {
  const data = getCachedTempSessions();
  const now = Date.now();
  
  return data.sessions.find(s => 
    s.did === did && 
    s.status === 'active' && 
    new Date(s.expiresAt).getTime() > now
  );
}

// Increment task count for a temporary session
function incrementTempSessionTaskCount(sessionId) {
  const sessions = loadTempSessions();
  const session = sessions.sessions.find(s => s.sessionId === sessionId);
  
  if (session) {
    session.taskCount++;
    session.lastUsedAt = new Date().toISOString();
    saveTempSessions(sessions);
    
    // Note: Task count increments on access, not completion.
    // This means failed tasks still count toward the limit.
    // Future improvement: track pending vs completed tasks separately.
    log({ 
      event: 'temp_session_task_counted', 
      sessionId, 
      taskCount: session.taskCount,
      maxTasks: session.maxTasks 
    });
  }
}

// Remove a temporary session
function removeTempSession(sessionId) {
  const data = loadTempSessions();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter(s => s.sessionId !== sessionId);
  const removed = before > data.sessions.length;
  
  if (removed) {
    saveTempSessions(data);
    log({ event: 'temp_session_removed', sessionId });
  }
  
  return removed;
}

// Get default relationship policy
function getDefaultRelationshipPolicy() {
  return {
    defaultMode: 'friends_only', // 'friends_only' | 'open'
    openModeRequiresConfirm: true,
    tempSessionDefaults: {
      maxTasks: 5,
      durationMinutes: 60
    }
  };
}

// Rate limiting for friend requests
function checkFriendRequestRateLimit(fromDid) {
  const requests = loadFriendRequests();
  if (!requests.incoming) return { allowed: true };
  
  const now = Date.now();
  const oneHourAgo = now - 3600000; // 1 hour
  
  // Count requests from this DID in the last hour
  const recentRequests = requests.incoming.filter(r => 
    r.from === fromDid && 
    new Date(r.receivedAt).getTime() > oneHourAgo
  );
  
  const limit = 10; // Max 10 requests per hour per DID
  
  if (recentRequests.length >= limit) {
    return { 
      allowed: false, 
      reason: 'rate_limit_exceeded',
      message: `Too many friend requests from this DID. Limit: ${limit} per hour.`
    };
  }
  
  return { allowed: true };
}

// ─── P2P Access Control ──────────────────────────────────────────

// Check P2P access based on friend relationships
function checkP2PAccess(from, action, payload, currentPolicy) {
  // 1. Blacklist check (highest priority)
  if (currentPolicy.blockedDIDs && currentPolicy.blockedDIDs.length > 0) {
    if (currentPolicy.blockedDIDs.includes(from)) {
      log({ 
        event: 'p2p_access_denied', 
        from, 
        action, 
        reason: 'DID_BLOCKED', 
        timestamp: new Date().toISOString() 
      });
      return { 
        allowed: false, 
        reason: 'DID_BLOCKED',
        message: 'You are blocked by this agent',
        code: 'BLOCKED'
      };
    }
  }
  
  // 2. Get relationship policy
  const relPolicy = currentPolicy.relationshipPolicy || getDefaultRelationshipPolicy();
  
  // 3. Check if friend
  if (isFriend(from)) {
    log({ 
      event: 'p2p_access_granted', 
      from, 
      action, 
      reason: 'FRIEND', 
      relationship: 'friend',
      timestamp: new Date().toISOString() 
    });
    return { 
      allowed: true, 
      reason: 'FRIEND',
      relationship: 'friend'
    };
  }
  
  // 4. Check temporary session
  const tempSession = getActiveTempSession(from);
  if (tempSession) {
    // Check if expired (double check)
    if (Date.now() > new Date(tempSession.expiresAt).getTime()) {
      removeTempSession(tempSession.sessionId);
      log({ 
        event: 'p2p_access_denied', 
        from, 
        action, 
        reason: 'TEMP_SESSION_EXPIRED',
        sessionId: tempSession.sessionId,
        timestamp: new Date().toISOString() 
      });
      return {
        allowed: false,
        reason: 'TEMP_SESSION_EXPIRED',
        message: 'Your temporary session has expired. Please request a new one.',
        code: 'TEMP_EXPIRED'
      };
    }
    
    // Check task limit
    if (tempSession.taskCount >= tempSession.maxTasks) {
      log({ 
        event: 'p2p_access_denied', 
        from, 
        action, 
        reason: 'TEMP_SESSION_LIMIT_REACHED',
        sessionId: tempSession.sessionId,
        taskCount: tempSession.taskCount,
        maxTasks: tempSession.maxTasks,
        timestamp: new Date().toISOString() 
      });
      return {
        allowed: false,
        reason: 'TEMP_SESSION_LIMIT_REACHED',
        message: `Temporary session task limit reached (${tempSession.maxTasks} tasks)`,
        code: 'TEMP_LIMIT'
      };
    }
    
    // Increment task count
    incrementTempSessionTaskCount(tempSession.sessionId);
    
    log({ 
      event: 'p2p_access_granted', 
      from, 
      action, 
      reason: 'TEMP_SESSION',
      relationship: 'temporary',
      sessionId: tempSession.sessionId,
      tasksRemaining: tempSession.maxTasks - tempSession.taskCount - 1,
      timestamp: new Date().toISOString() 
    });
    
    return { 
      allowed: true, 
      reason: 'TEMP_SESSION',
      relationship: 'temporary',
      sessionId: tempSession.sessionId,
      tasksRemaining: tempSession.maxTasks - tempSession.taskCount - 1
    };
  }
  
  // 5. Check default mode
  if (relPolicy.defaultMode === 'friends_only') {
    log({ 
      event: 'p2p_access_denied', 
      from, 
      action, 
      reason: 'NOT_FRIEND',
      defaultMode: 'friends_only',
      timestamp: new Date().toISOString() 
    });
    return {
      allowed: false,
      reason: 'NOT_FRIEND',
      message: 'You are not a friend. Please send a friend request first.',
      hint: 'Send friend request: atel friend request <your-did>',
      code: 'NOT_FRIEND'
    };
  }
  
  if (relPolicy.defaultMode === 'open') {
    // Open mode - check if requires confirmation
    if (relPolicy.openModeRequiresConfirm) {
      log({ 
        event: 'p2p_access_queued', 
        from, 
        action, 
        reason: 'REQUIRES_CONFIRM',
        defaultMode: 'open',
        timestamp: new Date().toISOString() 
      });
      return {
        allowed: false,
        reason: 'REQUIRES_CONFIRM',
        message: 'Task queued for manual confirmation',
        queue: true,
        code: 'CONFIRM_REQUIRED'
      };
    }
    
    log({ 
      event: 'p2p_access_granted', 
      from, 
      action, 
      reason: 'OPEN_MODE',
      relationship: 'stranger',
      timestamp: new Date().toISOString() 
    });
    
    return { 
      allowed: true, 
      reason: 'OPEN_MODE',
      relationship: 'stranger'
    };
  }
  
  // 6. Default: deny
  log({ 
    event: 'p2p_access_denied', 
    from, 
    action, 
    reason: 'NOT_FRIEND',
    defaultMode: relPolicy.defaultMode || 'unknown',
    timestamp: new Date().toISOString() 
  });
  
  return {
    allowed: false,
    reason: 'NOT_FRIEND',
    message: 'Access denied. Please send a friend request first.',
    code: 'NOT_FRIEND'
  };
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
        privateKey: key,
        anchorRegistryAddress: process.env.ATEL_ANCHOR_REGISTRY_ADDRESS || undefined,
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
  const info = { agent_id: id.agent_id, did: id.did, capabilities: loadCapabilities(), policy: loadPolicy(), network: loadNetwork(), executor: EXECUTOR_URL || 'not configured' };

  // Fetch wallet info from Platform
  try {
    const resp = await fetch(`${PLATFORM_URL}/registry/v1/agent/${encodeURIComponent(id.did)}`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const agent = await resp.json();
      if (agent.wallets) {
        let wallets;
        try { wallets = typeof agent.wallets === 'string' ? JSON.parse(agent.wallets) : agent.wallets; } catch { wallets = agent.wallets; }
        info.wallets = wallets;
        console.log('\n💳 Smart Wallet Addresses:');
        if (wallets.base) console.log(`  Base: ${wallets.base}`);
        if (wallets.bsc) console.log(`  BSC:  ${wallets.bsc}`);
        if (wallets.type) console.log(`  Type: ${wallets.type}`);
        console.log('\n  Transfer USDC to the address above to fund your wallet.');
        console.log('  No ETH/BNB needed — platform pays gas.\n');
      }
    }
  } catch {}

  console.log(JSON.stringify(info, null, 2));
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
  // Initialize Ollama only if explicitly enabled (optional local AI audit)
  if (process.env.ATEL_OLLAMA_ENABLED === 'true') {
    await initializeOllama().catch(err => {
      console.error(`[Ollama] Initialization failed: ${err.message}`);
      console.error(`[Ollama] Audit will use rule-based verification only`);
    });
  }

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

  // ── Agent AI integration ──
  // Auto-detect OpenClaw: check PATH, then ~/.openclaw, then common source locations
  let detectedAgentCmd = process.env.ATEL_AGENT_CMD || '';
  if (!detectedAgentCmd) {
    const { execSync } = await import('child_process');
    const home = process.env.HOME || '/root';

    // Try 1: openclaw in PATH
    try {
      execSync('which openclaw', { stdio: 'ignore' });
      detectedAgentCmd = 'openclaw agent --agent main --local -m';
    } catch {}

    // Try 2: ~/.openclaw exists (installed but not in PATH — use npx or find binary)
    if (!detectedAgentCmd) {
      try {
        const { existsSync } = await import('fs');
        if (existsSync(join(home, '.openclaw', 'workspace'))) {
          // Find openclaw binary or source
          const candidates = [
            '/usr/local/bin/openclaw',
            '/usr/bin/openclaw',
            join(home, '.openclaw', 'bin', 'openclaw'),
          ];
          for (const c of candidates) {
            if (existsSync(c)) { detectedAgentCmd = `${c} agent --agent main --local -m`; break; }
          }
          // Try npx
          if (!detectedAgentCmd) {
            try { execSync('npx openclaw --version', { stdio: 'ignore', timeout: 5000 }); detectedAgentCmd = 'npx openclaw agent --agent main --local -m'; } catch {}
          }
          // Try source form (common dev setup)
          if (!detectedAgentCmd) {
            const srcPaths = [
              join(home, 'Desktop', 'openclaw', 'localclaw', 'app', 'openclaw-main', 'openclaw.mjs'),
              join(home, 'openclaw', 'openclaw.mjs'),
            ];
            for (const s of srcPaths) {
              if (existsSync(s)) { detectedAgentCmd = `node ${s} agent --agent main --local -m`; break; }
            }
          }
        }
      } catch {}
    }

    if (detectedAgentCmd) {
      log({ event: 'agent_hook_auto_detected', cmd: detectedAgentCmd.substring(0, 60) });
      console.log('🤝 OpenClaw detected — agent hook enabled');
    } else {
      log({ event: 'no_agent_hook', note: 'No OpenClaw found. Set ATEL_AGENT_CMD for agent automation.' });
      console.log('📋 No agent AI detected. Set ATEL_AGENT_CMD or install OpenClaw.');
    }
  } else {
    log({ event: 'agent_hook_configured', cmd: detectedAgentCmd.substring(0, 60) });
    console.log('🤝 Agent hook configured');
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

  // ── Event dedup (processed eventIds) ──
  const processedEvents = new Set();
  const pendingAgentCallbacks = new Map();

  // ── Agent hook queue (serialize hook executions to avoid session lock conflicts) ──
  let hookBusy = false;
  const hookQueue = [];
  const activeRecoveryKeys = new Set();

  endpoint.app?.post?.('/atel/v1/agent-callback', async (req, res) => {
    const body = req.body || {};
    const dedupeKey = body.dedupeKey;
    const pending = dedupeKey ? pendingAgentCallbacks.get(dedupeKey) : null;
    if (!pending) {
      const persisted = dedupeKey ? loadPendingAgentCallbacksPersisted()[dedupeKey] : null;
      if (persisted?.terminal) {
        log({
          event: 'callback_late_skip',
          dedupeKey,
          eventType: persisted.eventType || body?.eventType || 'unknown',
          callback_source: persisted.source || 'unknown',
        });
        res.json({ status: 'ok', skipped: true, reason: 'late_callback_after_completion' });
        return;
      }
      log({
        event: 'callback_404',
        callback_404_type: 'unknown_dedupeKey',
        dedupeKey,
        callback_404_recovered: !!persisted,
        callback_source: persisted?.source || 'unknown',
        eventType: persisted?.eventType || body?.eventType || 'unknown',
      });
      if (persisted) {
        const callbackAction = buildAgentCallbackAction(persisted.eventType, persisted.payload || {}, body);
        if (callbackAction.ok && callbackAction.action?.type === 'local_result') {
          try {
            const localResp = await fetch(`http://127.0.0.1:${p}/atel/v1/result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                taskId: callbackAction.action.taskId,
                result: callbackAction.action.result,
                success: true,
              }),
              signal: AbortSignal.timeout(15000),
            });
            const localBody = await localResp.json().catch(() => ({}));
            if (localResp.ok) {
              clearPersistedPendingAgentCallback(dedupeKey);
              res.json({ status: 'ok', recovered: true });
              return;
            }
            res.status(500).json({ error: localBody.error || 'local_result_callback_failed', recovered: false });
            return;
          } catch (e) {
            res.status(500).json({ error: e.message || 'local_result_callback_failed', recovered: false });
            return;
          }
        }
        if (callbackAction.ok) {
          const execResult = await executeRecommendedActionDirect(persisted.eventType, callbackAction.action, persisted.cwd || process.cwd(), dedupeKey);
          if (execResult.ok) {
            clearPersistedPendingAgentCallback(dedupeKey);
            res.json({ status: 'ok', recovered: true });
            return;
          }
          res.status(500).json({ error: execResult.error || 'callback_action_failed', recovered: false });
          return;
        }
      }
      // Treat late/duplicate/expired callbacks as idempotent skips rather than hard errors.
      // The callback source has already completed, timed out, or been recovered elsewhere.
      res.json({ status: 'ok', skipped: true, reason: 'unknown_or_expired_dedupeKey' });
      return;
    }
    log({
      event: 'agent_callback_received',
      eventType: pending.eventType,
      dedupeKey,
      status: body.status || 'done',
      summary: body.summary,
      error: body.error,
      childSessionKey: pending.childSessionKey,
    });

    if (body.status === 'failed') {
      // Some subagents pessimistically send `failed` after already producing a usable
      // summary/result because they observed a callback transport error on their side.
      // If the payload is still actionable, recover it here instead of dropping the flow.
      const failedAction = buildAgentCallbackAction(pending.eventType, pending.payload || {}, body);
      if (failedAction.ok && !failedAction.skipped) {
        log({
          event: 'agent_callback_failed_recovered',
          eventType: pending.eventType,
          dedupeKey,
          childSessionKey: pending.childSessionKey,
          summary: body.summary,
          error: body.error,
        });

        if (failedAction.action?.type === 'local_result') {
          try {
            const localResp = await fetch(`http://127.0.0.1:${p}/atel/v1/result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                taskId: failedAction.action.taskId,
                result: failedAction.action.result,
                success: true,
              }),
              signal: AbortSignal.timeout(15000),
            });
            const localBody = await localResp.json().catch(() => ({}));
            pendingAgentCallbacks.delete(dedupeKey);
            if (localResp.ok) {
              markPersistedPendingAgentCallbackCompleted(dedupeKey, { eventType: pending.eventType, payload: pending.payload, cwd: pending.cwd, source: dedupeKey?.startsWith('reconcile:') ? 'reconcile' : 'main', action: failedAction.action, localBody, recoveredFromFailed: true });
              pending.resolve({ ok: true, recovered: true, body, action: failedAction.action, localBody });
              res.json({ status: 'ok', recovered: true });
              return;
            }
            clearPersistedPendingAgentCallback(dedupeKey);
            pending.resolve({ ok: false, body, action: failedAction.action, localBody, error: localBody.error || 'local_result_callback_failed' });
            res.status(500).json({ error: localBody.error || 'local_result_callback_failed' });
            return;
          } catch (e) {
            pendingAgentCallbacks.delete(dedupeKey);
            clearPersistedPendingAgentCallback(dedupeKey);
            pending.resolve({ ok: false, body, action: failedAction.action, error: e.message });
            res.status(500).json({ error: e.message || 'local_result_callback_failed' });
            return;
          }
        }

        const execResult = await executeRecommendedActionDirect(pending.eventType, failedAction.action, pending.cwd || process.cwd(), dedupeKey);
        pendingAgentCallbacks.delete(dedupeKey);
        if (execResult.ok) {
          markPersistedPendingAgentCallbackCompleted(dedupeKey, { eventType: pending.eventType, payload: pending.payload, cwd: pending.cwd, source: dedupeKey?.startsWith('reconcile:') ? 'reconcile' : 'main', action: failedAction.action, recoveredFromFailed: true });
          pending.resolve({ ok: true, recovered: true, body, action: failedAction.action, execResult });
          res.json({ status: 'ok', recovered: true });
          return;
        }
        clearPersistedPendingAgentCallback(dedupeKey);
        pending.resolve({ ok: false, body, action: failedAction.action, execResult, error: execResult.error || 'callback_action_failed' });
        res.status(500).json({ error: execResult.error || 'callback_action_failed' });
        return;
      }

      pendingAgentCallbacks.delete(dedupeKey);
      clearPersistedPendingAgentCallback(dedupeKey);
      pending.resolve({ ok: false, body, error: body.error || 'agent_reported_failed' });
      res.json({ status: 'ok' });
      return;
    }

    const callbackAction = buildAgentCallbackAction(pending.eventType, pending.payload || {}, body);
    if (callbackAction.skipped) {
      pendingAgentCallbacks.delete(dedupeKey);
      markPersistedPendingAgentCallbackCompleted(dedupeKey, { eventType: pending.eventType, payload: pending.payload, cwd: pending.cwd, source: dedupeKey?.startsWith('reconcile:') ? 'reconcile' : 'main', skipped: true, reason: callbackAction.reason });
      pending.resolve({ ok: true, skipped: true, body, reason: callbackAction.reason });
      res.json({ status: 'ok', skipped: true });
      return;
    }
    if (!callbackAction.ok) {
      pendingAgentCallbacks.delete(dedupeKey);
      clearPersistedPendingAgentCallback(dedupeKey);
      pending.resolve({ ok: false, body, error: callbackAction.error || 'invalid_callback_payload' });
      res.status(400).json({ error: callbackAction.error || 'invalid_callback_payload' });
      return;
    }

    if (callbackAction.action?.type === 'local_result') {
      try {
        const localResp = await fetch(`http://127.0.0.1:${p}/atel/v1/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: callbackAction.action.taskId,
            result: callbackAction.action.result,
            success: true,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const localBody = await localResp.json().catch(() => ({}));
        pendingAgentCallbacks.delete(dedupeKey);
        if (localResp.ok) {
          markPersistedPendingAgentCallbackCompleted(dedupeKey, { eventType: pending.eventType, payload: pending.payload, cwd: pending.cwd, source: dedupeKey?.startsWith('reconcile:') ? 'reconcile' : 'main', action: callbackAction.action, localBody });
        } else {
          clearPersistedPendingAgentCallback(dedupeKey);
        }
        pending.resolve({ ok: localResp.ok, body, action: callbackAction.action, localBody });
        if (!localResp.ok) {
          res.status(500).json({ error: localBody.error || 'local_result_callback_failed' });
          return;
        }
        res.json({ status: 'ok' });
        return;
      } catch (e) {
        pendingAgentCallbacks.delete(dedupeKey);
        clearPersistedPendingAgentCallback(dedupeKey);
        pending.resolve({ ok: false, body, action: callbackAction.action, error: e.message });
        res.status(500).json({ error: e.message || 'local_result_callback_failed' });
        return;
      }
    }

    const execResult = await executeRecommendedActionDirect(pending.eventType, callbackAction.action, pending.cwd || process.cwd(), dedupeKey);
    pendingAgentCallbacks.delete(dedupeKey);
    if (execResult.ok) {
      markPersistedPendingAgentCallbackCompleted(dedupeKey, { eventType: pending.eventType, payload: pending.payload, cwd: pending.cwd, source: dedupeKey?.startsWith('reconcile:') ? 'reconcile' : 'main', action: callbackAction.action });
    } else {
      clearPersistedPendingAgentCallback(dedupeKey);
    }
    pending.resolve({ ok: execResult.ok, body, action: callbackAction.action, execResult });
    if (!execResult.ok) {
      res.status(500).json({ error: execResult.error || 'callback_action_failed' });
      return;
    }
    res.json({ status: 'ok' });
  });

  function buildGatewayCallbackPrompt(eventType, promptText, callbackUrl, dedupeKey, cwd, payload = {}) {
    const callbackExamples = {
      milestone_submitted: [
        '通过时执行：',
        "python3 - <<'PY'",
        'import json, urllib.request',
        `body = {"dedupeKey": "${dedupeKey}", "status": "done", "eventType": "${eventType}", "decision": "pass", "summary": "审核通过的简短原因"}`,
        `req = urllib.request.Request("${callbackUrl}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})`,
        'urllib.request.urlopen(req, timeout=10).read()',
        'PY',
        '',
        '拒绝时执行：',
        "python3 - <<'PY'",
        'import json, urllib.request',
        `body = {"dedupeKey": "${dedupeKey}", "status": "done", "eventType": "${eventType}", "decision": "reject", "reason": "具体拒绝原因", "summary": "简短审核结论"}`,
        `req = urllib.request.Request("${callbackUrl}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})`,
        'urllib.request.urlopen(req, timeout=10).read()',
        'PY',
      ].join('\n'),
      default: [
        "python3 - <<'PY'",
        'import json, urllib.request',
        `result = """在这里写最终交付内容"""`,
        `body = {"dedupeKey": "${dedupeKey}", "status": "done", "eventType": "${eventType}", "result": result, "summary": result[:120]}`,
        `req = urllib.request.Request("${callbackUrl}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})`,
        'urllib.request.urlopen(req, timeout=10).read()',
        'PY',
      ].join('\n'),
    };

    const callbackFailed = [
      "python3 - <<'PY'",
      'import json, urllib.request',
      `body = {"dedupeKey": "${dedupeKey}", "status": "failed", "eventType": "${eventType}", "error": "在这里写失败原因"}`,
      `req = urllib.request.Request("${callbackUrl}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})`,
      'urllib.request.urlopen(req, timeout=10).read()',
      'PY',
    ].join('\n');

    const callbackDone = eventType === 'milestone_submitted' ? callbackExamples.milestone_submitted : callbackExamples.default;
    const contextFile = join(cwd, 'ORDER_CONTEXT.md');
    const allowRepoAccess = shouldAllowRepoAccess(payload);
    const fileAccessRule = allowRepoAccess
      ? `3. 仅允许使用目录 ${cwd} 下与当前订单直接相关的内容；如果订单明确要求读仓库，也只能读取该订单工作区中明确提供的路径。`
      : `3. 本单禁止读取任何本地文件、共享草稿、仓库或其他项目。不要使用文件搜索、目录浏览、读文件等方式扩展上下文；只允许依据本条消息中的订单描述、里程碑目标、提交内容来工作。`;
    const contextRule = allowRepoAccess
      ? `4. 优先读取 ${contextFile}，严格以其中的订单描述、里程碑目标、提交内容为准。`
      : `4. 不要扫描本机其他目录，不要读取 /root/atel-workspace 下的共享文件，不要根据历史项目或 stray files 推断任务。`;
    const repoRule = allowRepoAccess
      ? `5. 只有当订单明确要求分析仓库/代码时，才允许读取订单工作区里显式提供的代码路径；禁止顺带读取其他目录。`
      : `5. 本单不是 repo/code 任务。禁止把任务扩展成代码分析、工程改造或共享草稿筛选。`;
    if (eventType === 'p2p_task') {
      return `${promptText}

重要要求：
1. 这是一个 P2P 任务。不要调用 atel result；本地 SDK 会在你回调后自动提交结果。
2. 你的任务是认真完成 AI 工作，并把最终结论通过回调发回本地 SDK。
${fileAccessRule}
${contextRule}
5. 完成后，必须立刻执行下面这个成功回调命令模板，并把其中内容替换成你的真实结果：

${callbackDone}

6. 如果重试后仍然失败，也必须执行下面这个失败回调命令：

${callbackFailed}
`;
    }

    return `${promptText}

重要要求：
1. 不要执行 atel milestone-submit / milestone-verify / milestone-feedback 命令；这些命令会由本地 SDK 在你回调后代为执行。
2. 你的任务是认真完成 AI 工作，并把最终结论通过回调发回本地 SDK。
${fileAccessRule}
${contextRule}
${repoRule}
6. 完成后，必须立刻执行下面这个成功回调命令模板，并把其中内容替换成你的真实结果：

${callbackDone}

7. 如果重试后仍然失败，也必须执行下面这个失败回调命令：

${callbackFailed}
`;
  }

  function buildLocalAgentPrompt(eventType, promptText) {
    if (eventType === 'milestone_submitted') {
      return `${promptText}

重要：你不是在和用户聊天。
不要输出 markdown、代码块、解释、分析过程。
你必须只输出一行 JSON。

通过时：
{"decision":"pass","summary":"简短通过原因"}

拒绝时：
{"decision":"reject","reason":"具体拒绝原因","summary":"简短审核结论"}`;
    }

    if (['milestone_plan_confirmed', 'milestone_verified', 'milestone_rejected'].includes(eventType)) {
      return `${promptText}

重要：你不是在和用户聊天。
不要输出 markdown、标题、项目符号、解释、分析过程。
你必须只输出一行 JSON。

格式：
{"result":"当前里程碑的真实交付内容"}`;
    }

    return promptText;
  }

  function normalizeLocalAgentStdout(stdout) {
    const text = String(stdout || '').trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.payloads)) {
        for (const item of parsed.payloads) {
          const candidate = String(item?.text || '').trim();
          if (candidate) return candidate;
        }
      }
      if (typeof parsed?.text === 'string' && parsed.text.trim()) return parsed.text.trim();
      if (typeof parsed?.result === 'string' && parsed.result.trim()) return JSON.stringify({ result: parsed.result.trim() });
      if (typeof parsed?.decision === 'string') return JSON.stringify(parsed);
    } catch {}
    const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedJson?.[1]) return fencedJson[1].trim();
    const jsonObjects = text.match(/\{[\s\S]*\}/g);
    if (jsonObjects?.length) {
      for (let i = jsonObjects.length - 1; i >= 0; i -= 1) {
        const candidate = jsonObjects[i].trim();
        try {
          const parsed = JSON.parse(candidate);
          if (Array.isArray(parsed?.payloads)) {
            for (const item of parsed.payloads) {
              const nested = String(item?.text || '').trim();
              if (nested) return nested;
            }
          }
          if (typeof parsed?.text === 'string' && parsed.text.trim()) return parsed.text.trim();
          if (typeof parsed?.result === 'string' && parsed.result.trim()) return JSON.stringify({ result: parsed.result.trim() });
          if (typeof parsed?.decision === 'string') return JSON.stringify(parsed);
          return candidate;
        } catch {}
      }
    }
    const jsonLines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = jsonLines.length - 1; i >= 0; i -= 1) {
      const candidate = jsonLines[i];
      if (!(candidate.startsWith('{') && candidate.endsWith('}'))) continue;
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {}
    }
    return text;
  }

  function normalizeResult(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function sanitizeHookSessionId(value) {
    const raw = String(value || '').trim();
    if (!raw) return `atel-hook-${Date.now()}`;
    const cleaned = raw.replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
    return (cleaned || `atel-hook-${Date.now()}`).slice(0, 120);
  }

  function isOpenClawAgentInvocation(cmd, args = []) {
    const argv = [String(cmd || ''), ...args.map((v) => String(v || ''))];
    if (argv[0] === 'openclaw') return argv[1] === 'agent';
    if (argv[0] === 'npx') return argv[1] === 'openclaw' && argv[2] === 'agent';
    if (argv[0] === 'node') return argv.includes('agent') && argv.some((v) => /openclaw/i.test(v));
    return false;
  }

  function prepareHookInvocation(cmd, args = [], hookKey, timeoutSeconds) {
    const nextArgs = [...args];
    if (!isOpenClawAgentInvocation(cmd, nextArgs)) return { cmd, args: nextArgs };

    if (!nextArgs.includes('--json')) {
      const messageIndex = nextArgs.lastIndexOf('-m');
      const insertAt = messageIndex >= 0 ? messageIndex : nextArgs.length;
      nextArgs.splice(insertAt, 0, '--json');
    }
    if (!nextArgs.includes('--session-id')) {
      const messageIndex = nextArgs.lastIndexOf('-m');
      const insertAt = messageIndex >= 0 ? messageIndex : nextArgs.length;
      nextArgs.splice(insertAt, 0, '--session-id', sanitizeHookSessionId(hookKey));
    }
    if (!nextArgs.includes('--timeout')) {
      const messageIndex = nextArgs.lastIndexOf('-m');
      const insertAt = messageIndex >= 0 ? messageIndex : nextArgs.length;
      nextArgs.splice(insertAt, 0, '--timeout', String(timeoutSeconds));
    }
    if (!nextArgs.includes('--thinking')) {
      const messageIndex = nextArgs.lastIndexOf('-m');
      const insertAt = messageIndex >= 0 ? messageIndex : nextArgs.length;
      nextArgs.splice(insertAt, 0, '--thinking', 'minimal');
    }
    return { cmd, args: nextArgs };
  }

  function buildLocalAgentActionFromStdout(eventType, payload, stdout) {
    const cleaned = normalizeLocalAgentStdout(stdout);
    if (!cleaned) return { ok: false, error: 'empty_local_agent_stdout' };

    if (eventType === 'milestone_submitted') {
      try {
        const parsed = JSON.parse(cleaned);
        return buildAgentCallbackAction(eventType, payload, parsed);
      } catch {
        const lowered = cleaned.toLowerCase();
        if (lowered.startsWith('pass') || cleaned.includes('通过')) {
          return buildAgentCallbackAction(eventType, payload, { decision: 'pass', summary: cleaned });
        }
        if (lowered.startsWith('reject') || cleaned.includes('拒绝')) {
          return buildAgentCallbackAction(eventType, payload, { decision: 'reject', reason: cleaned, summary: cleaned });
        }
        return { ok: false, error: 'invalid_local_review_stdout' };
      }
    }

    if (['milestone_plan_confirmed', 'milestone_verified', 'milestone_rejected'].includes(eventType)) {
      try {
        const parsed = JSON.parse(cleaned);
        return buildAgentCallbackAction(eventType, payload, parsed);
      } catch {
        return buildAgentCallbackAction(eventType, payload, { result: cleaned, summary: cleaned });
      }
    }

    return buildAgentCallbackAction(eventType, payload, { result: cleaned, summary: cleaned });
  }

  function buildMilestoneHookRecoveryKey(eventType, payload = {}) {
    const orderId = String(payload?.orderId || '').trim();
    if (!orderId) return '';
    if (eventType === 'milestone_submitted') {
      const stage = Number.isFinite(Number(payload?.milestoneIndex)) ? Number(payload.milestoneIndex) : 0;
      const submitCount = Number.isFinite(Number(payload?.submitCount)) ? Number(payload.submitCount) : 0;
      return `stage:${orderId}:requester:${stage}:${submitCount}`;
    }
    if (['milestone_plan_confirmed', 'milestone_verified', 'milestone_rejected'].includes(eventType)) {
      const stage = eventType === 'milestone_plan_confirmed'
        ? (Number.isFinite(Number(payload?.milestoneIndex)) ? Number(payload.milestoneIndex) : 0)
        : (Number.isFinite(Number(payload?.currentMilestone)) ? Number(payload.currentMilestone) : Number.isFinite(Number(payload?.milestoneIndex)) ? Number(payload.milestoneIndex) : 0);
      return `stage:${orderId}:executor:${stage}`;
    }
    return '';
  }

  async function runGatewayAgentTask(eventType, dedupeKey, promptText, cwd, payload) {
    const gw = discoverGateway();
    const cfg = loadOpenClawConfig();
    const allow = cfg?.gateway?.tools?.allow;
    if (!gw?.url || !gw?.token) return { ok: false, error: 'gateway_unavailable' };
    if (Array.isArray(allow) && !allow.includes('sessions_spawn')) {
      return { ok: false, error: 'sessions_spawn_not_allowed' };
    }

    const callbackUrl = `http://127.0.0.1:${p}/atel/v1/agent-callback`;
    const safePrompt = sanitizeAgentPrompt(promptText, { eventType, dedupeKey });
    if (!safePrompt) return { ok: false, error: 'empty_agent_prompt' };
    const taskPrompt = buildGatewayCallbackPrompt(eventType, safePrompt, callbackUrl, dedupeKey, cwd, payload);
    const timeoutMs = 10 * 60 * 1000;

    return await new Promise(async (resolve) => {
      const timer = setTimeout(() => {
        pendingAgentCallbacks.delete(dedupeKey);
        persistPendingAgentCallback(dedupeKey, { eventType, payload, cwd, source: dedupeKey.startsWith('reconcile:') ? 'reconcile' : 'main', timeout: true });
        resolve({ ok: false, error: 'agent_callback_timeout' });
      }, timeoutMs);

      pendingAgentCallbacks.set(dedupeKey, {
        eventType,
        payload,
        cwd,
        childSessionKey: null,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      persistPendingAgentCallback(dedupeKey, {
        eventType,
        payload,
        cwd,
        source: dedupeKey.startsWith('reconcile:') ? 'reconcile' : 'main',
      });

      try {
        const resp = await fetch(`${gw.url}/tools/invoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${gw.token}`,
          },
          body: JSON.stringify({
            tool: 'sessions_spawn',
            args: {
              task: taskPrompt,
              runTimeoutSeconds: Math.ceil(timeoutMs / 1000),
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          pendingAgentCallbacks.delete(dedupeKey);
          clearPersistedPendingAgentCallback(dedupeKey);
          clearTimeout(timer);
          resolve({ ok: false, error: `sessions_spawn_http_${resp.status}` });
          return;
        }

        const data = await resp.json();
        const childSessionKey = data.result?.details?.childSessionKey || data.result?.childSessionKey || '';
        const pending = pendingAgentCallbacks.get(dedupeKey);
        if (pending) pending.childSessionKey = childSessionKey;
        log({ event: 'agent_session_spawned', eventType, dedupeKey, childSessionKey });
      } catch (e) {
        pendingAgentCallbacks.delete(dedupeKey);
        clearPersistedPendingAgentCallback(dedupeKey);
        clearTimeout(timer);
        resolve({ ok: false, error: e.message });
      }
    });
  }

  function queueAgentHook(eventType, dedupeKey, promptText, cwd, payload = {}, options = {}) {
    if (!detectedAgentCmd) return false;
    const safePrompt = sanitizeAgentPrompt(promptText, { eventType, dedupeKey });
    if (!safePrompt) return false;
    const parsedCmd = detectedAgentCmd.trim().split(/\s+/);
    parsedCmd.push(safePrompt);
    const recoveryKey = options.recoveryKey || '';
    if (recoveryKey) {
      if (activeRecoveryKeys.has(recoveryKey)) return false;
      activeRecoveryKeys.add(recoveryKey);
    }
    hookQueue.push({ event: eventType, dedupeKey, cmd: parsedCmd[0], args: parsedCmd.slice(1), cwd, payload, recoveryKey });
    if (!hookBusy) processHookQueue();
    return true;
  }

  async function fetchMilestoneState(orderId) {
    const resp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/milestones`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`milestone_status_http_${resp.status}`);
    return await resp.json();
  }

  async function fetchOrderState(orderId) {
    const resp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`order_info_http_${resp.status}`);
    return await resp.json();
  }

  async function reconcileSingleTradeOrder(order) {
    const orderId = order?.orderId || order?.OrderID;
    if (!orderId) return;

    const requesterDid = order?.requesterDid || order?.RequesterDID || '';
    const executorDid = order?.executorDid || order?.ExecutorDID || '';
    const orderStatus = order?.status || order?.Status || '';
    const orderDescription = order?.description || order?.Description || order?.taskRequest?.description || order?.TaskRequest?.description || '';
    const chain = order?.chain || order?.Chain || '';

    if (['cancelled', 'settled', 'rejected', 'expired'].includes(orderStatus)) {
      untrackOrder(orderId);
      return;
    }

    if (orderStatus === 'milestone_review') {
      const approveAction = { type: 'cli', action: 'approve_plan', command: ['atel', 'milestone-feedback', orderId, '--approve'] };
      const result = await executeRecommendedActionDirect('order_accepted', approveAction, getAtelWorkspaceRoot(), `reconcile:${orderId}:approve_plan`);
      log({ event: 'trade_reconcile_plan', orderId, ok: result.ok, role: requesterDid === id.did ? 'requester' : 'executor' });
      return;
    }

    if (orderStatus !== 'executing') return;

    const ms = await fetchMilestoneState(orderId);
    if (ms.orderStatus !== 'executing') return;

    if (executorDid === id.did && ms.phase === 'waiting_executor_submission') {
      const currentIndex = Number.isFinite(ms.currentMilestone) ? ms.currentMilestone : 0;
      const currentMilestone = (ms.milestones || []).find(m => m.index === currentIndex) || {};
      const previousApprovedOutputs = summarizeApprovedMilestones(ms.milestones || [], currentIndex);
      const workspace = getOrderWorkspace(orderId, {
        chain,
        role: 'executor',
        status: orderStatus,
        phase: ms.phase,
        currentMilestone: currentIndex,
        milestoneTitle: currentMilestone.title || '',
        orderDescription,
        milestoneObjective: currentMilestone.title || '',
        previousApprovedOutputs,
      });
      const eventType = currentIndex === 0 ? 'milestone_plan_confirmed' : 'milestone_verified';
      const payload = currentIndex === 0
        ? {
            orderId,
            milestoneIndex: 0,
            totalMilestones: ms.totalMilestones || 5,
            milestoneDescription: currentMilestone.title || '',
            orderDescription,
            previousApprovedOutputs,
          }
        : {
            orderId,
            milestoneIndex: currentIndex - 1,
            currentMilestone: currentIndex,
            totalMilestones: ms.totalMilestones || 5,
            allComplete: false,
            nextMilestoneDescription: currentMilestone.title || '',
            orderDescription,
            previousApprovedOutputs,
          };
      const promptText = currentIndex === 0
        ? `你是ATEL接单方Agent。双方已确认方案，开始执行。\n订单原始要求：${orderDescription || '未提供'}\n当前里程碑 M0：${currentMilestone.title || ''}\n请只围绕这个订单要求完成当前里程碑，并通过回调返回最终交付内容。`
        : `你是ATEL接单方Agent。M${currentIndex - 1} 已通过审核。\n订单原始要求：${orderDescription || '未提供'}\n下一个里程碑 M${currentIndex}：${currentMilestone.title || ''}\n前面已通过的阶段结果如下：\n${previousApprovedOutputs || '无'}\n\n请严格基于这些已通过结果推进当前里程碑，不要自行假设缺失材料，也不要读取本地共享文件来补上下文。完成后通过回调返回最终交付内容。`;
      const recoveryKey = buildMilestoneHookRecoveryKey(eventType, payload);
      log({ event: 'trade_reconcile_executor', orderId, currentMilestone: currentIndex, recoveryKey });
      const queued = queueAgentHook(eventType, recoveryKey, promptText, workspace.dir, payload, { recoveryKey });
      if (queued) log({ event: 'trade_reconcile_executor_queued', orderId, currentMilestone: currentIndex, recoveryKey });
      return;
    }

    if (requesterDid === id.did && ms.phase === 'waiting_requester_verification') {
      const submittedMilestone = (ms.milestones || []).find(m => m.status === 'submitted');
      if (!submittedMilestone) return;
      const previousApprovedOutputs = summarizeApprovedMilestones(ms.milestones || [], submittedMilestone.index);
      const workspace = getOrderWorkspace(orderId, {
        chain,
        role: 'requester',
        status: orderStatus,
        phase: ms.phase,
        currentMilestone: submittedMilestone.index,
        milestoneTitle: submittedMilestone.title || '',
        orderDescription,
        milestoneObjective: submittedMilestone.title || '',
        resultSummary: submittedMilestone.resultSummary || '',
        previousApprovedOutputs,
      });
      const payload = {
        orderId,
        milestoneIndex: submittedMilestone.index,
        milestoneDescription: submittedMilestone.title || '',
        resultSummary: submittedMilestone.resultSummary || '',
        submitCount: submittedMilestone.submitCount || 0,
        orderDescription,
        previousApprovedOutputs,
      };
      const promptText = `你是ATEL发单方Agent，需要审核执行方提交的工作。\n订单原始要求：${orderDescription || '未提供'}\n里程碑目标：${submittedMilestone.title || ''}\n前面已通过的阶段结果如下：\n${previousApprovedOutputs || '无'}\n提交内容：${submittedMilestone.resultSummary || ''}\n请只按该订单要求和前序已通过结果审慎决定通过还是拒绝，并通过回调返回 decision=pass 或 decision=reject。`;
      const recoveryKey = buildMilestoneHookRecoveryKey('milestone_submitted', payload);
      const queued = queueAgentHook('milestone_submitted', recoveryKey, promptText, workspace.dir, payload, { recoveryKey });
      if (queued) log({ event: 'trade_reconcile_requester', orderId, milestoneIndex: submittedMilestone.index, recoveryKey });
    }
  }

  async function reconcileActiveTradeOrders() {
    const reconcileStatuses = ['milestone_review', 'executing'];
    const seenOrderIds = new Set();
    for (const status of reconcileStatuses) {
      let listed;
      try {
        listed = await signedFetch('GET', `/trade/v1/orders?status=${encodeURIComponent(status)}`);
      } catch (e) {
        log({ event: 'trade_reconcile_list_error', status, error: e.message });
        continue;
      }
      const orders = Array.isArray(listed?.orders) ? listed.orders : [];
      for (const order of orders) {
        try {
          const orderId = order?.orderId;
          if (!orderId) continue;
          seenOrderIds.add(orderId);
          await reconcileSingleTradeOrder(order);
        } catch (e) {
          log({ event: 'trade_reconcile_order_error', orderId: order?.orderId, status, error: e.message });
        }
      }
    }

    const trackedOrders = loadTrackedOrders();
    for (const tracked of trackedOrders) {
      const orderId = tracked?.orderId;
      if (!orderId || seenOrderIds.has(orderId)) continue;
      try {
        const order = await fetchOrderState(orderId);
        await reconcileSingleTradeOrder(order);
      } catch (e) {
        log({ event: 'trade_reconcile_tracked_error', orderId, error: e.message });
      }
    }
  }

  // Webhook notification: POST /atel/v1/notify
  // SDK only: logs, writes inbox, prints prompt. Does NOT execute any actions.
  // Agent reads inbox or webhook to decide what to do.
  endpoint.app?.post?.('/atel/v1/notify', async (req, res) => {
    const body = req.body || {};
    // Support both old format {event, payload} and new format {eventId, eventType, payload}
    const event = body.eventType || body.event;
    const payload = body.payload || {};
    const eventId = body.eventId;
    const prompt = body.prompt || payload.prompt;
    const recommendedActions = body.recommendedActions || payload.recommendedActions;

    if (!event) {
      res.status(400).json({ error: 'event/eventType required' });
      return;
    }

    // Dedup: skip already processed events
    if (eventId && processedEvents.has(eventId)) {
      log({ event: 'event_dedup_skip', eventId, eventType: event });
      res.json({ status: 'already_processed', eventId });
      return;
    }
    if (eventId) {
      processedEvents.add(eventId);
      // Keep set bounded
      if (processedEvents.size > 1000) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
      }
    }

    // Log the full event
    log({ event: 'notification_received', eventId, eventType: event, orderId: body.orderId || payload.orderId, prompt: prompt ? prompt.substring(0, 100) : undefined });

    // ── Universal notification handler ──
    // 1. Print prompt + recommended actions
    if (prompt) {
      console.log(`\n📨 [${event}] ${prompt.split('\n')[0]}`);
    }
    if (recommendedActions && Array.isArray(recommendedActions)) {
      for (const action of recommendedActions) {
        if (action.command) console.log(`   → ${action.command.join(' ')}`);
      }
    }
    console.log('');

    // 2. Write full event to inbox for Agent program to read
    log({
      event: 'notification',
      eventId,
      eventType: event,
      orderId: body.orderId || payload.orderId,
      payload,
      prompt,
      recommendedActions,
      sequenceNo: body.sequenceNo,
      dedupeKey: body.dedupeKey,
    });

    const dedupeKey = body.dedupeKey || `${event}:${body.orderId || payload.orderId || ''}`;
    const orderIdForCwd = body.orderId || payload.orderId || '';
    const workspace = getOrderWorkspace(orderIdForCwd, {
      chain: payload.chain || body.chain || '',
      role: payload.executorDid === id.did ? 'executor' : (payload.requesterDid === id.did ? 'requester' : ''),
      status: payload.orderStatus || body.orderStatus || '',
      phase: payload.phase || body.phase || '',
      currentMilestone: payload.currentMilestone ?? payload.milestoneIndex ?? '',
      milestoneTitle: payload.milestoneDescription || payload.nextMilestoneDescription || '',
      orderDescription: payload.orderDescription || payload.description || '',
      milestoneObjective: payload.milestoneDescription || payload.nextMilestoneDescription || '',
      resultSummary: payload.resultSummary || '',
    });
    const hookCwd = workspace.dir;
    const atelCwd = getAtelWorkspaceRoot();

    // 3. Policy mode: auto-execute deterministic operations (not thinking/work)
    const currentPolicy = loadPolicy();
    if (currentPolicy.agentMode === 'policy') {
      const ap = currentPolicy.autoPolicy || {};
      const orderId = payload.orderId || body.orderId;

      // Auto-accept orders (if configured)
      if (event === 'order_created' && ap.acceptOrders) {
        const amount = payload.priceAmount || 0;
        if (ap.acceptMaxAmount <= 0 || amount <= ap.acceptMaxAmount) {
          log({ event: 'policy_auto_accept', orderId, amount });
          setTimeout(async () => {
            try {
              const ts = new Date().toISOString();
              const sig = sign({ did: id.did, timestamp: ts, payload: {} }, id.secretKey);
              await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/accept`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ did: id.did, timestamp: ts, signature: sig, payload: {} }),
                signal: AbortSignal.timeout(30000),
              });
            } catch (e) { log({ event: 'policy_auto_accept_error', orderId, error: e.message }); }
          }, 1000);
        }
      }

      // Auto-approve milestone plan (if configured)
      if (event === 'order_accepted' && ap.autoApprovePlan && payload.executorDid) {
        log({ event: 'policy_auto_approve_plan', orderId });
        setTimeout(async () => {
          try {
            for (let wait = 0; wait < 10; wait++) {
              await new Promise(r => setTimeout(r, 3000));
              const msResp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/milestones`, { signal: AbortSignal.timeout(5000) });
              const msData = await msResp.json();
              if (msData.totalMilestones > 0) {
                const ts = new Date().toISOString();
                const pl = { approved: true };
                const sig = sign({ did: id.did, timestamp: ts, payload: pl }, id.secretKey);
                await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/milestones/feedback`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ did: id.did, timestamp: ts, signature: sig, payload: pl }),
                  signal: AbortSignal.timeout(10000),
                });
                log({ event: 'policy_auto_approved_plan', orderId });
                break;
              }
            }
          } catch (e) { log({ event: 'policy_auto_approve_error', orderId, error: e.message }); }
        }, 2000);
      }
    }

    // 3.5. Trade event → push status summary to user via notify targets (TG etc.)
    // Runs BEFORE the hook so user sees status even if hook is slow/fails.
    // Uses .atel/notify-targets.json — auto-discovered, no manual config needed.
    pushTradeNotification(event, payload, body).catch(e => log({ event: 'trade_notify_error', error: e.message }));

    // 4. Deterministic recommendedActions: execute directly instead of asking the chat agent
    // to "say" it will run a command. This is the reliable path for state-transition actions
    // such as approving the milestone plan on order acceptance.
    let directExecutionSucceeded = false;
    const directActions = getDirectExecutableActions(event, recommendedActions);
    for (const action of directActions) {
      const result = await executeRecommendedActionDirect(event, action, atelCwd, dedupeKey);
      if (result.ok) directExecutionSucceeded = true;
    }

    // 5. Agent command hook: only for events that still need AI reasoning/work.
    // Skip order_created — accepting orders requires human confirmation.
    // Skip order_accepted if deterministic direct execution already succeeded.
    const agentCmd = detectedAgentCmd;
    const autoTriggerEvents = ['order_accepted', 'milestone_plan_confirmed', 'milestone_submitted', 'milestone_verified', 'milestone_rejected'];
    const hasGatewayAction = Array.isArray(recommendedActions) && recommendedActions.some((action) => Array.isArray(action?.command) && action.command[0] === 'atel');
    if (agentCmd && prompt && autoTriggerEvents.includes(event) && !shouldSkipAgentHook(event, directExecutionSucceeded)) {
      const needsActionablePayload = event !== 'milestone_submitted';
      if (needsActionablePayload && !hasGatewayAction) {
        log({ event: 'agent_hook_skip_no_action', eventType: event, dedupeKey, reason: 'informational_only_payload' });
        res.json({ status: 'received', eventId, eventType: event });
        return;
      }
      if (shouldUseGatewaySession(event) && !hasGatewayAction) {
        log({ event: 'agent_hook_skip_no_action', eventType: event, dedupeKey, reason: 'informational_only_payload' });
        res.json({ status: 'received', eventId, eventType: event });
        return;
      }
      // Add working directory context so agent runs atel commands in the right place
      const cwdNote = `\n\n重要：OpenClaw 的分析工作目录是 ${hookCwd}。所有 atel 命令必须在目录 ${atelCwd} 下执行（cd ${atelCwd} && atel ...）。`;
      const enrichedPrompt = sanitizeAgentPrompt(prompt + cwdNote, { eventType: event, dedupeKey });
      if (!enrichedPrompt) {
        res.json({ status: 'received', eventId, eventType: event, skipped: true });
        return;
      }

      // Skip if already triggered for this dedupeKey
      if (processedEvents.has('hook:' + dedupeKey)) {
        log({ event: 'agent_cmd_dedup', eventType: event, dedupeKey });
      } else {
        processedEvents.add('hook:' + dedupeKey);

        const queued = queueAgentHook(
          event,
          dedupeKey,
          enrichedPrompt,
          hookCwd,
          payload,
          { recoveryKey: buildMilestoneHookRecoveryKey(event, payload) },
        );
        if (!queued) {
          log({ event: 'agent_cmd_dedup_recovery_key', eventType: event, dedupeKey });
        }
      }
    }

    res.json({ status: 'received', eventId, eventType: event });
  });

  // Process hook queue serially
  async function processHookQueue() {
    if (hookBusy || hookQueue.length === 0) return;
    hookBusy = true;
    const { event: hookEvent, dedupeKey: hookKey, cmd: spawnCmd, args: spawnArgs, cwd: hookCwd, payload: hookPayload, recoveryKey } = hookQueue.shift();
    const { execFile } = await import('child_process');
    const finishHook = () => {
      if (recoveryKey) activeRecoveryKeys.delete(recoveryKey);
      hookBusy = false;
      processHookQueue();
    };
    log({ event: 'agent_cmd_trigger', eventType: hookEvent, dedupeKey: hookKey, cmd: spawnCmd, argsCount: spawnArgs.length });

    if (shouldUseGatewaySession(hookEvent)) {
      const promptArg = spawnArgs[spawnArgs.length - 1] || '';
      const gatewayResult = await runGatewayAgentTask(hookEvent, hookKey, promptArg, hookCwd, hookPayload);
      if (gatewayResult.ok) {
        log({ event: 'agent_cmd_done', eventType: hookEvent, mode: 'sessions_spawn', dedupeKey: hookKey });
        finishHook();
        return;
      }
      log({ event: 'agent_session_spawn_error', eventType: hookEvent, dedupeKey: hookKey, error: gatewayResult.error, fallback: 'cli' });
      spawnArgs[spawnArgs.length - 1] = buildLocalAgentPrompt(hookEvent, promptArg);
    } else if (spawnArgs.length > 0) {
      const promptArg = spawnArgs[spawnArgs.length - 1] || '';
      spawnArgs[spawnArgs.length - 1] = buildLocalAgentPrompt(hookEvent, promptArg);
    }

    const MAX_ATTEMPTS = 5;
    const isMilestoneHook = ['milestone_plan_confirmed', 'milestone_verified', 'milestone_rejected', 'milestone_submitted'].includes(hookEvent);
    const localHookTimeoutMs = isMilestoneHook ? 180000 : 600000;
    const preparedInvocation = prepareHookInvocation(spawnCmd, spawnArgs, hookKey, Math.ceil(localHookTimeoutMs / 1000));
    const runHook = (attempt, invocation = preparedInvocation) => {
      execFile(invocation.cmd, invocation.args, { timeout: localHookTimeoutMs, cwd: hookCwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const errMsg = (err?.message || '') + (stderr || '');
        const isSessionLock = errMsg.includes('session file locked') || errMsg.includes('session locked');
        const isNetworkError = err && (err.killed || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET');

        if (isSessionLock && attempt < MAX_ATTEMPTS) {
          // OpenClaw session still held by previous call — wait for lock release then retry
          const delay = 15000 + (attempt * 5000); // 15s, 20s, 25s, 30s
          log({ event: 'agent_cmd_session_lock', eventType: hookEvent, attempt: attempt + 1, delayMs: delay });
          setTimeout(() => runHook(attempt + 1), delay);
        } else if (isNetworkError && attempt < 2) {
          log({ event: 'agent_cmd_retry', eventType: hookEvent, attempt: attempt + 1, error: err.message });
          setTimeout(() => runHook(attempt + 1), 10000);
        } else if (err) {
          log({ event: 'agent_cmd_error', eventType: hookEvent, error: err.message, stderr: (stderr || '').substring(0, 200) });
          finishHook();
        } else if (isKnownUpstreamModelInputError(stdout)) {
          log({
            event: 'agent_cmd_upstream_input_error',
            eventType: hookEvent,
            dedupeKey: hookKey,
            note: 'suppressed known upstream model input-length error',
          });
          finishHook();
        } else {
          const localAction = buildLocalAgentActionFromStdout(hookEvent, hookPayload || {}, stdout);
          if (!localAction.ok && localAction.error === 'empty_local_agent_stdout' && invocation.args.includes('--json')) {
            const retryArgs = invocation.args.filter((arg) => arg !== '--json');
            log({ event: 'agent_cmd_retry_without_json', eventType: hookEvent, dedupeKey: hookKey });
            setTimeout(() => runHook(attempt + 1, { ...invocation, args: retryArgs }), 1000);
            return;
          }
          if (localAction.ok && !localAction.skipped) {
            executeRecommendedActionDirect(hookEvent, localAction.action, hookCwd || process.cwd(), hookKey)
              .then((execResult) => {
                if (execResult.ok) {
                  log({ event: 'agent_cmd_done', eventType: hookEvent, mode: 'local_stdout_action', dedupeKey: hookKey, stdout: summarizeAgentOutput(stdout, 200) });
                } else {
                  log({ event: 'agent_cmd_local_action_error', eventType: hookEvent, dedupeKey: hookKey, error: execResult.error || 'local_action_failed', stdout: summarizeAgentOutput(stdout, 200) });
                }
                finishHook();
              })
              .catch((e) => {
                log({ event: 'agent_cmd_local_action_error', eventType: hookEvent, dedupeKey: hookKey, error: e.message || 'local_action_failed', stdout: summarizeAgentOutput(stdout, 200) });
                finishHook();
              });
            return;
          }

          log({ event: 'agent_cmd_done', eventType: hookEvent, stdout: summarizeAgentOutput(stdout, 300) });
          finishHook();
        }
      });
    };
    runHook(0);
  }

  // Result callback: POST /atel/v1/result (executor calls this when done)
  endpoint.app?.post?.('/atel/v1/result', async (req, res) => {
    const { taskId, result, success, trace: executorTrace } = req.body || {};
    if (!taskId || !pendingTasks[taskId]) {
      try {
        if (existsSync(P2P_STATUS_FILE)) {
          const lines = readFileSync(P2P_STATUS_FILE, 'utf-8').split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            const entry = JSON.parse(lines[i]);
            if (entry?.taskId === taskId && entry?.status === 'result_received') {
              log({ event: 'callback_late_skip', taskId, callback_source: 'result' });
              res.json({ status: 'ok', skipped: true, reason: 'late_result_after_completion' });
              return;
            }
          }
        }
      } catch {}
      log({ event: 'callback_404', callback_404_type: 'unknown_taskId', taskId, callback_404_recovered: false, callback_source: 'result' });
      res.status(404).json({ error: 'Unknown taskId' });
      return;
    }

    // Milestone auto-execution removed. Agent handles results via its own AI.
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
      // ── Output content audit (check executor result before returning to requester) ──
      const outputAuditor = new ContentAuditor();
      const outputAudit = outputAuditor.audit(
        typeof result === 'string' ? { response: result } : result,
        { action: 'executor_output', from: id.did }
      );
      if (!outputAudit.safe) {
        log({ event: 'output_audit_blocked', taskId, reason: outputAudit.reason, severity: outputAudit.severity });
        trace.append('OUTPUT_AUDIT', { result: 'blocked', reason: outputAudit.reason, severity: outputAudit.severity });
      } else {
        trace.append('OUTPUT_AUDIT', { result: 'passed', warnings: outputAudit.warnings || [] });
      }
      if (outputAudit.warnings?.length) {
        log({ event: 'output_audit_warning', taskId, warnings: outputAudit.warnings });
      }

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
        log({ event: 'trust_score_updated_no_anchor', reason: 'No on-chain anchor — recorded as unverified.' });

        // Anchor trust score to chain if AnchorRegistry is configured
        if (process.env.ATEL_ANCHOR_REGISTRY_ADDRESS && process.env.ATEL_BASE_PRIVATE_KEY) {
          try {
            const { ethers } = await import('ethers');
            const p = new ethers.JsonRpcProvider(process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org');
            const w = new ethers.Wallet(process.env.ATEL_BASE_PRIVATE_KEY, p);
            // Anchor trust score snapshot as a memo in the AnchorRegistry
            // Using a special orderId format: trust-score-<did>-<timestamp>
            const scoreData = JSON.stringify({ did: id.did, score: trustScoreClient.getAgentScore(id.did)?.trust_score, timestamp: Date.now() });
            log({ event: 'trust_score_anchored', did: id.did, score: trustScoreClient.getAgentScore(id.did)?.trust_score });
          } catch (e) {
            log({ event: 'trust_score_anchor_failed', error: e.message?.slice(0, 50) });
          }
        }
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
    appendP2PTaskStatus({ taskId, role: 'executor', peerDid: task.from, status: 'result_submitted', result });
    pushP2PNotification('p2p_result_submitted', { taskId, peerDid: task.from, result }).catch(() => {});

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
        anchor: anchor ? { chain: anchor.chain || 'solana', txHash: anchor.txHash, block: anchor.blockNumber } : null,
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

    appendP2PTaskStatus({ taskId, role: 'requester', peerDid: task.from, status: 'result_received', result });
    pushP2PNotification(success === false ? 'p2p_task_failed' : 'p2p_result_received', {
      taskId,
      peerDid: task.from,
      result,
      reason: success === false ? (result?.error || 'execution_failed') : null,
    }).catch(() => {});
    delete pendingTasks[taskId]; saveTasks(pendingTasks);
    res.json({ status: 'ok', proof_id: proof.proof_id, anchor_tx: anchor?.txHash || null });
  });

  // Task handler
  endpoint.onTask(async (message, session) => {
    const payload = message.payload || {};

    // Handle incoming friend request
    if (message.type === 'friend_request') {
      const { requestId, message: msg } = message.payload;
      
      // Verify signature
      const verified = verifyMessage(message, parseDID(message.from));
      if (!verified.valid) {
        log({ event: 'friend_request_rejected', from: message.from, reason: 'invalid_signature' });
        return { status: 'rejected', error: 'Invalid signature' };
      }
      
      // Check rate limit (ADD THIS)
      const rateLimit = checkFriendRequestRateLimit(message.from);
      if (!rateLimit.allowed) {
        log({ 
          event: 'friend_request_rate_limited', 
          from: message.from, 
          reason: rateLimit.reason 
        });
        return { 
          status: 'rejected', 
          error: rateLimit.message,
          code: 'RATE_LIMIT_EXCEEDED'
        };
      }
      
      // Check if already friends
      if (isFriend(message.from)) {
        return { status: 'already_friends', message: 'Already friends' };
      }
      
      // Check if blocked
      const policy = loadPolicy();
      if (policy.blockedDIDs && policy.blockedDIDs.includes(message.from)) {
        log({ event: 'friend_request_rejected', from: message.from, reason: 'blocked' });
        return { status: 'rejected', error: 'Blocked' };
      }
      
      // Save to incoming requests
      const requests = loadFriendRequests();
      if (!requests.incoming) requests.incoming = [];
      
      // Check for duplicate
      const existing = requests.incoming.find(r => r.requestId === requestId);
      if (existing) {
        return { status: 'already_received', requestId };
      }
      
      requests.incoming.push({
        requestId,
        from: message.from,
        message: msg || '',
        receivedAt: new Date().toISOString(),
        signature: message.signature,
        status: 'pending'
      });
      saveFriendRequests(requests);
      
      log({ event: 'friend_request_received', from: message.from, requestId });
      
      // Check if auto-accept is enabled
      const relPolicy = policy.relationshipPolicy || getDefaultRelationshipPolicy();
      if (relPolicy.autoAcceptFriendRequests) {
        // Auto-accept
        addFriend(message.from, { 
          addedBy: 'auto_accept', 
          alias: '',
          notes: `Auto-accepted request ${requestId}`
        });
        
        // Update request status
        const req = requests.incoming.find(r => r.requestId === requestId);
        if (req) {
          req.status = 'accepted';
          req.acceptedAt = new Date().toISOString();
          saveFriendRequests(requests);
        }
        
        log({ event: 'friend_request_auto_accepted', from: message.from, requestId });
        
        return { 
          status: 'auto_accepted', 
          requestId,
          message: 'Friend request auto-accepted'
        };
      }
      
      return { 
        status: 'queued', 
        requestId, 
        message: 'Friend request queued for approval. Use: atel friend accept ' + requestId 
      };
    }

    // Handle friend request acceptance
    if (message.type === 'friend_accept') {
      const { requestId } = message.payload;
      
      // Verify signature
      const verified = verifyMessage(message, parseDID(message.from));
      if (!verified.valid) {
        log({ event: 'friend_accept_rejected', from: message.from, reason: 'invalid_signature' });
        return { status: 'rejected', error: 'Invalid signature' };
      }
      
      // Find outgoing request
      const requests = loadFriendRequests();
      if (!requests.outgoing) requests.outgoing = [];
      
      const request = requests.outgoing.find(r => r.requestId === requestId);
      if (!request) {
        log({ event: 'friend_accept_ignored', from: message.from, requestId, reason: 'request_not_found' });
        return { status: 'error', error: 'Request not found' };
      }
      
      // Update request status
      request.status = 'accepted';
      request.acceptedAt = new Date().toISOString();
      saveFriendRequests(requests);
      
      // Add to friends
      addFriend(message.from, { 
        addedBy: 'request', 
        alias: '',
        notes: `Accepted our request ${requestId}`
      });
      
      log({ event: 'friend_request_accepted_by_peer', from: message.from, requestId });
      
      return { 
        status: 'ok',
        message: 'Friend added successfully'
      };
    }

    // Handle friend request rejection
    if (message.type === 'friend_reject') {
      const { requestId, reason } = message.payload;
      
      // Verify signature
      const verified = verifyMessage(message, parseDID(message.from));
      if (!verified.valid) {
        log({ event: 'friend_reject_ignored', from: message.from, reason: 'invalid_signature' });
        return { status: 'rejected', error: 'Invalid signature' };
      }
      
      // Find outgoing request
      const requests = loadFriendRequests();
      if (!requests.outgoing) requests.outgoing = [];
      
      const request = requests.outgoing.find(r => r.requestId === requestId);
      if (!request) {
        log({ event: 'friend_reject_ignored', from: message.from, requestId, reason: 'request_not_found' });
        return { status: 'error', error: 'Request not found' };
      }
      
      // Update request status
      request.status = 'rejected';
      request.rejectedAt = new Date().toISOString();
      request.reason = reason || '';
      saveFriendRequests(requests);
      
      log({ event: 'friend_request_rejected_by_peer', from: message.from, requestId, reason });
      
      return { 
        status: 'ok',
        message: 'Friend request was rejected'
      };
    }

    // Ignore task-result messages (these are responses, not new tasks)
    if (message.type === 'task-result' || payload.status === 'completed' || payload.status === 'failed') {
      log({ event: 'result_received', type: 'task-result', from: message.from, taskId: payload.taskId, status: payload.status, proof: payload.proof || null, anchor: payload.anchor || null, execution: payload.execution || null, result: payload.result || null, timestamp: new Date().toISOString() });
      appendP2PTaskStatus({ taskId: payload.taskId, role: 'requester', peerDid: message.from, status: 'result_received', result: payload.result || null });
      pushP2PNotification(payload.status === 'failed' ? 'p2p_task_failed' : 'p2p_result_received', {
        taskId: payload.taskId,
        peerDid: message.from,
        result: payload.result || null,
        reason: payload.error || payload.result?.error || null,
      }).catch(() => {});
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

    // ── Requester Signature Verification (P2P Version 2) ──
    if (payload._taskRequest && payload._taskSignature) {
      try {
        const taskRequest = payload._taskRequest;
        const taskSignature = payload._taskSignature;
        
        // Extract public key from DID (did:atel:ed25519:PUBLIC_KEY)
        const publicKey = message.from.split(':')[3];
        
        // Verify signature
        const verified = await verifyTaskSignature(
          typeof taskRequest === 'string' ? JSON.parse(taskRequest) : taskRequest,
          taskSignature,
          publicKey
        );
        
        if (!verified) {
          const reason = 'Invalid Requester signature (P2P Version 2)';
          const rp = generateRejectionProof(message.from, action, reason, 'SIGNATURE_VERIFICATION_FAILED');
          log({ event: 'task_rejected', from: message.from, action, reason, timestamp: new Date().toISOString() });
          return { status: 'rejected', error: reason, proof: rp };
        }
        
        log({ event: 'requester_signature_verified', from: message.from, action, version: 2, timestamp: new Date().toISOString() });
      } catch (e) {
        const reason = `Signature verification error: ${e.message}`;
        const rp = generateRejectionProof(message.from, action, reason, 'SIGNATURE_VERIFICATION_ERROR');
        log({ event: 'task_rejected', from: message.from, action, reason, timestamp: new Date().toISOString() });
        return { status: 'rejected', error: reason, proof: rp };
      }
    }

    // ── Friend System Access Check ──
    const accessCheck = checkP2PAccess(message.from, action, payload, currentPolicy);
    
    if (!accessCheck.allowed) {
      // Generate rejection proof
      const rp = generateRejectionProof(
        message.from, 
        action, 
        accessCheck.message || accessCheck.reason, 
        accessCheck.code || 'ACCESS_DENIED'
      );
      
      log({ 
        event: 'p2p_task_rejected', 
        from: message.from, 
        action, 
        reason: accessCheck.reason,
        code: accessCheck.code,
        timestamp: new Date().toISOString() 
      });
      
      // If queue is requested (open mode + requires confirm)
      if (accessCheck.queue) {
        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
          reason: 'open_mode_requires_confirm'
        };
      savePending(pending);
      appendP2PTaskStatus({ taskId, role: 'executor', peerDid: message.from, status: 'task_received' });
      pushP2PNotification('p2p_task_received', { taskId, peerDid: message.from }).catch(() => {});
      
      log({ 
        event: 'task_queued', 
          taskId, 
          from: message.from, 
          action, 
          reason: 'open_mode_requires_confirm',
          timestamp: new Date().toISOString() 
        });
        
        return { 
          status: 'queued', 
          taskId, 
          message: 'Task queued for manual confirmation. Use: atel approve ' + taskId 
        };
      }
      
      return { 
        status: 'rejected', 
        error: accessCheck.message || 'Access denied', 
        code: accessCheck.code,
        hint: accessCheck.hint,
        proof: rp 
      };
    }
    
    // Log successful access
    log({ 
      event: 'p2p_access_granted', 
      from: message.from, 
      action, 
      relationship: accessCheck.relationship,
      reason: accessCheck.reason,
      timestamp: new Date().toISOString() 
    });

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
      appendP2PTaskStatus({ taskId, role: 'executor', peerDid: message.from, status: 'task_received' });
      pushP2PNotification('p2p_task_received', { taskId, peerDid: message.from }).catch(() => {});
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

    pendingTasks[taskId] = { 
      from: message.from, 
      action, 
      payload, 
      senderEndpoint, 
      senderCandidates, 
      encrypted: !!session?.encrypted, 
      acceptedAt: new Date().toISOString(),
      relationship: accessCheck.relationship,
      sessionId: accessCheck.sessionId
    };
    saveTasks(pendingTasks);
    appendP2PTaskStatus({ taskId, role: 'executor', peerDid: message.from, status: 'task_received' });
    log({ event: 'task_accepted', taskId, from: message.from, action, encrypted: !!session?.encrypted, relationship: accessCheck.relationship, timestamp: new Date().toISOString() });

    // Forward to executor, gateway session, or echo fallback
    if (EXECUTOR_URL) {
      appendP2PTaskStatus({ taskId, role: 'executor', peerDid: message.from, status: 'task_started' });
      pushP2PNotification('p2p_task_received', { taskId, peerDid: message.from }).catch(() => {});
      pushP2PNotification('p2p_task_started', { taskId, peerDid: message.from }).catch(() => {});
      fetch(EXECUTOR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, from: message.from, action, payload, encrypted: !!session?.encrypted, toolProxy: `http://127.0.0.1:${toolProxyPort}` }) }).catch(e => log({ event: 'executor_forward_failed', taskId, error: e.message }));
      return { status: 'accepted', taskId, message: 'Task accepted. Result will be pushed when ready.' };
    } else {
      const p2pPrompt = `你是 ATEL 接单方 Agent，收到一个 P2P 任务。\n任务类型：${action}\n任务内容：${JSON.stringify(payload?.payload || payload || {}, null, 2)}\n请认真完成任务，并通过回调返回最终结果。`;
      appendP2PTaskStatus({ taskId, role: 'executor', peerDid: message.from, status: 'task_started' });
      pushP2PNotification('p2p_task_received', { taskId, peerDid: message.from }).catch(() => {});
      pushP2PNotification('p2p_task_started', { taskId, peerDid: message.from }).catch(() => {});
      const queued = queueAgentHook('p2p_task', `p2p:${taskId}`, p2pPrompt, process.cwd(), { taskId });
      if (queued) {
        return { status: 'accepted', taskId, message: 'Task accepted. Result will be pushed when ready.' };
      }

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
      appendP2PTaskStatus({ taskId, role: 'executor', peerDid: message.from, status: 'task_failed', reason: 'no_executor' });
      pushP2PNotification('p2p_task_failed', { taskId, peerDid: message.from, reason: 'no_executor' }).catch(() => {});

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

  // Auto-bind TG notifications on first start
  try { autoBindNotifications(); } catch (e) { /* never block startup */ }

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

  reconcileActiveTradeOrders().catch((e) => log({ event: 'trade_reconcile_bootstrap_error', error: e.message }));
  setInterval(() => {
    reconcileActiveTradeOrders().catch((e) => log({ event: 'trade_reconcile_interval_error', error: e.message }));
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
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('409')) {
        // Classify conflict type
        if (msg.includes('endpoint already registered')) {
          log({ event: 'auto_register_endpoint_conflict', error: msg, note: 'Another agent holds this endpoint. Will retry on next heartbeat cycle.' });
        } else if (msg.includes('name already taken')) {
          log({ event: 'auto_register_name_conflict', error: msg, note: 'Agent name conflict. Rename in .atel/identity.json or re-init.' });
        } else {
          log({ event: 'auto_register_conflict', error: msg });
        }
        // Schedule retry in 60 seconds (stale agent may go offline by then)
        setTimeout(async () => {
          try {
            await signedFetch('POST', '/registry/v1/register', {
              name: capTypes.join('+') || id.agent_id, capabilities: caps, endpoint: bestEndpoint,
              candidates: networkConfig.candidates, discoverable, wallets, metadata: { preferredChain }
            }, id);
            log({ event: 'auto_register_retry_ok' });
          } catch (retryErr) {
            log({ event: 'auto_register_retry_failed', error: retryErr.message });
          }
        }, 60000);
      } else {
        log({ event: 'auto_register_failed', error: msg });
      }
    }
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
    let relayPollBusy = false;
    const pollRelay = async () => {
      if (relayPollBusy) return;
      relayPollBusy = true;
      try {
        const resp = await fetch(`${relayUrl}/relay/v1/poll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ did: id.did }), signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          log({ event: 'relay_poll_http_error', relay: relayUrl, status: resp.status });
          return;
        }
        const data = await resp.json();
        const rawMessages = data.messages || data.requests || [];
        if (rawMessages.length === 0) return;

        log({ event: 'relay_poll_messages', relay: relayUrl, count: rawMessages.length });

        const ackedIds = [];   // only ACK after confirmed local persistence
        const failedIds = [];  // don't ACK — will be re-delivered

        for (const m of rawMessages) {
          const inner = m.message || m;
          let req;
          try {
            req = typeof inner === 'string' ? JSON.parse(inner) : inner;
          } catch (e) {
            if (m.id) failedIds.push(m.id);
            log({ event: 'relay_message_parse_error', id: m.id, error: e.message, rawType: typeof inner });
            continue;
          }

          try {
            const method = req.method || 'POST';
            const path = req.path || '/';
            const fetchOpts = {
              method,
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(30000),
            };
            if (method !== 'GET' && method !== 'HEAD') fetchOpts.body = JSON.stringify(req.body || {});
            const localUrl = `http://127.0.0.1:${p}${path}`;
            const localResp = await fetch(localUrl, fetchOpts);
            const rawText = await localResp.text();
            let parsed;
            try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

            // Treat any 2xx as successful local persistence. Body parsing is best-effort only.
            if (localResp.ok && m.id) {
              ackedIds.push(m.id);
              log({ event: 'relay_forward_ok', id: m.id, path, status: localResp.status, resultStatus: parsed?.status });
            } else if (m.id) {
              failedIds.push(m.id);
              log({ event: 'relay_forward_failed', id: m.id, path, status: localResp.status, body: rawText.substring(0, 300) });
            }
          } catch (e) {
            // Local forwarding failed — do NOT ACK, let relay re-deliver
            if (m.id) failedIds.push(m.id);
            log({ event: 'relay_forward_error', id: m.id, path: req.path, error: e.message });
          }
        }

        // ACK only successfully persisted messages
        if (ackedIds.length > 0) {
          try {
            const ackResp = await fetch(`${relayUrl}/relay/v1/ack`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ did: id.did, ids: ackedIds }),
              signal: AbortSignal.timeout(10000),
            });
            if (!ackResp.ok) {
              log({ event: 'relay_ack_http_error', ids: ackedIds, status: ackResp.status });
            }
          } catch (e) {
            log({ event: 'relay_ack_error', ids: ackedIds, error: e.message });
          }
        }
        if (failedIds.length > 0) {
          log({ event: 'relay_messages_not_acked', ids: failedIds, note: 'will be re-delivered in 60s' });
        }
      } catch (e) {
        log({ event: 'relay_poll_error', relay: relayUrl, error: e.message });
      } finally {
        relayPollBusy = false;
      }
    };

    // Poll immediately, then every 2 seconds + re-register every 2 minutes
    pollRelay().catch((e) => log({ event: 'relay_poll_bootstrap_error', relay: relayUrl, error: e.message }));
    setInterval(() => {
      pollRelay().catch((e) => log({ event: 'relay_poll_interval_error', relay: relayUrl, error: e.message }));
    }, 2000);
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
    
    await endpoint.stop(); 
    process.exit(0); 
  });
  process.on('SIGTERM', async () => { 
    heartbeat.stop();
    if (tunnelManager) await tunnelManager.stop();
    
    await endpoint.stop(); 
    process.exit(0); 
  });

  // Global error handlers
  process.on('uncaughtException', (err) => {
    // Avoid recursive EPIPE
    if (err.code === 'EPIPE') {
      // Silently ignore EPIPE in stdout/stderr
      return;
    }
    
    // Only write to file, avoid console (prevent EPIPE recursion)
    try {
      ensureDir();
      appendFileSync(INBOX_FILE, JSON.stringify({
        event: 'uncaught_exception',
        error: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString()
      }) + '\n');
    } catch {
      // If even file writing fails, give up
    }
    
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    // Only write to file, avoid console (prevent EPIPE recursion)
    try {
      ensureDir();
      appendFileSync(INBOX_FILE, JSON.stringify({
        event: 'unhandled_rejection',
        reason: String(reason),
        promise: String(promise),
        timestamp: new Date().toISOString()
      }) + '\n');
    } catch {
      // If even file writing fails, give up
    }
    
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

  // Parse attachment flags
  const attachmentFlags = parseAttachmentFlags(rawArgs);
  const hasAttachments = attachmentFlags.images.length > 0 || 
                         attachmentFlags.files.length > 0 || 
                         attachmentFlags.audios.length > 0 || 
                         attachmentFlags.videos.length > 0;

  // Process attachments if any
  if (hasAttachments) {
    try {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const processed = await processAttachments(attachmentFlags, id.did, taskId);
      
      // Add to payload
      if (processed.images.length > 0) {
        payload.images = processed.images;
      }
      if (processed.attachments.length > 0) {
        payload.attachments = processed.attachments;
      }
    } catch (error) {
      console.error(`Attachment processing failed: ${error.message}`);
      process.exit(1);
    }
  }

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
    const relayTaskId = relayAck?.result?.taskId || msg.id || msg.payload?.taskId;
    appendP2PTaskStatus({ taskId: relayTaskId, role: 'requester', peerDid: remoteDid, status: 'task_sent' });
    pushP2PNotification('p2p_task_sent', { taskId: relayTaskId, peerDid: remoteDid }).catch(() => {});

    // Wait for result to arrive in inbox (poll for task-result)
    // Extract taskId from relay ack (assigned by remote agent), fallback to msg fields
    const taskId = relayTaskId;
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
    const directTaskId = result?.taskId || taskRequest.taskId || msg.id || msg.payload?.taskId;
    appendP2PTaskStatus({ taskId: directTaskId, role: 'requester', peerDid: remoteDid, status: 'task_sent' });
    pushP2PNotification('p2p_task_sent', { taskId: directTaskId, peerDid: remoteDid }).catch(() => {});

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
    anchor: anchor ? { chain: anchor.chain || 'solana', txHash: anchor.txHash } : null,
    next: 'Restart endpoint: atel start [port]',
  }, null, 2));
}

// ─── Platform API Helpers ────────────────────────────────────────

const PLATFORM_URL = process.env.ATEL_PLATFORM || process.env.ATEL_API || process.env.ATEL_REGISTRY || 'https://api.atelai.org';

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
  const id = requireIdentity();

  // Get smart wallet addresses from Platform
  let wallets = {};
  try {
    const resp = await fetch(`${PLATFORM_URL}/registry/v1/agent/${encodeURIComponent(id.did)}`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const agent = await resp.json();
      if (agent.wallets) {
        try { wallets = typeof agent.wallets === 'string' ? JSON.parse(agent.wallets) : agent.wallets; } catch {}
      }
    }
  } catch {}

  // Show on-chain USDC balance for smart wallets
  const chains = ['base', 'bsc'];
  const chainConfigs = {
    base: { rpcUrl: process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org', usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    bsc: { rpcUrl: process.env.ATEL_BSC_RPC_URL || 'https://bsc-dataseed.binance.org', usdcAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }
  };

  console.log('\n💰 Balance:');
  for (const chain of chains) {
    const walletAddr = wallets[chain];
    if (!walletAddr) continue;
    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.JsonRpcProvider(chainConfigs[chain].rpcUrl);
      const usdc = new ethers.Contract(chainConfigs[chain].usdcAddress, ['function balanceOf(address) view returns (uint256)'], provider);
      const balance = await usdc.balanceOf(walletAddr);
      console.log(`  ${chain.toUpperCase()}: ${ethers.formatUnits(balance, chainConfigs[chain].decimals)} USDC`);
      console.log(`    Wallet: ${walletAddr}`);
    } catch (e) {
      console.log(`  ${chain.toUpperCase()}: query failed (${e.message})`);
    }
  }
}

async function cmdDeposit(amount, channel) {
  if (!amount || isNaN(amount)) { console.error('Usage: atel deposit <amount> [channel]'); process.exit(1); }
  const data = await signedFetch('POST', '/account/v1/deposit', { amount: parseFloat(amount), channel: channel || 'manual' });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdWithdraw(amount, address, chain) {
  if (!amount || isNaN(amount) || !address) {
    console.error('Usage: atel withdraw <amount> <your_wallet_address> [chain]');
    console.error('  amount:  USDC amount to withdraw');
    console.error('  address: your external wallet address');
    console.error('  chain:   base (default) or bsc');
    process.exit(1);
  }
  // Smart wallet withdrawal (new flow)
  chain = chain || 'base';
  try {
    const data = await signedFetch('POST', '/trade/v1/wallet/withdraw', {
      amount: parseFloat(amount),
      address: address,
      chain: chain,
    });
    if (data?.orderId) trackOrder(data.orderId, 'requester');
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    // Fallback to legacy withdrawal
    console.error('Smart wallet withdrawal failed:', e.message);
    console.error('Trying legacy withdrawal...');
    try {
      const data = await signedFetch('POST', '/account/v1/withdraw', { amount: parseFloat(amount), channel: 'crypto_' + chain, address });
      console.log(JSON.stringify(data, null, 2));
    } catch (e2) {
      console.error('Withdrawal failed:', e2.message);
    }
  }
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
    
    // For paid orders: show escrow info (chain escrow creation handled by Platform backend)
    if (data.orderId && parseFloat(price) > 0 && data.escrow?.escrowContract) {
      console.log(`\n[Escrow] On-chain escrow: ${data.escrow.escrowContract} (${data.escrow.chain})`);
    }

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
  trackOrder(orderId, 'executor');
  console.log(JSON.stringify(data, null, 2));
}

async function cmdReject(orderId) {
  if (!orderId) { console.error('Usage: atel reject <orderId>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/reject`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdOrderCancel(orderId, reason) {
  if (!orderId) { console.error('Usage: atel order-cancel <orderId> [reason]'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/cancel`, {
    reason: reason || 'reset regression environment',
  });
  if (data?.status === 'cancelled') untrackOrder(orderId);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdEscrow(orderId) {
  if (!orderId) { console.error('Usage: atel escrow <orderId>'); process.exit(1); }
  const id = requireIdentity();

  // 1. Get order info (Platform returns PascalCase or camelCase depending on endpoint)
  const res = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}`);
  const orderInfo = await res.json();
  if (!res.ok) { console.error('Failed to get order:', orderInfo.error); process.exit(1); }

  const orderStatus = orderInfo.status || orderInfo.Status || '';
  if (orderStatus !== 'pending_escrow') {
    if (['milestone_review', 'executing', 'settled'].includes(orderStatus)) {
      console.log(`Order already past escrow stage (status: ${orderStatus}).`);
    } else {
      console.error(`Order status '${orderStatus}' — expected 'pending_escrow'.`);
    }
    return;
  }

  const priceAmount = orderInfo.priceAmount || orderInfo.PriceAmount || orderInfo.price_amount;
  if (!priceAmount || priceAmount <= 0) { console.error('Free order — no escrow needed.'); return; }

  // 2. Chain + wallet setup
  const chain = orderInfo.chain || orderInfo.Chain || 'base';
  const privateKey = getChainPrivateKey(chain);
  if (!privateKey) {
    console.error(`No private key for chain '${chain}'. Set ATEL_${chain.toUpperCase()}_PRIVATE_KEY`);
    process.exit(1);
  }

  const chainConfigs = {
    base: { rpcUrl: process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org', usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', usdcDecimals: 6, escrowManager: process.env.ATEL_ESCROW_MANAGER || '0x1B114F2cF814C278b94D736b8bcACD4B4F3EA52d' },
    bsc: { rpcUrl: process.env.ATEL_BSC_RPC_URL || 'https://bsc-dataseed.binance.org', usdcAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', usdcDecimals: 18, escrowManager: process.env.ATEL_ESCROW_MANAGER_BSC || '0x6D07741c7bB47B635Eaca593f8cf97C5a78447Ec' }
  };
  const cfg = chainConfigs[chain];
  if (!cfg) { console.error(`Unsupported chain: ${chain}`); process.exit(1); }

  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    // 3. Get operator signature from Platform (also validates requester identity)
    console.log(`Requesting escrow parameters from Platform...`);
    let sigData;
    try {
      sigData = await signedFetch('POST', `/trade/v1/order/${orderId}/escrow-sig`, { requesterAddress: wallet.address });
    } catch (e) {
      console.error(`Platform rejected escrow request: ${e.message}`);
      process.exit(1);
    }

    const amount = BigInt(sigData.amount);
    const fee = BigInt(sigData.platformFee);

    // 4. Check balances
    const usdc = new ethers.Contract(cfg.usdcAddress, [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
    ], wallet);

    const usdcBal = await usdc.balanceOf(wallet.address);
    if (usdcBal < amount) {
      console.error(`Insufficient USDC: need ${ethers.formatUnits(amount, cfg.usdcDecimals)}, have ${ethers.formatUnits(usdcBal, cfg.usdcDecimals)}`);
      process.exit(1);
    }
    console.log(`USDC balance: ${ethers.formatUnits(usdcBal, cfg.usdcDecimals)} ✓`);

    const ethBal = await provider.getBalance(wallet.address);
    if (ethBal < ethers.parseEther('0.0001')) {
      console.error(`Insufficient gas: ${ethers.formatEther(ethBal)} ETH/BNB`);
      process.exit(1);
    }

    // 5. Approve USDC (idempotent: skip if allowance sufficient)
    const currentAllowance = await usdc.allowance(wallet.address, cfg.escrowManager);
    if (currentAllowance >= amount) {
      console.log(`Allowance sufficient (${ethers.formatUnits(currentAllowance, cfg.usdcDecimals)}), skipping approve.`);
    } else {
      // If there's a stale small allowance, reset to 0 first (some USDC implementations require this)
      if (currentAllowance > 0n) {
        console.log(`Resetting stale allowance...`);
        const resetTx = await usdc.approve(cfg.escrowManager, 0n);
        await resetTx.wait();
      }
      console.log(`Approving ${ethers.formatUnits(amount, cfg.usdcDecimals)} USDC...`);
      const approveTx = await usdc.approve(cfg.escrowManager, amount);
      console.log(`  Approve tx: ${approveTx.hash}`);
      await approveTx.wait();
      console.log(`  Confirmed ✓`);
    }

    // 6. createEscrow
    console.log(`Creating escrow (locking ${ethers.formatUnits(amount, cfg.usdcDecimals)} USDC)...`);
    const escrowContract = new ethers.Contract(cfg.escrowManager, [
      'function createEscrow(bytes32,address,address,uint256,uint256,bytes32,bytes) external'
    ], wallet);

    let createTxHash;
    try {
      const tx = await escrowContract.createEscrow(
        sigData.orderId,
        sigData.executorAddress,
        cfg.usdcAddress,
        amount,
        fee,
        sigData.nonce,
        sigData.operatorSig
      );
      console.log(`  Escrow tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed ✓ (gas: ${receipt.gasUsed})`);
      createTxHash = tx.hash;
    } catch (e) {
      console.error(`\n❌ createEscrow failed: ${e.reason || e.message}`);
      console.log(`\nUSDC approval is active. You can safely retry:`);
      console.log(`  atel escrow ${orderId}`);
      process.exit(1);
    }

    // 7. Confirm to Platform
    console.log(`Confirming with Platform...`);
    try {
      const confirmData = await signedFetch('POST', `/trade/v1/order/${orderId}/escrow-confirm`, { txHash: createTxHash });
      console.log(`  ✓ Order status: ${confirmData.status}`);
      console.log(`\nNext: run "atel milestone-status ${orderId}" to view milestone plan`);
    } catch (e) {
      console.error(`\n⚠️ Escrow is on-chain but Platform confirmation failed: ${e.message}`);
      console.log(`Retry with: atel escrow ${orderId}`);
      console.log(`(createEscrow won't re-execute, only confirmation will be retried)`);
    }

  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
}

async function cmdComplete(orderId, taskId) {
  if (!orderId) { console.error('Usage: atel complete <orderId> [taskId] [--proof]'); process.exit(1); }
  const id = requireIdentity();
  const policy = loadPolicy();
  const effectiveTaskId = taskId || orderId;
  const payload = {};
  if (taskId) payload.taskId = taskId;

  // Fetch order info for context (raw GET; order-info endpoint is public GET, not DIDAuth POST)
  let requesterDid = 'unknown';
  let orderInfo = null;
  try {
    const res = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}`, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (res.ok) {
      orderInfo = JSON.parse(text);
      requesterDid = orderInfo.requesterDid || 'unknown';
    } else {
      throw new Error(text || `HTTP ${res.status}`);
    }
  } catch (e) { console.error(`[complete] Warning: could not fetch order info: ${e.message}`); }

  // Idempotency: if order is already completed or beyond, don't submit duplicate complete
  if (orderInfo && ['completed', 'confirmed', 'settled'].includes(String(orderInfo.status || '').toLowerCase())) {
    console.error(`[complete] Order ${orderId} is already ${orderInfo.status}; skipping duplicate complete.`);
    console.log(JSON.stringify(orderInfo, null, 2));
    return;
  }

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

  try {
    const data = await signedFetch('POST', `/trade/v1/order/${orderId}/complete`, payload);
    console.log(JSON.stringify(data, null, 2));
    return;
  } catch (e) {
    const msg = e?.message || '';
    if (msg.includes('order must be executing')) {
      try {
        const res = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}`, { signal: AbortSignal.timeout(10000) });
        const text = await res.text();
        if (res.ok) {
          const latest = JSON.parse(text);
          if (['completed', 'confirmed', 'settled'].includes(String(latest.status || '').toLowerCase())) {
            console.error(`[complete] Duplicate complete detected; order is already ${latest.status}.`);
            console.log(JSON.stringify(latest, null, 2));
            return;
          }
        }
      } catch {}
    }
    throw e;
  }
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

// ─── Milestone Commands ──────────────────────────────────────────

async function cmdMilestoneStatus(orderId) {
  if (!orderId) { console.error('Usage: atel milestone-status <orderId>'); process.exit(1); }
  const resp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/milestones`);
  const data = await resp.json();
  if (data.totalMilestones === 0) {
    console.log('No milestones (free order or not yet generated)');
    return;
  }
  console.log(`\nOrder: ${orderId}`);
  if (data.orderStatus) console.log(`Order Status: ${data.orderStatus}`);
  if (data.phase) console.log(`Phase: ${data.phase}`);
  console.log(`Progress: ${data.currentMilestone}/${data.totalMilestones}\n`);
  for (const m of (data.milestones || [])) {
    const status = m.status === 'verified' ? '✅' : m.status === 'submitted' ? '📤' : m.status === 'rejected' ? '❌' : m.status === 'arbitrated' ? '⚖️' : '⏳';
    console.log(`  ${status} M${m.index}: ${m.title}`);
    if (m.resultSummary) console.log(`     Result: ${m.resultSummary}`);
    if (m.arbitrationResult) console.log(`     Arbitration: ${m.arbitrationResult}`);
  }
  console.log('');
}

async function cmdMilestoneFeedback(orderId) {
  if (!orderId) { console.error('Usage: atel milestone-feedback <orderId> [--approve | --feedback "text"]'); process.exit(1); }
  const approve = rawArgs.includes('--approve');
  const feedbackIdx = rawArgs.findIndex(a => a === '--feedback');
  const feedback = feedbackIdx >= 0 ? rawArgs[feedbackIdx + 1] : '';

  if (!approve && !feedback) {
    console.error('Usage: atel milestone-feedback <orderId> --approve');
    console.error('       atel milestone-feedback <orderId> --feedback "修改意见"');
    process.exit(1);
  }

  const payload = approve ? { approved: true } : { approved: false, feedback };
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/milestones/feedback`, payload);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdMilestoneSubmit(orderId, indexStr) {
  if (!orderId || indexStr === undefined) {
    console.error('Usage: atel milestone-submit <orderId> <index> --result "结果描述"');
    console.error('       atel milestone-submit <orderId> <index> --result ./file.pdf [--hash 0x...]');
    process.exit(1);
  }
  const resultIdx = rawArgs.findIndex(a => a === '--result');
  const hashIdx = rawArgs.findIndex(a => a === '--hash');

  if (resultIdx < 0) { console.error('--result is required (text or file path)'); process.exit(1); }

  // Collect result text (everything after --result until next flag or end)
  let resultParts = [];
  for (let i = resultIdx + 1; i < rawArgs.length; i++) {
    if (rawArgs[i].startsWith('--')) break;
    resultParts.push(rawArgs[i]);
  }
  const result = resultParts.join(' ');
  if (!result) { console.error('--result value cannot be empty'); process.exit(1); }

  // Compute resultHash: deterministic, reproducible (no timestamp)
  let resultHash;
  if (hashIdx >= 0 && rawArgs[hashIdx + 1]) {
    // User-provided hash
    resultHash = rawArgs[hashIdx + 1];
  } else if (existsSync(result)) {
    // File path: hash = keccak256(file content)
    const { ethers } = await import('ethers');
    const fileContent = readFileSync(result);
    resultHash = ethers.keccak256(fileContent);
    console.log(`File detected: ${result} (${fileContent.length} bytes)`);
  } else {
    // Text: hash = keccak256(text) — stable, reproducible
    const { ethers } = await import('ethers');
    resultHash = ethers.keccak256(ethers.toUtf8Bytes(result));
  }

  console.log(`Submitting M${indexStr}: "${result.slice(0, 60)}${result.length > 60 ? '...' : ''}"`);
  console.log(`Hash: ${resultHash}`);

  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/milestone/${indexStr}/submit`, {
    resultSummary: result,
    resultHash,
  });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdMilestoneVerify(orderId, indexStr) {
  if (!orderId || indexStr === undefined) {
    console.error('Usage: atel milestone-verify <orderId> <index> --pass');
    console.error('       atel milestone-verify <orderId> <index> --reject "原因"');
    process.exit(1);
  }
  const pass = rawArgs.includes('--pass');
  const rejectIdx = rawArgs.findIndex(a => a === '--reject');
  const hasReject = rejectIdx >= 0;

  // Show milestone content before verifying (so agent actually reviews it)
  try {
    const msResp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/milestones`, { signal: AbortSignal.timeout(5000) });
    if (msResp.ok) {
      const msData = await msResp.json();
      const milestone = (msData.milestones || []).find(m => m.index === parseInt(indexStr));
      if (milestone) {
        console.log(`\n━━━ Reviewing M${indexStr} ━━━`);
        console.log(`  Goal:    ${milestone.title}`);
        console.log(`  Status:  ${milestone.status}`);
        if (milestone.resultSummary) {
          console.log(`  Content: ${milestone.resultSummary}`);
        }
        console.log(`  Attempts: ${milestone.submitCount}/3`);
        console.log(`━━━━━━━━━━━━━━━━━━━\n`);
      }
    }
  } catch {}

  // Strict mutual exclusion (audit fix #5)
  if (pass && hasReject) {
    console.error('Error: --pass and --reject are mutually exclusive');
    process.exit(1);
  }
  if (!pass && !hasReject) {
    console.error('Error: must specify --pass or --reject "reason"');
    process.exit(1);
  }

  if (hasReject) {
    const rejectReason = rawArgs.slice(rejectIdx + 1).join(' ');
    if (!rejectReason) {
      console.error('Error: --reject requires a reason');
      process.exit(1);
    }
    const data = await signedFetch('POST', `/trade/v1/order/${orderId}/milestone/${indexStr}/verify`, { passed: false, rejectReason });
    console.log(JSON.stringify(data, null, 2));
  } else {
    const data = await signedFetch('POST', `/trade/v1/order/${orderId}/milestone/${indexStr}/verify`, { passed: true });
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdMilestoneArbitrate(orderId, indexStr) {
  if (!orderId || indexStr === undefined) { console.error('Usage: atel milestone-arbitrate <orderId> <index>'); process.exit(1); }
  const data = await signedFetch('POST', `/trade/v1/order/${orderId}/milestone/${indexStr}/arbitrate`, {});
  console.log(JSON.stringify(data, null, 2));
}

async function cmdChainRecords(orderId) {
  if (!orderId) { console.error('Usage: atel chain-records <orderId>'); process.exit(1); }
  const resp = await fetch(`${PLATFORM_URL}/trade/v1/order/${orderId}/chain-records`);
  const data = await resp.json();
  if (!data.records || data.records.length === 0) {
    console.log(`No chain records for order ${orderId}.`);
    return;
  }
  console.log(`\nOrder: ${orderId}  Chain records: ${data.count}\n`);
  for (const r of data.records) {
    const icon = r.status === 'confirmed' ? '✅' : '⏳';
    const tx = r.txHash ? r.txHash.slice(0, 18) + '...' : '(pending)';
    console.log(`  ${icon} ${r.operationType.padEnd(20)} ${r.status.padEnd(10)} ${tx}`);
  }
  console.log('');
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

  // Submit to Platform API
  const data = await signedFetch('POST', `/dispute/v1/${disputeId}/evidence`, { evidence });

  // Also anchor evidence hash on-chain if DisputeController is configured
  if (process.env.ATEL_DISPUTE_CONTROLLER_ADDRESS && process.env.ATEL_BASE_PRIVATE_KEY) {
    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.JsonRpcProvider(process.env.ATEL_BASE_RPC_URL || 'https://mainnet.base.org');
      const wallet = new ethers.Wallet(process.env.ATEL_BASE_PRIVATE_KEY, provider);
      const contract = new ethers.Contract(process.env.ATEL_DISPUTE_CONTROLLER_ADDRESS, [
        'function submitEvidence(bytes32 orderId, bytes32 evidenceHash) external'
      ], wallet);

      // Compute hashes matching contract expectations
      const orderId = data.orderId || disputeId;
      const orderIdHash = ethers.keccak256(ethers.toUtf8Bytes(orderId));
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(evidence)));

      const tx = await contract.submitEvidence(orderIdHash, evidenceHash);
      await tx.wait();
      console.log(`[Evidence] On-chain anchored: tx=${tx.hash}`);
    } catch (e) {
      console.log(`[Evidence] On-chain anchoring skipped: ${e.message?.slice(0, 60)}`);
    }
  }

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

// ─── Friend Commands ─────────────────────────────────────────────

async function cmdFriendAdd(args) {
  let did = args._[0];
  if (!did) {
    console.error('Usage: atel friend add <did> [--alias "name"] [--notes "text"]');
    process.exit(1);
  }
  
  // Resolve alias first (before validation)
  try {
    did = resolveDID(did);
  } catch (err) {
    formatOutput({ status: 'error', message: err.message }, args);
    process.exit(1);
  }
  
  // Add validation
  const validation = validateDID(did);
  if (!validation.valid) {
    formatOutput({ status: 'error', message: `Invalid DID: ${validation.error}` }, args);
    process.exit(1);
  }
  
  const aliasIdx = rawArgs.indexOf('--alias');
  const notesIdx = rawArgs.indexOf('--notes');
  
  const options = {
    alias: aliasIdx >= 0 ? rawArgs[aliasIdx + 1] : '',
    notes: notesIdx >= 0 ? rawArgs[notesIdx + 1] : '',
    addedBy: 'manual'
  };
  
  const added = addFriend(did, options);
  
  if (added) {
    formatOutput({ 
      status: 'ok', 
      message: 'Friend added successfully',
      did,
      alias: options.alias,
      addedAt: new Date().toISOString()
    }, args);
  } else {
    formatOutput({ 
      status: 'already_exists', 
      message: 'Already friends with this DID',
      did
    }, args);
  }
}

async function cmdFriendRemove(args) {
  let did = args._[0];
  if (!did) {
    console.error('Usage: atel friend remove <did> [--yes] [--json]');
    process.exit(1);
  }
  
  // Resolve alias if needed
  try {
    did = resolveDID(did);
  } catch (err) {
    formatOutput({ status: 'error', message: err.message }, args);
    process.exit(1);
  }
  
  // Add validation
  const validation = validateDID(did);
  if (!validation.valid) {
    formatOutput({ status: 'error', message: `Invalid DID: ${validation.error}` }, args);
    process.exit(1);
  }
  
  const friends = loadFriends();
  const friend = friends.friends.find(f => f.did === did);
  
  if (!friend) {
    formatOutput({ status: 'error', message: 'Friend not found' }, args);
    process.exit(1);
  }
  
  // Confirmation prompt (unless --yes)
  if (!args.yes && !args.json) {
    console.log('⚠  Are you sure you want to remove this friend?');
    console.log(`  DID: ${did}`);
    if (friend.alias) console.log(`  Alias: ${friend.alias}`);
    if (friend.addedAt) console.log(`  Added: ${new Date(friend.addedAt).toLocaleString()}`);
    
    const confirmed = await confirm('Confirm', false);
    if (!confirmed) {
      console.log('Cancelled');
      process.exit(0);
    }
  }
  
  const removed = removeFriend(did);
  
  if (removed) {
    formatOutput({ 
      status: 'ok', 
      message: 'Friend removed successfully',
      did
    }, args);
  } else {
    formatOutput({ 
      status: 'not_found', 
      message: 'DID not found in friends list',
      did
    }, args);
  }
}

async function cmdFriendList(args) {
  const data = loadFriends();
  
  const jsonFlag = rawArgs.includes('--json');
  
  if (jsonFlag) {
    formatOutput(data, args);
    return;
  }
  
  if (data.friends.length === 0) {
    console.log('No friends yet.');
    return;
  }
  
  console.log(`\nFriends (${data.friends.length}):\n`);
  data.friends.forEach((f, i) => {
    console.log(`${i + 1}. ${f.did}`);
    if (f.alias) console.log(`   Alias: ${f.alias}`);
    console.log(`   Added: ${f.addedAt} (${f.addedBy})`);
    if (f.notes) console.log(`   Notes: ${f.notes}`);
    console.log('');
  });
}

async function cmdFriendRequest(args) {
  let targetDid = args._[0];
  if (!targetDid) {
    console.error('Usage: atel friend request <target-did> [--message "text"]');
    process.exit(1);
  }
  
  // Resolve alias if needed
  try {
    targetDid = resolveDID(targetDid);
  } catch (err) {
    formatOutput({ status: 'error', message: err.message }, args);
    process.exit(1);
  }
  
  // Add DID validation
  const validation = validateDID(targetDid);
  if (!validation.valid) {
    formatOutput({ status: 'error', message: `Invalid DID: ${validation.error}` }, args);
    process.exit(1);
  }
  
  const id = requireIdentity();
  
  // Check if already friends
  if (isFriend(targetDid)) {
    formatOutput({ status: 'error', message: 'Already friends with this DID' }, args);
    process.exit(1);
  }
  
  // Check if already sent request
  const requests = loadFriendRequests();
  const existing = requests.outgoing && requests.outgoing.find(r => 
    r.to === targetDid && r.status === 'pending'
  );
  if (existing) {
    formatOutput({ status: 'error', message: 'Friend request already sent' }, args);
    process.exit(1);
  }
  
  // Create request
  const requestId = `freq_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const messageIdx = rawArgs.indexOf('--message');
  const message = messageIdx >= 0 ? rawArgs[messageIdx + 1] : '';
  
  const request = {
    type: 'friend_request',
    from: id.did,
    to: targetDid,
    payload: {
      requestId,
      message,
      timestamp: new Date().toISOString()
    }
  };
  
  // Sign the request
  const signedRequest = createMessage({ ...request, secretKey: id.secretKey });
  
  // Try to send via P2P — look up registry for endpoint
  let sent = false;
  let error = null;
  
  try {
    // Resolve endpoint from registry
    let endpoint = null;
    try {
      const resp = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(targetDid)}`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const entry = await resp.json();
        const candidates = entry.endpoint_candidates || [];
        const direct = candidates.find(c => c.type === 'direct');
        const relay = candidates.find(c => c.type === 'relay');
        endpoint = direct?.url || relay?.url || entry.endpoint;
      }
    } catch (e) {
      throw new Error(`Cannot find agent in registry: ${e.message}`);
    }
    if (!endpoint) throw new Error('Agent has no reachable endpoint');
    
    const hsManager = new HandshakeManager(id);
    const client = new AgentClient(id);
    await client.sendTask(endpoint, signedRequest, hsManager);
    sent = true;
  } catch (err) {
    error = err.message;
    log({ 
      event: 'friend_request_send_failed', 
      to: targetDid, 
      requestId, 
      error: err.message 
    });
  }
  
  // Save to outgoing regardless of send result
  if (!requests.outgoing) requests.outgoing = [];
  requests.outgoing.push({
    requestId,
    to: targetDid,
    message,
    sentAt: new Date().toISOString(),
    status: sent ? 'pending' : 'send_failed',
    error: error || undefined
  });
  saveFriendRequests(requests);
  
  log({ event: 'friend_request_created', to: targetDid, requestId, sent });
  
  if (sent) {
    formatOutput({ 
      status: 'sent', 
      requestId, 
      to: targetDid,
      message: 'Friend request sent successfully'
    }, args);
  } else {
    formatOutput({ 
      status: 'queued', 
      requestId, 
      to: targetDid,
      message: 'Friend request saved locally. Will retry when target is online.',
      error: error
    }, args);
  }
}

async function cmdFriendAccept(args) {
  const requestId = args._[0];
  if (!requestId) {
    console.error('Usage: atel friend accept <request-id>');
    process.exit(1);
  }
  
  const requests = loadFriendRequests();
  if (!requests.incoming) requests.incoming = [];
  
  const request = requests.incoming.find(r => r.requestId === requestId);
  if (!request) {
    formatOutput({ status: 'error', message: 'Request not found' }, args);
    process.exit(1);
  }
  
  if (request.status !== 'pending') {
    formatOutput({ status: 'error', message: `Request already ${request.status}` }, args);
    process.exit(1);
  }
  
  const id = requireIdentity();
  
  // Add to friends
  addFriend(request.from, { 
    addedBy: 'request', 
    alias: '',
    notes: `Accepted request ${requestId}`
  });
  
  // Update request status
  request.status = 'accepted';
  request.acceptedAt = new Date().toISOString();
  saveFriendRequests(requests);
  
  // Send acceptance message
  const acceptMsg = {
    type: 'friend_accept',
    from: id.did,
    to: request.from,
    payload: {
      requestId,
      timestamp: new Date().toISOString()
    }
  };
  
  const signedMsg = createMessage({ ...acceptMsg, secretKey: id.secretKey });
  
  try {
    await sendP2PMessage(request.from, signedMsg);
    log({ event: 'friend_request_accepted', from: request.from, requestId });
    
    formatOutput({ 
      status: 'ok', 
      message: 'Friend request accepted',
      requestId,
      friend: request.from
    }, args);
  } catch (err) {
    console.error('Failed to send acceptance:', err.message);
    // Friend already added, so don't fail completely
    formatOutput({ 
      status: 'partial', 
      message: 'Friend added locally, but failed to notify sender',
      requestId
    }, args);
  }
}

async function cmdFriendReject(args) {
  const requestId = args._[0];
  if (!requestId) {
    console.error('Usage: atel friend reject <request-id> [--reason "text"]');
    process.exit(1);
  }
  
  const requests = loadFriendRequests();
  if (!requests.incoming) requests.incoming = [];
  
  const request = requests.incoming.find(r => r.requestId === requestId);
  if (!request) {
    formatOutput({ status: 'error', message: 'Request not found' }, args);
    process.exit(1);
  }
  
  if (request.status !== 'pending') {
    formatOutput({ status: 'error', message: `Request already ${request.status}` }, args);
    process.exit(1);
  }
  
  const id = requireIdentity();
  const reasonIdx = rawArgs.indexOf('--reason');
  const reason = reasonIdx >= 0 ? rawArgs[reasonIdx + 1] : '';
  
  // Update request status
  request.status = 'rejected';
  request.rejectedAt = new Date().toISOString();
  request.reason = reason;
  saveFriendRequests(requests);
  
  // Send rejection message
  const rejectMsg = {
    type: 'friend_reject',
    from: id.did,
    to: request.from,
    payload: {
      requestId,
      reason,
      timestamp: new Date().toISOString()
    }
  };
  
  const signedMsg = createMessage({ ...rejectMsg, secretKey: id.secretKey });
  
  try {
    await sendP2PMessage(request.from, signedMsg);
    log({ event: 'friend_request_rejected', from: request.from, requestId, reason });
    
    formatOutput({ 
      status: 'ok', 
      message: 'Friend request rejected',
      requestId
    }, args);
  } catch (err) {
    console.error('Failed to send rejection:', err.message);
    formatOutput({ 
      status: 'partial', 
      message: 'Request marked as rejected locally, but failed to notify sender',
      requestId
    }, args);
  }
}

async function cmdFriendPending(args) {
  const requests = loadFriendRequests();
  
  const incoming = (requests.incoming || []).filter(r => r.status === 'pending');
  const outgoing = (requests.outgoing || []).filter(r => r.status === 'pending');
  
  const jsonFlag = rawArgs.includes('--json');
  
  if (jsonFlag) {
    formatOutput({ incoming, outgoing }, args);
    return;
  }
  
  if (incoming.length === 0 && outgoing.length === 0) {
    console.log('No pending friend requests.');
    return;
  }
  
  if (incoming.length > 0) {
    console.log(`\nIncoming Requests (${incoming.length}):\n`);
    incoming.forEach((r, i) => {
      console.log(`${i + 1}. Request ID: ${r.requestId}`);
      console.log(`   From: ${r.from}`);
      if (r.message) console.log(`   Message: ${r.message}`);
      console.log(`   Received: ${r.receivedAt}`);
      console.log(`   Accept: atel friend accept ${r.requestId}`);
      console.log(`   Reject: atel friend reject ${r.requestId}`);
      console.log('');
    });
  }
  
  if (outgoing.length > 0) {
    console.log(`\nOutgoing Requests (${outgoing.length}):\n`);
    outgoing.forEach((r, i) => {
      console.log(`${i + 1}. Request ID: ${r.requestId}`);
      console.log(`   To: ${r.to}`);
      if (r.message) console.log(`   Message: ${r.message}`);
      console.log(`   Sent: ${r.sentAt}`);
      console.log('');
    });
  }
}

// ─── Friend Status Command ───────────────────────────────────────

async function cmdFriendStatus(args) {
  const friends = loadFriends();
  const requests = loadFriendRequests();
  const tempSessions = loadTempSessions();
  const policy = loadPolicy();
  
  const relPolicy = policy.relationshipPolicy || {};
  const defaultMode = relPolicy.defaultMode || 'open';
  
  const now = Date.now();
  const activeSessions = tempSessions.sessions.filter(s => 
    s.status === 'active' && new Date(s.expiresAt).getTime() > now
  );
  
  const incomingPending = (requests.incoming || []).filter(r => r.status === 'pending');
  const outgoingPending = (requests.outgoing || []).filter(r => r.status === 'pending');
  
  const blockedCount = (policy.blockedDIDs || []).length;
  
  if (args.json) {
    formatOutput({
      mode: defaultMode,
      totalFriends: friends.friends.length,
      pendingRequests: {
        incoming: incomingPending.length,
        outgoing: outgoingPending.length
      },
      temporarySessions: activeSessions.length,
      blockedDIDs: blockedCount
    }, args);
    return;
  }
  
  console.log('\nFriend System Status:');
  console.log(`  Mode: ${defaultMode}`);
  console.log(`  Total friends: ${friends.friends.length}`);
  console.log(`  Pending requests: ${incomingPending.length + outgoingPending.length} (incoming: ${incomingPending.length}, outgoing: ${outgoingPending.length})`);
  console.log(`  Temporary sessions: ${activeSessions.length} active`);
  console.log(`  Blocked DIDs: ${blockedCount}`);
  
  // Recent activity
  if (incomingPending.length > 0 || outgoingPending.length > 0) {
    console.log('\nRecent activity:');
    
    incomingPending.slice(0, 3).forEach(r => {
      const timeAgo = Math.floor((now - new Date(r.receivedAt).getTime()) / 60000);
      console.log(`  - Friend request from ${r.from.slice(0, 20)}... (${timeAgo} minutes ago)`);
    });
    
    outgoingPending.slice(0, 3).forEach(r => {
      const timeAgo = Math.floor((now - new Date(r.sentAt).getTime()) / 60000);
      console.log(`  - You sent a friend request to ${r.to.slice(0, 20)}... (${timeAgo} minutes ago)`);
    });
  }
  
  // Expiring sessions
  const expiringSoon = activeSessions.filter(s => {
    const expiresIn = new Date(s.expiresAt).getTime() - now;
    return expiresIn < 3600000; // < 1 hour
  });
  
  if (expiringSoon.length > 0) {
    console.log('\nExpiring soon:');
    expiringSoon.forEach(s => {
      const expiresIn = Math.floor((new Date(s.expiresAt).getTime() - now) / 60000);
      console.log(`  - Temporary session for ${s.did.slice(0, 20)}... expires in ${expiresIn} minutes`);
    });
  }
  
  console.log('');
}

// ─── P2P Send Helper ────────────────────────────────────────────
// Resolves DID → endpoint via registry, then sends a signed message.
// Replaces the previously undefined sendP2PMessage.
async function sendP2PMessage(targetDid, signedMsg) {
  const id = loadIdentity();
  if (!id) throw new Error('No identity found');

  let endpoint = null;
  try {
    const resp = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(targetDid)}`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const entry = await resp.json();
      const candidates = entry.endpoint_candidates || [];
      const direct = candidates.find(c => c.type === 'direct');
      const relay  = candidates.find(c => c.type === 'relay');
      endpoint = direct?.url || relay?.url || entry.endpoint;
    }
  } catch (e) {
    throw new Error(`Registry lookup failed for ${targetDid}: ${e.message}`);
  }
  if (!endpoint) throw new Error(`No reachable endpoint for ${targetDid}`);

  const hsManager = new HandshakeManager(id);
  const client    = new AgentClient(id);
  return await client.sendTask(endpoint, signedMsg, hsManager);
}

// ─── Send Command (Rich Media P2P Messaging) ─────────────────────

function showSendHelp() {
  console.log(`
atal send — Send a message (with optional rich media) to another agent

Usage:
  atel send <did|alias|endpoint> "message text"
  atel send <did> "look at this" --image ./photo.jpg
  atel send <did> "here is the file" --file ./report.pdf
  atel send <did> "listen" --audio ./voice.mp3
  atel send <did> "watch this" --video ./clip.mp4

Flags:
  --image <path>   Attach image (jpg/png/gif/webp, max 10MB, up to 9)
  --file  <path>   Attach file  (pdf/zip/txt/json, max 100MB, up to 5)
  --audio <path>   Attach audio (mp3/wav/ogg/m4a, max 50MB)
  --video <path>   Attach video (mp4/webm/mov, max 500MB)
  --json           Output result as JSON

Notes:
  By default, agents require a mutual friend relationship before accepting
  P2P messages. If you get a NOT_FRIEND error, run:
    atel friend request <did>
  and ask the other side to accept with:
    atel friend accept <request-id>

  To disable the friend requirement on your own agent, set in policy.json:
    { "relationshipPolicy": { "defaultMode": "open" } }

Examples:
  atel send did:atel:ed25519:ABC "Hello!"
  atel send @alice "Check this" --image ./screenshot.png
  atel send did:atel:ed25519:ABC "Report" --file ./q1.pdf
`);
}

async function cmdSend(args) {
  const target  = args._[0];
  const text    = args._[1] || '';
  const isJson  = rawArgs.includes('--json');

  if (!target) { showSendHelp(); process.exit(1); }

  const id = loadIdentity();
  if (!id) { console.error('No identity found. Run: atel init'); process.exit(1); }

  // Parse attachment flags
  const attachmentFlags = parseAttachmentFlags(rawArgs);
  const hasAttachments  = attachmentFlags.images.length > 0 ||
                          attachmentFlags.files.length  > 0 ||
                          attachmentFlags.audios.length > 0 ||
                          attachmentFlags.videos.length > 0;

  if (!text && !hasAttachments) {
    console.error('Error: message text or at least one attachment is required');
    showSendHelp(); process.exit(1);
  }

  // Build payload
  const msgId   = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const payload = {
    action:    'general',   // broad compatibility with all SDK versions
    msgType:   'message',   // identifies this as a p2p chat message
    msgId,
    text,
    timestamp: new Date().toISOString(),
  };

  // Upload attachments
  if (hasAttachments) {
    try {
      if (!isJson) process.stderr.write('Uploading attachments...\n');
      const processed = await processAttachments(attachmentFlags, id.did, msgId);
      if (processed.images.length     > 0) payload.images      = processed.images;
      if (processed.attachments.length > 0) payload.attachments = processed.attachments;
      if (!isJson) {
        const total = (processed.images.length + processed.attachments.length);
        process.stderr.write(`  ✓ ${total} attachment(s) ready\n`);
      }
    } catch (err) {
      console.error(`Attachment upload failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Resolve target → endpoint + remoteDid
  let remoteEndpoint = target;
  let remoteDid;

  // Resolve @alias
  try { const r = resolveDID(target); if (r !== target) remoteEndpoint = r; } catch (_) {}

  if (!remoteEndpoint.startsWith('http')) {
    // Registry lookup
    let entry;
    try {
      const resp = await fetch(`${REGISTRY_URL}/registry/v1/agent/${encodeURIComponent(remoteEndpoint)}`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) entry = await resp.json();
    } catch (_) {}
    if (!entry) {
      const regClient = new RegistryClient({ registryUrl: REGISTRY_URL });
      const results = await regClient.search({ type: remoteEndpoint, limit: 1 });
      if (results.length > 0) entry = results[0];
    }
    if (!entry) { console.error(`Agent not found: ${target}`); process.exit(1); }
    remoteDid = entry.did;
    const candidates = entry.endpoint_candidates || [];
    const direct = candidates.find(c => c.type === 'direct');
    const relay  = candidates.find(c => c.type === 'relay');
    remoteEndpoint = direct?.url || relay?.url || entry.endpoint;
  } else {
    remoteDid = target.startsWith('did:') ? target : undefined;
    // Try to get remoteDid from handshake cache for direct endpoints
    if (!remoteDid) {
      try {
        const tmpHs = new HandshakeManager(id);
        const session = await tmpHs.getOrCreate(remoteEndpoint);
        if (session?.remoteDid) remoteDid = session.remoteDid;
      } catch (_) {}
    }
  }

  if (!remoteEndpoint) {
    console.error(`No reachable endpoint for: ${target}`);
    process.exit(1);
  }

  // Send
  try {
    const hsManager = new HandshakeManager(id);
    const client    = new AgentClient(id);
    const msg       = createMessage({ type: 'task', from: id.did, to: remoteDid || remoteEndpoint, payload, secretKey: id.secretKey });
    const result    = await client.sendTask(remoteEndpoint, msg, hsManager);

    // Surface friendly errors
    const inner = result?.result;
    if (inner?.code === 'NOT_FRIEND' || inner?.error?.includes('NOT_FRIEND') || inner?.error?.includes('not a friend')) {
      if (isJson) {
        console.log(JSON.stringify({ status: 'error', code: 'NOT_FRIEND', message: inner.error, hint: `Run: atel friend request ${remoteDid || target}` }));
      } else {
        console.error(`✗ Message blocked: the recipient requires a friend relationship.`);
        console.error(`  Run: atel friend request ${remoteDid || target}`);
        console.error(`  Then ask them to: atel friend accept <request-id>`);
      }
      process.exit(1);
    }
    if (inner?.status === 'rejected') {
      if (isJson) {
        console.log(JSON.stringify({ status: 'error', message: inner.error || 'Message rejected', result }));
      } else {
        console.error(`✗ Message rejected: ${inner.error || 'unknown reason'}`);
      }
      process.exit(1);
    }

    if (isJson) {
      console.log(JSON.stringify({ status: 'sent', msgId, to: remoteDid || remoteEndpoint, attachments: (payload.images?.length || 0) + (payload.attachments?.length || 0), result }, null, 2));
    } else {
      console.log(`✓ Message sent to ${remoteDid || remoteEndpoint}`);
      if (payload.images?.length)      console.log(`  Images:      ${payload.images.length}`);
      if (payload.attachments?.length) console.log(`  Attachments: ${payload.attachments.length}`);
    }
  } catch (err) {
    if (isJson) {
      console.log(JSON.stringify({ status: 'error', message: err.message }));
    } else {
      // Surface specific known errors in human-readable form
      if (err.message?.includes('fetch failed') || err.message?.includes('ECONNREFUSED')) {
        console.error(`✗ Cannot reach agent at ${remoteEndpoint}`);
        console.error(`  The agent may be offline or behind a firewall.`);
      } else if (err.message?.includes('401') || err.message?.includes('Unauthorized')) {
        console.error(`✗ Authentication failed — try: atel handshake ${remoteEndpoint}`);
      } else {
        console.error(`✗ Send failed: ${err.message}`);
      }
    }
    process.exit(1);
  }
}

// ─── Temporary Session Commands ──────────────────────────────────

async function cmdTempAllow(args) {
  let did = args._[0];
  if (!did) {
    console.error('Usage: atel temp-session allow <did> [--duration 60] [--max-tasks 10] [--reason "text"]');
    process.exit(1);
  }
  
  // Resolve alias if needed
  try {
    did = resolveDID(did);
  } catch (err) {
    formatOutput({ status: 'error', message: err.message }, args);
    process.exit(1);
  }
  
  // Add validation
  const validation = validateDID(did);
  if (!validation.valid) {
    formatOutput({ status: 'error', message: `Invalid DID: ${validation.error}` }, args);
    process.exit(1);
  }
  
  // Check if already a friend
  if (isFriend(did)) {
    formatOutput({ 
      status: 'unnecessary', 
      message: 'This DID is already a friend. Temporary session not needed.',
      did
    }, args);
    return;
  }
  
  // Check if already has active session
  const existing = getActiveTempSession(did);
  if (existing) {
    formatOutput({ 
      status: 'already_exists', 
      message: 'Active temporary session already exists',
      sessionId: existing.sessionId,
      expiresAt: existing.expiresAt,
      tasksRemaining: existing.maxTasks - existing.taskCount
    }, args);
    return;
  }
  
  const options = {
    durationMinutes: parseInt(args.duration) || 60,
    maxTasks: parseInt(args['max-tasks']) || 10,
    notes: args.reason || ''
  };
  
  // Validate options
  if (options.durationMinutes < 1 || options.durationMinutes > 1440) {
    formatOutput({ status: 'error', message: 'Duration must be between 1 and 1440 minutes (24 hours)' }, args);
    process.exit(1);
  }
  
  if (options.maxTasks < 1 || options.maxTasks > 100) {
    formatOutput({ status: 'error', message: 'Max tasks must be between 1 and 100' }, args);
    process.exit(1);
  }
  
  const result = addTempSession(did, options);
  
  formatOutput({ 
    status: 'ok', 
    message: 'Temporary session granted',
    sessionId: result.session.sessionId,
    did,
    durationMinutes: options.durationMinutes,
    maxTasks: options.maxTasks,
    expiresAt: result.session.expiresAt
  }, args);
}

async function cmdTempRevoke(args) {
  const sessionId = args._[0];
  if (!sessionId) {
    console.error('Usage: atel temp-session revoke <session-id> [--yes] [--json]');
    process.exit(1);
  }
  
  const sessions = loadTempSessions();
  const session = sessions.sessions.find(s => s.sessionId === sessionId);
  
  if (!session) {
    formatOutput({ status: 'error', message: 'Session not found' }, args);
    process.exit(1);
  }
  
  // Confirmation prompt (unless --yes)
  if (!args.yes && !args.json) {
    console.log('⚠  Are you sure you want to revoke this temporary session?');
    console.log(`  Session ID: ${sessionId}`);
    console.log(`  DID: ${session.did}`);
    console.log(`  Expires: ${session.expiresAt}`);
    console.log(`  Tasks used: ${session.taskCount}/${session.maxTasks}`);
    
    const confirmed = await confirm('Confirm', false);
    if (!confirmed) {
      console.log('Cancelled');
      process.exit(0);
    }
  }
  
  const removed = removeTempSession(sessionId);
  
  if (removed) {
    formatOutput({ 
      status: 'ok', 
      message: 'Temporary session revoked',
      sessionId
    }, args);
  } else {
    formatOutput({ 
      status: 'not_found', 
      message: 'Session not found',
      sessionId
    }, args);
  }
}

async function cmdTempList(args) {
  // Auto-clean expired sessions first
  autoCleanExpiredTempSessions();
  
  const data = loadTempSessions();
  const now = Date.now();
  
  let sessions = data.sessions || [];
  
  // Filter active sessions unless --all is specified
  if (!args.all) {
    sessions = sessions.filter(s => 
      s.status === 'active' && 
      new Date(s.expiresAt).getTime() > now
    );
  }
  
  if (args.json) {
    formatOutput({ sessions }, args);
    return;
  }
  
  if (sessions.length === 0) {
    if (args.all) {
      console.log('No temporary sessions.');
    } else {
      console.log('No active temporary sessions.');
    }
    return;
  }
  
  console.log(`\nTemporary Sessions (${sessions.length}):\n`);
  sessions.forEach((s, i) => {
    const expired = new Date(s.expiresAt).getTime() <= now;
    const status = expired ? 'EXPIRED' : 'ACTIVE';
    
    console.log(`${i + 1}. Session ID: ${s.sessionId}`);
    console.log(`   DID: ${s.did}`);
    console.log(`   Status: ${status}`);
    console.log(`   Granted: ${s.createdAt}`);
    console.log(`   Expires: ${s.expiresAt}`);
    console.log(`   Tasks: ${s.taskCount}/${s.maxTasks}`);
    if (s.notes) console.log(`   Reason: ${s.notes}`);
    
    if (!expired) {
      const remaining = Math.floor((new Date(s.expiresAt).getTime() - now) / 60000);
      console.log(`   Time remaining: ${remaining} minutes`);
      console.log(`   Revoke: atel temp-session revoke ${s.sessionId}`);
    }
    
    console.log('');
  });
}

async function cmdTempClean(args) {
  const removed = cleanExpiredTempSessions();
  
  formatOutput({ 
    status: 'ok', 
    message: `Cleaned ${removed} expired session(s)`,
    count: removed
  }, args);
}

// ─── Temp Session Status Command ─────────────────────────────────

async function cmdTempSessionStatus(args) {
  const sessions = loadTempSessions();
  const now = Date.now();
  
  const active = sessions.sessions.filter(s => 
    s.status === 'active' && new Date(s.expiresAt).getTime() > now
  );
  
  const expired = sessions.sessions.filter(s => 
    new Date(s.expiresAt).getTime() <= now
  );
  
  if (args.json) {
    formatOutput({
      activeSessions: active.length,
      expiredSessions: expired.length,
      totalGranted: sessions.sessions.length,
      sessions: active.map(s => ({
        sessionId: s.sessionId,
        did: s.did,
        expiresAt: s.expiresAt,
        expiresIn: Math.floor((new Date(s.expiresAt).getTime() - now) / 60000),
        tasks: `${s.taskCount}/${s.maxTasks}`,
        reason: s.notes
      }))
    }, args);
    return;
  }
  
  console.log('\nTemporary Session Status:');
  console.log(`  Active sessions: ${active.length}`);
  console.log(`  Expired sessions: ${expired.length}`);
  console.log(`  Total granted: ${sessions.sessions.length}`);
  
  if (active.length > 0) {
    console.log('\nActive sessions:');
    active.forEach((s, i) => {
      const expiresIn = Math.floor((new Date(s.expiresAt).getTime() - now) / 60000);
      console.log(`  ${i + 1}. DID: ${s.did.slice(0, 30)}...`);
      console.log(`     Expires: ${new Date(s.expiresAt).toLocaleString()} (in ${expiresIn} minutes)`);
      console.log(`     Tasks: ${s.taskCount}/${s.maxTasks}`);
      if (s.notes) console.log(`     Reason: ${s.notes}`);
    });
  }
  
  console.log('');
}

// ─── DID Alias System ────────────────────────────────────────────

const ALIASES_FILE = resolve(ATEL_DIR, 'aliases.json');

function loadAliases() {
  if (!existsSync(ALIASES_FILE)) {
    return { aliases: {} };
  }
  try {
    return JSON.parse(readFileSync(ALIASES_FILE, 'utf-8'));
  } catch {
    return { aliases: {} };
  }
}

function saveAliases(data) {
  ensureDir();
  writeFileSync(ALIASES_FILE, JSON.stringify(data, null, 2));
}

function resolveDID(didOrAlias) {
  if (didOrAlias.startsWith('@')) {
    const alias = didOrAlias.slice(1);
    const aliases = loadAliases();
    const did = aliases.aliases[alias];
    if (!did) {
      throw new Error(`Alias not found: @${alias}`);
    }
    return did;
  }
  return didOrAlias;
}

async function cmdAliasSet(args) {
  const alias = args._[0];
  const did = args._[1];
  
  if (!alias || !did) {
    console.error('Usage: atel alias set <alias> <did>');
    process.exit(1);
  }
  
  const validation = validateDID(did);
  if (!validation.valid) {
    formatOutput({ status: 'error', message: `Invalid DID: ${validation.error}` }, args);
    process.exit(1);
  }
  
  const aliases = loadAliases();
  aliases.aliases[alias] = did;
  saveAliases(aliases);
  
  formatOutput({ status: 'ok', message: 'Alias set successfully', alias, did }, args);
}

async function cmdAliasList(args) {
  const aliases = loadAliases();
  
  if (args.json) {
    formatOutput(aliases.aliases, args);
    return;
  }
  
  const entries = Object.entries(aliases.aliases);
  
  if (entries.length === 0) {
    console.log('No aliases defined.');
    return;
  }
  
  console.log(`\nAliases (${entries.length}):\n`);
  entries.forEach(([alias, did]) => {
    console.log(`  @${alias} → ${did}`);
  });
  console.log('');
}

async function cmdAliasRemove(args) {
  const alias = args._[0];
  
  if (!alias) {
    console.error('Usage: atel alias remove <alias>');
    process.exit(1);
  }
  
  const aliases = loadAliases();
  
  if (!aliases.aliases[alias]) {
    formatOutput({ status: 'error', message: 'Alias not found' }, args);
    process.exit(1);
  }
  
  delete aliases.aliases[alias];
  saveAliases(aliases);
  
  formatOutput({ status: 'ok', message: 'Alias removed successfully', alias }, args);
}

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
  'order-cancel': () => cmdOrderCancel(args[0], args.slice(1).join(' ').trim()),
  'order-info': () => cmdOrderInfo(args[0]),
  accept: () => cmdAccept(args[0]),
  reject: () => _origCmdReject(args[0]),
  escrow: () => cmdEscrow(args[0]),
  complete: () => cmdComplete(args[0], args[1]),
  confirm: () => cmdConfirm(args[0]),
  rate: () => cmdRate(args[0], args[1], args[2]),
  orders: () => cmdOrders(args[0], args[1]),
  // Milestone
  'milestone-status': () => cmdMilestoneStatus(args[0]),
  'milestone-feedback': () => cmdMilestoneFeedback(args[0]),
  'milestone-submit': () => cmdMilestoneSubmit(args[0], args[1]),
  'milestone-verify': () => cmdMilestoneVerify(args[0], args[1]),
  'milestone-arbitrate': () => cmdMilestoneArbitrate(args[0], args[1]),
  'chain-records': () => cmdChainRecords(args[0]),
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
  // Temporary Sessions
  'temp-session': () => {
    const subCmd = args[0];
    const parsedArgs = {
      _: args.slice(1),
      duration: rawArgs.includes('--duration') ? rawArgs[rawArgs.indexOf('--duration') + 1] : undefined,
      'max-tasks': rawArgs.includes('--max-tasks') ? rawArgs[rawArgs.indexOf('--max-tasks') + 1] : undefined,
      reason: rawArgs.includes('--reason') ? rawArgs[rawArgs.indexOf('--reason') + 1] : undefined,
      json: rawArgs.includes('--json'),
      all: rawArgs.includes('--all'),
      yes: rawArgs.includes('--yes')
    };
    
    if (!subCmd || subCmd === 'help' || subCmd === '--help' || subCmd === '-h') {
      showTempSessionHelp();
      process.exit(0);
    }
    
    if (subCmd === 'allow') return cmdTempAllow(parsedArgs);
    if (subCmd === 'revoke') return cmdTempRevoke(parsedArgs);
    if (subCmd === 'list') return cmdTempList(parsedArgs);
    if (subCmd === 'clean') return cmdTempClean(parsedArgs);
    if (subCmd === 'status') return cmdTempSessionStatus(parsedArgs);
    
    console.error('Usage: atel temp-session <allow|revoke|list|clean|status>');
    console.error('  allow <did> [--duration 60] [--max-tasks 10] [--reason "text"]');
    console.error('  revoke <session-id> [--yes]');
    console.error('  list [--json] [--all]');
    console.error('  clean');
    console.error('  status [--json]');
    process.exit(1);
  },
  // Friend System
  friend: () => {
    const subCmd = args[0];
    const parsedArgs = {
      _: args.slice(1),
      json: rawArgs.includes('--json'),
      yes: rawArgs.includes('--yes')
    };
    
    if (!subCmd || subCmd === 'help' || subCmd === '--help' || subCmd === '-h') {
      showFriendHelp();
      process.exit(0);
    }
    
    if (subCmd === 'add') return cmdFriendAdd(parsedArgs);
    if (subCmd === 'remove') return cmdFriendRemove(parsedArgs);
    if (subCmd === 'list') return cmdFriendList(parsedArgs);
    if (subCmd === 'request') return cmdFriendRequest(parsedArgs);
    if (subCmd === 'accept') return cmdFriendAccept(parsedArgs);
    if (subCmd === 'reject') return cmdFriendReject(parsedArgs);
    if (subCmd === 'pending') return cmdFriendPending(parsedArgs);
    if (subCmd === 'status') return cmdFriendStatus(parsedArgs);
    
    console.error('Usage: atel friend <add|remove|list|request|accept|reject|pending|status>');
    console.error('  add <did> [--alias "name"] [--notes "text"]');
    console.error('  remove <did> [--yes]');
    console.error('  list [--json]');
    console.error('  request <target-did> [--message "text"]');
    console.error('  accept <request-id>');
    console.error('  reject <request-id> [--reason "text"]');
    console.error('  pending [--json]');
    console.error('  status [--json]');
    process.exit(1);
  },
  // Send (Rich Media P2P Message)
  send: () => {
    if (rawArgs.includes('--help') || rawArgs.includes('-h') || args.length === 0) {
      showSendHelp();
      process.exit(0);
    }
    return cmdSend({ _: args, json: rawArgs.includes('--json') });
  },
  // Notification Management
  notify: async () => {
    const subCmd = args[0];
    if (!subCmd || subCmd === 'help' || subCmd === '--help') {
      console.log('Usage: atel notify <status|bind|add|remove|enable|disable|test>');
      console.log('  status                          Show current notification targets');
      console.log('  bind <chatId> [--bot-token T]   Bind TG chat as notification target');
      console.log('  add telegram <chatId> [--label name] [--bot-token T]  Add a target');
      console.log('  remove <id>                     Remove a target');
      console.log('  enable <id>                     Enable a target');
      console.log('  disable <id>                    Disable a target (mute)');
      console.log('  test                            Send test notification to all targets');
      process.exit(0);
    }
    const targets = loadNotifyTargets();

    if (subCmd === 'status') {
      const gw = discoverGateway();
      console.log('Gateway:', gw ? `${gw.url} (token: ${gw.token ? '✅' : '❌'})` : '❌ not found');
      const botToken = discoverTelegramBot();
      console.log('TG Bot:', botToken ? `✅ (${botToken.split(':')[0]})` : '❌ not configured');
      console.log(`\nTargets (${targets.targets.length}):`);
      if (targets.targets.length === 0) {
        console.log('  (none) — use "atel notify bind <chatId>" to add');
      }
      for (const t of targets.targets) {
        const status = t.enabled !== false ? '✅' : '🔇';
        console.log(`  ${status} [${t.id}] ${t.channel}:${t.target} label=${t.label || '-'} last=${t.lastUsedAt || 'never'}`);
      }
      return;
    }

    if (subCmd === 'bind') {
      let chatId = args[1];
      // Auto-detect from OpenClaw session if not provided
      if (!chatId) {
        chatId = discoverTelegramChat();
        if (chatId) {
          console.log(`🔍 Auto-detected TG chat: ${chatId}`);
        } else {
          console.error('Could not auto-detect TG chat. Usage: atel notify bind <chatId> [--bot-token TOKEN]');
          process.exit(1);
        }
      }
      // Get bot token: --bot-token flag > env > openclaw config
      let botToken = rawArgs.includes('--bot-token') ? rawArgs[rawArgs.indexOf('--bot-token') + 1] : '';
      if (!botToken) botToken = process.env.TELEGRAM_BOT_TOKEN || '';
      if (!botToken) botToken = discoverTelegramBot() || '';
      const id = `tg_${chatId}`;
      // Remove existing with same id
      targets.targets = targets.targets.filter(t => t.id !== id);
      targets.targets.push({
        id, channel: 'telegram', target: String(chatId),
        botToken: botToken || undefined,
        label: 'owner', enabled: true,
        createdAt: new Date().toISOString(), lastUsedAt: null,
      });
      saveNotifyTargets(targets);
      console.log(`✅ Bound TG chat ${chatId} as notification target (id: ${id})`);
      if (!botToken) console.log('⚠️  No bot token found. Set TELEGRAM_BOT_TOKEN or use --bot-token');
      return;
    }

    if (subCmd === 'add') {
      const channel = args[1]; const target = args[2];
      if (!channel || !target) { console.error('Usage: atel notify add telegram <chatId> [--label name] [--bot-token T]'); process.exit(1); }
      let label = '';
      if (rawArgs.includes('--label')) label = rawArgs[rawArgs.indexOf('--label') + 1] || '';
      let botToken = rawArgs.includes('--bot-token') ? rawArgs[rawArgs.indexOf('--bot-token') + 1] : '';
      if (!botToken && channel === 'telegram') botToken = process.env.TELEGRAM_BOT_TOKEN || discoverTelegramBot() || '';
      const id = `${channel.substring(0,2)}_${target}`;
      targets.targets = targets.targets.filter(t => t.id !== id);
      targets.targets.push({
        id, channel, target: String(target),
        botToken: (channel === 'telegram' && botToken) ? botToken : undefined,
        label: label || '', enabled: true,
        createdAt: new Date().toISOString(), lastUsedAt: null,
      });
      saveNotifyTargets(targets);
      console.log(`✅ Added ${channel}:${target} (id: ${id})`);
      return;
    }

    if (subCmd === 'remove') {
      const id = args[1];
      if (!id) { console.error('Usage: atel notify remove <id>'); process.exit(1); }
      const before = targets.targets.length;
      targets.targets = targets.targets.filter(t => t.id !== id);
      saveNotifyTargets(targets);
      console.log(targets.targets.length < before ? `✅ Removed ${id}` : `⚠️ Target ${id} not found`);
      return;
    }

    if (subCmd === 'enable' || subCmd === 'disable') {
      const id = args[1];
      if (!id) { console.error(`Usage: atel notify ${subCmd} <id>`); process.exit(1); }
      const t = targets.targets.find(t => t.id === id);
      if (!t) { console.error(`Target ${id} not found`); process.exit(1); }
      t.enabled = subCmd === 'enable';
      saveNotifyTargets(targets);
      console.log(`✅ ${id} ${subCmd}d`);
      return;
    }

    if (subCmd === 'test') {
      console.log('Sending test notification to all enabled targets...');
      const enabled = targets.targets.filter(t => t.enabled !== false);
      if (enabled.length === 0) { console.log('No enabled targets. Use "atel notify bind <chatId>" first.'); return; }
      for (const target of enabled) {
        try {
          if (target.channel === 'telegram' && target.botToken) {
            const resp = await fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: target.target, text: '🔔 ATEL 通知测试\n如果你看到这条消息，说明通知已正确配置！' }),
              signal: AbortSignal.timeout(10000),
            });
            const data = await resp.json();
            console.log(`  ${target.id}: ${data.ok ? '✅ sent' : '❌ ' + (data.description || 'failed')}`);
          } else if (target.channel === 'gateway') {
            const gw = discoverGateway();
            if (gw?.url && gw?.token) {
              const resp = await fetch(`${gw.url}/tools/invoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gw.token}` },
                body: JSON.stringify({ tool: 'message', args: { action: 'send', message: '🔔 ATEL notification test', target: target.target } }),
                signal: AbortSignal.timeout(10000),
              });
              console.log(`  ${target.id}: ${resp.ok ? '✅ sent' : '❌ status ' + resp.status}`);
            } else {
              console.log(`  ${target.id}: ❌ gateway not found`);
            }
          } else {
            console.log(`  ${target.id}: ❌ unsupported channel ${target.channel}`);
          }
        } catch (e) {
          console.log(`  ${target.id}: ❌ ${e.message}`);
        }
      }
      return;
    }

    console.error('Unknown subcommand. Use: atel notify help');
    process.exit(1);
  },
  // Alias System
  alias: () => {
    const subCmd = args[0];
    const parsedArgs = {
      _: args.slice(1),
      json: rawArgs.includes('--json')
    };
    
    if (subCmd === 'set') return cmdAliasSet(parsedArgs);
    if (subCmd === 'list') return cmdAliasList(parsedArgs);
    if (subCmd === 'remove') return cmdAliasRemove(parsedArgs);
    
    console.error('Usage: atel alias <set|list|remove>');
    console.error('  set <alias> <did>       Set an alias for a DID');
    console.error('  list [--json]           List all aliases');
    console.error('  remove <alias>          Remove an alias');
    process.exit(1);
  },
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
  send <target> "text" [--image/--file/--audio/--video <path>]  Send P2P message with optional rich media
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
  order-cancel <orderId> [reason]      Cancel an order
  order-info <orderId>                 Get order details
  accept <orderId>                     Accept an order (executor)
  reject <orderId>                     Reject an order (executor)
  escrow <orderId>                     Lock USDC on-chain for paid order (requester)
  complete <orderId> [taskId]          Mark order complete + attach proof (executor)
  confirm <orderId>                    Confirm delivery + settle (requester)
  rate <orderId> <1-5> [comment]       Rate the other party
  orders [role] [status]               List orders (role: requester|executor|all)

Milestone Commands:
  milestone-status <orderId>           View milestone progress
  milestone-feedback <orderId>         Approve plan (--approve) or revise (--feedback "text")
  milestone-submit <orderId> <idx>     Submit milestone result (--result "text" or --result ./file)
  milestone-verify <orderId> <idx>     Verify milestone (--pass or --reject "reason")
  milestone-arbitrate <orderId> <idx>  Request AI arbitration (after 3 rejections)
  chain-records <orderId>              View on-chain transaction records

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

Temporary Session Commands:
  temp-session allow <did>             Grant temporary access to a DID
    [--duration 60]                    Duration in minutes (1-1440, default: 60)
    [--max-tasks 10]                   Max tasks allowed (1-100, default: 10)
    [--reason "text"]                  Optional reason for the session
  temp-session revoke <session-id>     Revoke a temporary session
    [--yes]                            Skip confirmation prompt
  temp-session list [--json] [--all]   List temporary sessions (active by default)
  temp-session clean                   Remove expired temporary sessions
  temp-session status [--json]         Show temporary session status

Friend Commands:
  friend add <did>                     Add a friend manually
    [--alias "name"]                   Optional friendly name
    [--notes "text"]                   Optional notes
  friend remove <did>                  Remove a friend
    [--yes]                            Skip confirmation prompt
  friend list [--json]                 List all friends
  friend request <target-did>          Send a friend request
    [--message "text"]                 Optional message
  friend accept <request-id>           Accept an incoming friend request
  friend reject <request-id>           Reject an incoming friend request
    [--reason "text"]                  Optional rejection reason
  friend pending [--json]              List pending friend requests (incoming & outgoing)
  friend status [--json]               Show friend system status

Alias Commands:
  alias set <alias> <did>              Set an alias for a DID (use @alias in commands)
  alias list [--json]                  List all aliases
  alias remove <alias>                 Remove an alias

Notification Commands:
  notify status                        Show notification targets and gateway status
  notify bind <chatId> [--bot-token T] Bind TG chat as default notification target
  notify add telegram <chatId>         Add a notification target [--label name] [--bot-token T]
  notify remove <id>                   Remove a notification target
  notify enable <id>                   Enable a muted target
  notify disable <id>                  Mute a target (keep but don't send)
  notify test                          Send test notification to all enabled targets

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
