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
import { TieredAuditVerifier } from '../audit/tiered-verifier.js';
import { LLMThinkingVerifier } from '../audit/llm-verifier.js';
import type { Task } from '../schema/index.js';

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
  /** Enable tiered thinking audit */
  enableThinkingAudit?: boolean;
  /** Ollama endpoint for LLM audit (optional) */
  ollamaEndpoint?: string;
  /** Ollama model for LLM audit (optional) */
  ollamaModel?: string;
  /** Require thinking capability from agent model */
  requireThinkingCapability?: boolean;
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
  private auditVerifier: TieredAuditVerifier | null = null;

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

    // Initialize tiered audit verifier (enabled by default)
    const enableAudit = config.enableThinkingAudit ?? true; // Default: enabled
    if (enableAudit) {
      const llmVerifier = new LLMThinkingVerifier({
        modelName: config.ollamaModel || 'qwen2.5:0.5b',
      });
      this.auditVerifier = new TieredAuditVerifier(llmVerifier, {
        requireCoTReasoningCapability: config.requireThinkingCapability ?? false, // Don't reject non-thinking models
      });
      this.log({ event: 'audit_verifier_initialized', model: config.ollamaModel });
    }

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

  private extractMemoryKey(text: string): { key: string; value: string } | null {
    if (!text) return null;

    // Pattern 1: explicit assignment, e.g. TOKEN_A=RED_WOLF_888
    const assignMatches = [...text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*([A-Z0-9_\-]{3,})\b/g)];
    if (assignMatches.length > 0) {
      const m = assignMatches[assignMatches.length - 1];
      return { key: m[1], value: m[2] };
    }

    // Pattern 2: token/password style in prompt, e.g. 口令 TOKEN_Xxx / token TOKEN_Xxx
    const tokenMatches = [...text.matchAll(/(?:口令|token|口令是|token is)\s*[:：]?\s*([A-Z0-9_\-]{4,})/gi)];
    if (tokenMatches.length > 0) {
      const m = tokenMatches[tokenMatches.length - 1];
      return { key: 'LATEST_TOKEN', value: m[1] };
    }

    // Pattern 3: bare TOKEN_XXX appearance when asking to memorize
    if (/(记住|memorize|remember)/i.test(text)) {
      const bare = [...text.matchAll(/\b(TOKEN_[A-Z0-9_\-]{2,})\b/g)];
      if (bare.length > 0) {
        const m = bare[bare.length - 1];
        return { key: 'LATEST_TOKEN', value: m[1] };
      }
    }

    return null;
  }

  private saveTaskHistory(taskId: string, from: string, action: string, payload: Record<string, unknown>, result: unknown, success: boolean): void {
    try {
      const timestamp = new Date().toISOString();
      const text = (payload.text || payload.message || payload.task || payload.query || '') as string;
      const resultText = typeof result === 'object' && result !== null
        ? ((result as Record<string, unknown>).response || JSON.stringify(result)).toString().slice(0, 200)
        : String(result).slice(0, 200);

      let entry = `### ${timestamp} | ${action} | from: ${from.slice(-8)}
- Task: ${text.slice(0, 150)}
- Result: ${success ? resultText : 'FAILED'}
- Status: ${success ? 'success' : 'failed'}
`;

      // Structured memory keys (newest wins): MEMKEY|<ts>|<key>|<value>
      const memory = this.extractMemoryKey(text);
      if (memory) {
        entry += `\nMEMKEY|${timestamp}|${memory.key}|${memory.value}\n`;
      }

      entry += '\n';
      appendFileSync(this.taskHistoryPath, entry);
      this.log({ event: 'history_saved', taskId, memkey: memory?.key || null });
    } catch (e: unknown) {
      this.log({ event: 'history_save_failed', taskId, error: (e as Error).message });
    }
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', type: 'builtin-executor', gateway: this.config.gatewayUrl, hasContext: !!this.agentContext });
    });

    // Internal endpoint for ToolGateway to call back into executor
    this.app.post('/internal/openclaw_agent', async (req, res) => {
      const { tool, input } = req.body;
      try {
        const prompt = input?.prompt || input?.text || JSON.stringify(input);
        const taskId = input?.taskId || `internal-${Date.now()}`;
        const result = await this.executeDirect(prompt, taskId);
        
        // ── Extract thinking chain and trigger audit (same as main flow) ──
        const thinkingChain = this.extractThinkingChain(result);
        if (thinkingChain) {
          this.log({ event: 'cot_chain_extracted', taskId, steps: thinkingChain.steps.length });
          
          // Async audit (non-blocking)
          if (this.auditVerifier) {
            (async () => {
              try {
                const task: Task = {
                  task_id: taskId,
                  version: 'task.v0.1',
                  issuer: 'internal',
                  intent: {
                    type: 'internal_test',
                    goal: prompt.substring(0, 100),
                  },
                  risk: { level: 'low' },
                  nonce: Date.now().toString(),
                };
                
                const modelInfo = { name: 'unknown', provider: 'gateway' };
                const auditResult = await this.auditVerifier!.verify(task, thinkingChain, modelInfo);
                
                this.log({ 
                  event: auditResult.passed ? 'cot_audit_passed' : 'cot_audit_failed',
                  taskId, 
                  passed: auditResult.passed,
                  violations: auditResult.violations,
                  confidence: auditResult.confidence 
                });
              } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                this.log({ event: 'cot_audit_error', taskId, error: msg });
              }
            })();
          }
        }
        
        res.json(result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: msg });
      }
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
        // Register openclaw_agent tool so ToolGateway can record trace
        await fetch(`${toolProxy}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            tool: 'openclaw_agent',
            endpoint: `http://127.0.0.1:${this.config.port}/internal/openclaw_agent`,
          }),
        });
        this.log({ event: 'toolgateway_registered', taskId, tool: 'openclaw_agent' });
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

      // ── Extract thinking chain from result ──
      const thinkingChain = this.extractThinkingChain(result);
      if (thinkingChain) {
        this.log({ event: 'cot_chain_extracted', taskId, steps: thinkingChain.steps.length });
        
        // ── Async tiered audit (non-blocking) ──
        if (this.auditVerifier) {
          // Fire and forget - audit in background, don't block task completion
          (async () => {
            try {
              // Construct Task object from request
              const task: Task = {
                task_id: taskId,
                version: 'task.v0.1',
                issuer: from,
                intent: {
                  type: action,
                  goal: typeof payload === 'object' && payload !== null && 'goal' in payload 
                    ? String(payload.goal) 
                    : action,
                },
                risk: {
                  level: (typeof payload === 'object' && payload !== null && 'risk' in payload
                    ? String((payload as any).risk)
                    : 'medium') as 'low' | 'medium' | 'high' | 'critical',
                },
                nonce: Date.now().toString(),
              };

              // Extract model info from result or config
              const modelInfo = {
                name: typeof result === 'object' && result !== null && 'agent' in result
                  ? String((result as any).agent)
                  : 'unknown',
                hasThinking: true, // We already extracted thinking chain
              };

              const auditResult = await this.auditVerifier!.verify(task, thinkingChain, modelInfo);
              
              this.log({ 
                event: auditResult.passed ? 'cot_audit_passed' : 'cot_audit_failed',
                taskId, 
                passed: auditResult.passed,
                violations: auditResult.violations,
                confidence: auditResult.confidence 
              });
            } catch (auditError: unknown) {
              const msg = auditError instanceof Error ? auditError.message : String(auditError);
              this.log({ event: 'cot_audit_error', taskId, error: msg });
            }
          })();
        }
        
        // Append thinking chain to trace via toolProxy
        if (toolProxy) {
          try {
            await fetch(`${toolProxy}/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                taskId,
                tool: 'cot_chain',
                endpoint: `http://127.0.0.1:${this.config.port}/internal/openclaw_agent`,
              }),
            });
          } catch { /* best effort */ }
        }
        // Attach thinking to result
        if (typeof result === 'object' && result !== null) {
          (result as Record<string, unknown>).thinking = thinkingChain;
        }
      } else {
        this.log({ event: 'cot_chain_missing', taskId, warning: 'Model did not produce thinking chain' });
        
        // If thinking audit is enabled and required, reject tasks without thinking
        if (this.auditVerifier && this.config.requireThinkingCapability) {
          const errorMsg = 'Task rejected: Model did not produce required thinking chain';
          this.log({ event: 'task_rejected', taskId, reason: errorMsg });
          if (toolProxy) {
            await this.finalizeTool(toolProxy, taskId, false, { error: errorMsg });
          }
          await this.callback(taskId, { error: errorMsg }, false);
          return;
        }
      }

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

  private extractLatestMemoryHints(history: string): string {
    if (!history) return '';

    // Strict parse: only trust structured MEMKEY entries
    // Format: MEMKEY|<timestamp>|<key>|<value>
    const lines = history.split('\n').map(l => l.trim()).filter(Boolean);
    const memLines = lines.filter(l => l.startsWith('MEMKEY|'));
    if (memLines.length === 0) return '';

    const latest = memLines[memLines.length - 1];
    const parts = latest.split('|');
    if (parts.length < 4) return '';

    const ts = parts[1];
    const key = parts[2];
    const value = parts.slice(3).join('|');
    return `Latest memory entry: ${key} = ${value} (at ${ts})`;
  }

  private extractThinkingChain(result: unknown): { steps: string[]; reasoning: string; conclusion: string } | null {
    if (!result || typeof result !== 'object') return null;
    
    const response = (result as Record<string, unknown>).response;
    if (!response || typeof response !== 'string') return null;

    // Method 1: Extract content between <thinking> tags
    const match = response.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    let thinkingText = match ? match[1].trim() : '';

    // Method 2: If no tags, look for Step patterns in the full response
    if (!thinkingText) {
      const hasSteps = response.match(/step\s*\d+|第\s*\d+\s*步|\d+[\.\)]\s*\S/gi);
      if (hasSteps && hasSteps.length >= 2) {
        thinkingText = response;
      }
    }

    if (!thinkingText) return null;

    // Parse steps
    const lines = thinkingText.split('\n').map(l => l.trim()).filter(Boolean);
    const steps: string[] = [];
    let conclusion = '';

    for (const line of lines) {
      if (line.toLowerCase().startsWith('conclusion:') || line.startsWith('结论')) {
        conclusion = line.replace(/^(conclusion:|结论[:：])\s*/i, '');
      } else if (line.match(/^(step\s*\d+|第\s*\d+\s*步|\d+[\.\)、])/i)) {
        steps.push(line.replace(/^(step\s*\d+[:：]\s*|第\s*\d+\s*步[:：]\s*|\d+[\.\)、]\s*)/i, ''));
      } else if (steps.length > 0) {
        // Continuation of previous step
        steps[steps.length - 1] += ' ' + line;
      }
    }

    if (steps.length < 2) return null;

    return {
      steps,
      reasoning: thinkingText,
      conclusion: conclusion || steps[steps.length - 1] || ''
    };
  }

  private buildPrompt(from: string, action: string, payload: Record<string, unknown>): string {
    const text = (payload.text || payload.message || payload.task || payload.query || JSON.stringify(payload)) as string;

    const guides: Record<string, string> = {
      translation: `Translate the following text to ${payload.target_lang || 'the target language'}. Return only the translation.`,
      coding: 'Help with the following coding task. Provide working code with brief explanation.',
      research: 'Research the following topic and provide useful, accurate information.',
      general: 'Complete the following task.',
      assistant: 'Complete the following task accurately and concisely.',
    };

    const guide = guides[action] || guides.general;

    let prompt = '';
    if (this.agentContext) {
      prompt += `## Agent Context\n${this.agentContext}\n\n`;
    }

    const history = this.loadTaskHistory();
    if (history) {
      prompt += `## Recent Task History\n${history}\n\n`;
      const hints = this.extractLatestMemoryHints(history);
      if (hints) {
        prompt += `## Latest Memory Hints (most recent wins)\n${hints}\n\n`;
      }
    }

    prompt += `## Task\n${guide}\n\n${text}\n\n`;
    prompt += `## Thinking Chain (REQUIRED)\nBefore giving your final answer, you MUST show your thinking process inside <thinking> tags.\nFormat:\n<thinking>\nStep 1: [your first reasoning step]\nStep 2: [your second reasoning step]\n...\nConclusion: [your conclusion]\n</thinking>\nThen provide your final answer after the closing tag.\n\n`;
    prompt += `## Recall Rule\nIf memory values conflict, ONLY use the latest MEMKEY entry. Never use older values when a newer MEMKEY exists.`;

    return prompt;
  }

  private async executeViaOllama(prompt: string, taskId: string): Promise<unknown | null> {
    // Check if Ollama is available and audit config exists
    const auditConfigPath = join(process.cwd(), '.atel', 'audit-config.json');
    if (!existsSync(auditConfigPath)) return null;

    let auditConfig: Record<string, any>;
    try {
      auditConfig = JSON.parse(readFileSync(auditConfigPath, 'utf-8'));
    } catch { return null; }

    const model = auditConfig.model || 'qwen2.5:0.5b';
    const endpoint = auditConfig.ollama?.endpoint || 'http://localhost:11434';

    // Check Ollama is running
    try {
      const healthResp = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (!healthResp.ok) return null;
    } catch { return null; }

    this.log({ event: 'ollama_executing', taskId, model, endpoint });

    // Call Ollama API
    const resp = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.7 }
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      throw new Error(`Ollama generate failed: ${resp.status}`);
    }

    const data = await resp.json() as Record<string, any>;
    const response = data.response || '';

    this.log({ event: 'ollama_completed', taskId, model, responseLength: response.length });

    return { done: true, response };
  }

  private async executeDirect(prompt: string, taskId: string): Promise<unknown> {
    // Prefer OpenClaw Gateway for better thinking chain extraction
    // Try Gateway first
    try {
      return await this.executeViaGateway(prompt, taskId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log({ event: 'gateway_fallback', taskId, reason: msg });
    }

    // Fallback to local Ollama
    try {
      const ollamaResult = await this.executeViaOllama(prompt, taskId);
      if (ollamaResult) return ollamaResult;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Both Gateway and Ollama failed: ${msg}`);
    }

    throw new Error('No execution method available');
  }

  private async executeViaGateway(prompt: string, taskId: string): Promise<unknown> {
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
              // Return the full parsed object so thinking chain can be extracted
              return parsed;
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
