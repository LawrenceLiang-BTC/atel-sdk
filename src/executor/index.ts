/**
 * Module: Built-in Executor
 *
 * Default executor that bridges ATEL tasks to OpenClaw agent sessions.
 * Automatically started by `atel start` when no external ATEL_EXECUTOR_URL is set.
 *
 * Flow:
 *   1. Receives task from ATEL endpoint
 *   2. Reads agent-context.md for shared context (if exists)
 *   3. Calls OpenClaw Gateway → sessions_spawn
 *   4. Polls for result via sessions_history
 *   5. Callbacks result to ATEL endpoint
 *
 * Security:
 *   - Business-layer payload audit (capability mismatch, fs ops, network, code exec)
 *   - Configurable via policy.json
 *   - Agent context file provides identity without exposing private data
 */

import express from 'express';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';

// ─── Types ───────────────────────────────────────────────────────

export interface BuiltinExecutorConfig {
  /** Port to listen on */
  port: number;
  /** ATEL agent callback URL (for result delivery) */
  callbackUrl: string;
  /** OpenClaw Gateway URL */
  gatewayUrl?: string;
  /** OpenClaw Gateway auth token */
  gatewayToken?: string;
  /** Path to agent-context.md (optional shared context) */
  contextPath?: string;
  /** ToolGateway proxy URL (optional) */
  toolProxyUrl?: string;
  /** Logger function */
  log?: (obj: Record<string, unknown>) => void;
}

export interface ExecutorAuditResult {
  safe: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface TaskRequest {
  taskId: string;
  from: string;
  action: string;
  payload: Record<string, unknown>;
  toolProxy?: string;
}

// ─── Built-in Executor ──────────────────────────────────────────

export class BuiltinExecutor {
  private app: ReturnType<typeof express>;
  private server: Server | null = null;
  private config: Required<Pick<BuiltinExecutorConfig, 'port' | 'callbackUrl'>> & BuiltinExecutorConfig;
  private agentContext: string = '';
  private taskHistoryPath: string = '';
  private log: (obj: Record<string, unknown>) => void;

  constructor(config: BuiltinExecutorConfig) {
    this.config = {
      gatewayUrl: 'http://127.0.0.1:18789',
      gatewayToken: '',
      contextPath: '',
      toolProxyUrl: '',
      ...config,
    };

    this.log = config.log || ((obj) => console.log(`[Executor] ${JSON.stringify(obj)}`));

    // Auto-detect gateway token
    if (!this.config.gatewayToken) {
      try {
        const home = process.env.HOME || '';
        const c = JSON.parse(readFileSync(join(home, '.openclaw/openclaw.json'), 'utf-8'));
        this.config.gatewayToken = c.gateway?.auth?.token || '';
      } catch { /* ignore */ }
    }

    // Load agent context
    this.loadContext();

    // Task history path
    this.taskHistoryPath = join(process.cwd(), '.atel', 'task-history.md');

    // Setup express
    this.app = express();
    this.app.use(express.json({ limit: '1mb' }));
    this.setupRoutes();
  }

  private loadContext(): void {
    // Try multiple paths for agent context
    const paths = [
      this.config.contextPath,
      join(process.cwd(), '.atel', 'agent-context.md'),
      join(process.cwd(), 'agent-context.md'),
    ].filter(Boolean) as string[];

    for (const p of paths) {
      if (existsSync(p)) {
        this.agentContext = readFileSync(p, 'utf-8');
        this.log({ event: 'context_loaded', path: p, size: this.agentContext.length });
        return;
      }
    }
    this.log({ event: 'context_not_found', note: 'No agent-context.md found, tasks will run without shared context' });
  }

  private loadTaskHistory(limit: number = 10): string {
    try {
      if (!existsSync(this.taskHistoryPath)) return '';
      const content = readFileSync(this.taskHistoryPath, 'utf-8');
      // Get last N entries (each entry starts with "### ")
      const entries = content.split(/(?=^### )/m).filter(e => e.trim());
      const recent = entries.slice(-limit).join('\n');
      if (recent) {
        this.log({ event: 'history_loaded', entries: entries.length, using: Math.min(entries.length, limit) });
      }
      return recent;
    } catch { return ''; }
  }

  private saveTaskHistory(taskId: string, from: string, action: string, payload: Record<string, unknown>, result: unknown, success: boolean): void {
    try {
      const timestamp = new Date().toISOString();
      const text = (payload.text || payload.message || payload.task || payload.query || '') as string;
      const resultText = typeof result === 'object' && result !== null
        ? ((result as Record<string, unknown>).response || JSON.stringify(result)).toString().slice(0, 200)
        : String(result).slice(0, 200);

      const entry = `### ${timestamp} | ${action} | from: ${from.slice(-8)}
- Task: ${text.slice(0, 150)}
- Result: ${success ? resultText : 'FAILED'}
- Status: ${success ? 'success' : 'failed'}

`;
      appendFileSync(this.taskHistoryPath, entry);
      this.log({ event: 'history_saved', taskId });
    } catch (e: unknown) {
      this.log({ event: 'history_save_failed', taskId, error: (e as Error).message });
    }
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', type: 'builtin-executor', gateway: this.config.gatewayUrl, hasContext: !!this.agentContext });
    });

    this.app.post('/', async (req, res) => {
      const { taskId, from, action, payload, toolProxy } = req.body as TaskRequest;
      this.log({ event: 'task_received', taskId, from, action, toolProxy: toolProxy || 'none' });

      // Respond immediately
      res.json({ status: 'accepted', taskId });

      // Process async
      this.processTask({ taskId, from, action, payload, toolProxy: toolProxy || this.config.toolProxyUrl || '' });
    });
  }

  private async processTask(task: TaskRequest): Promise<void> {
    const { taskId, from, action, payload, toolProxy } = task;

    try {
      // ── ToolGateway init ──
      if (toolProxy) {
        this.log({ event: 'toolgateway_init', taskId });
        await fetch(`${toolProxy}/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        });
      }

      // ── Security audit ──
      const audit = this.auditPayload(action, payload);
      if (!audit.safe) {
        this.log({ event: 'task_rejected', taskId, reason: audit.reason });
        if (toolProxy) {
          await this.finalizeTool(toolProxy, taskId, false, { error: `Security: ${audit.reason}` });
        }
        await this.callback(taskId, { error: `Security: ${audit.reason}`, severity: audit.severity }, false);
        return;
      }

      // ── Build prompt with context ──
      const prompt = this.buildPrompt(from, action, payload);
      this.log({ event: 'executing', taskId, promptLength: prompt.length });

      // ── Execute via OpenClaw Gateway ──
      let result: unknown;
      if (toolProxy) {
        result = await this.executeViaTool(toolProxy, taskId, prompt, action, from);
      } else {
        result = await this.executeDirect(prompt, taskId);
      }

      this.log({ event: 'task_completed', taskId });

      // ── Save task history ──
      this.saveTaskHistory(taskId, from, action, payload, result, true);

      // ── Finalize trace ──
      let trace = null;
      if (toolProxy) {
        trace = await this.finalizeTool(toolProxy, taskId, true, result);
      }

      // ── Callback ──
      await this.callback(taskId, result, true, trace);

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log({ event: 'task_failed', taskId, error: msg });

      // Save failed task to history
      this.saveTaskHistory(taskId, from, action, payload, { error: msg }, false);

      if (toolProxy) {
        await this.finalizeTool(toolProxy, taskId, false, { error: msg }).catch(() => {});
      }
      await this.callback(taskId, { error: msg }, false).catch(() => {});
    }
  }

  private buildPrompt(from: string, action: string, payload: Record<string, unknown>): string {
    const text = (payload.text || payload.message || payload.task || payload.query || JSON.stringify(payload)) as string;

    const guides: Record<string, string> = {
      translation: `Translate the following text to ${payload.target_lang || 'the target language'}. Return only the translation.`,
      coding: 'Help with the following coding task. Provide working code with brief explanation.',
      research: 'Research the following topic and provide useful, accurate information.',
      general: 'Complete the following task.',
    };

    const guide = guides[action] || guides.general;

    let prompt = '';
    if (this.agentContext) {
      prompt += `## Agent Context\n${this.agentContext}\n\n`;
    }
    const history = this.loadTaskHistory();
    if (history) {
      prompt += `## Recent Task History\n${history}\n\n`;
    }
    prompt += `## Task\n${guide}\n\n${text}`;

    return prompt;
  }

  private async executeDirect(prompt: string, taskId: string): Promise<unknown> {
    const { gatewayUrl, gatewayToken } = this.config;

    // Result file: sub-session writes result here, we poll for it
    const resultDir = join(process.cwd(), '.atel', 'results');
    try { mkdirSync(resultDir, { recursive: true }); } catch { /* exists */ }
    const resultFile = join(resultDir, `${taskId}.json`);

    // Wrap prompt: instruct sub-agent to write result to file
    const wrappedPrompt = `${prompt}

IMPORTANT: After completing the task, you MUST write your final answer to this file using the write tool:
File: ${resultFile}
Write ONLY a JSON object: {"done":true,"response":"<your answer here>"}
Do not include any other text in the file. This is required for the result to be delivered.`;

    // Spawn sub-session via Gateway HTTP API
    const spawnResp = await fetch(`${gatewayUrl}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        tool: 'sessions_spawn',
        args: { task: wrappedPrompt, runTimeoutSeconds: 120 },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!spawnResp.ok) {
      const errText = await spawnResp.text();
      if (errText.includes('not_found') || errText.includes('not available')) {
        throw new Error('sessions_spawn not available via Gateway HTTP API. Add "sessions_spawn" to gateway.tools.allow in openclaw.json and restart gateway.');
      }
      throw new Error(`Gateway spawn failed: ${spawnResp.status} ${errText}`);
    }

    const spawnData = await spawnResp.json() as Record<string, any>;
    const childKey = spawnData.result?.details?.childSessionKey || spawnData.result?.childSessionKey;
    this.log({ event: 'session_spawned', taskId, childKey, resultFile });

    // Poll for result file
    return this.pollResultFile(resultFile, taskId, 120000);
  }

  private async pollResultFile(resultFile: string, taskId: string, timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    const interval = 2000;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval));

      try {
        if (existsSync(resultFile)) {
          const content = readFileSync(resultFile, 'utf-8').trim();
          try {
            const parsed = JSON.parse(content);
            if (parsed.done) {
              this.log({ event: 'result_received', taskId, method: 'file' });
              // Cleanup
              try { require('node:fs').unlinkSync(resultFile); } catch { /* ignore */ }
              return { response: parsed.response, agent: 'builtin-executor', action: taskId.split('-')[0] || 'general' };
            }
          } catch {
            // File exists but not valid JSON yet, keep polling
          }
        }
      } catch { /* retry */ }
    }

    throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms`);
  }

  private async executeViaTool(toolProxy: string, taskId: string, prompt: string, action: string, from: string): Promise<unknown> {
    const resp = await fetch(`${toolProxy}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        tool: 'openclaw_agent',
        input: { prompt, action, from },
      }),
    });

    if (!resp.ok) {
      throw new Error(`ToolGateway call failed: ${resp.status} ${await resp.text()}`);
    }

    const result = await resp.json() as Record<string, any>;
    return result.output;
  }

  private async finalizeTool(toolProxy: string, taskId: string, success: boolean, result: unknown): Promise<unknown> {
    try {
      const resp = await fetch(`${toolProxy}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, success, result }),
      });
      if (resp.ok) {
        const data = await resp.json() as Record<string, any>;
        this.log({ event: 'trace_finalized', taskId, events: data.trace?.events?.length || 0 });
        return data.trace;
      }
    } catch { /* ignore */ }
    return null;
  }

  private async callback(taskId: string, result: unknown, success: boolean, trace?: unknown): Promise<void> {
    const body: Record<string, unknown> = { taskId, result, success };
    if (trace) body.trace = trace;

    await fetch(this.config.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.log({ event: 'callback_sent', taskId, success });
  }

  /** Business-layer security audit */
  auditPayload(action: string, payload: Record<string, unknown>): ExecutorAuditResult {
    const text = JSON.stringify(payload).toLowerCase();

    // Cross-capability mismatch
    const mismatch: Record<string, RegExp[]> = {
      translation: [/send.*email/i, /database/i, /api.*call/i, /execute.*code/i],
      coding: [/send.*email/i, /database.*query/i, /translate/i],
      research: [/execute/i, /run.*code/i, /send.*email/i],
    };

    if (mismatch[action]) {
      for (const p of mismatch[action]) {
        if (p.test(text)) return { safe: false, reason: `Action "${action}" mismatch: ${p.source}`, severity: 'medium' };
      }
    }

    // File system ops
    for (const p of [/read.*file/i, /write.*file/i, /create.*file/i, /delete.*file/i, /save.*to.*disk/i]) {
      if (p.test(text)) return { safe: false, reason: 'File system operations require consent', severity: 'high' };
    }

    // External network
    for (const p of [/fetch.*http/i, /api.*request/i, /call.*external/i, /webhook/i]) {
      if (p.test(text)) return { safe: false, reason: 'External network requests require consent', severity: 'high' };
    }

    // Code execution
    for (const p of [/execute.*code/i, /run.*script/i, /eval\(/i, /exec\(/i]) {
      if (p.test(text)) return { safe: false, reason: 'Code execution not allowed', severity: 'critical' };
    }

    return { safe: true };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, '127.0.0.1', () => {
        this.log({
          event: 'started',
          port: this.config.port,
          gateway: this.config.gatewayUrl,
          callback: this.config.callbackUrl,
          hasToken: !!this.config.gatewayToken,
          hasContext: !!this.agentContext,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.log({ event: 'stopped' });
          resolve();
        });
      });
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }
}
