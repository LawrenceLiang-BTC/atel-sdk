import { exec } from 'child_process';
import { promisify } from 'util';
import type { Task } from '../schema/index.js';
import type { ThinkingChain, VerificationResult } from './types.js';

const execAsync = promisify(exec);

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'qwen2.5:0.5b';
const DEFAULT_CONFIDENCE_PASS = 0.85;
const DEFAULT_CONFIDENCE_FAIL = 0.3;
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

const AUDIT_PROMPT_TEMPLATE = `你是一个任务执行审计员。请判断以下思维链是否符合任务要求。

任务描述：
{TASK_GOAL}

思维链：
{REASONING}

结论：
{CONCLUSION}

请回答以下问题（用 JSON 格式）：
1. 思维链是否理解了任务要求？（true/false）
2. 推理过程是否合理？（true/false）
3. 结论是否正确？（true/false）
4. 如果有问题，问题是什么？（字符串）

输出格式：
{
  "understood": true/false,
  "reasoning_valid": true/false,
  "conclusion_correct": true/false,
  "issues": "问题描述（如果有）"
}`;

// ─── LLM Thinking Verifier ──────────────────────────────────

export class LLMThinkingVerifier {
  private modelName: string;
  private endpoint?: string;

  constructor(config: { modelName?: string; endpoint?: string } = {}) {
    this.modelName = config.modelName || DEFAULT_MODEL;
    this.endpoint = config.endpoint;
  }

  async verify(task: Task, thinking: ThinkingChain): Promise<VerificationResult> {
    const prompt = this.buildAuditPrompt(task, thinking);

    try {
      const response = this.endpoint 
        ? await this.callRemoteLLM(prompt)
        : await this.callLocalLLM(prompt);

      return this.parseResponse(response);
    } catch (error: any) {
      return {
        passed: false,
        violations: [`LLM audit failed: ${error.message}`],
        confidence: 0
      };
    }
  }

  private buildAuditPrompt(task: Task, thinking: ThinkingChain): string {
    return AUDIT_PROMPT_TEMPLATE
      .replace('{TASK_GOAL}', task.intent.goal)
      .replace('{REASONING}', thinking.reasoning)
      .replace('{CONCLUSION}', thinking.conclusion);
  }

  private async callLocalLLM(prompt: string): Promise<string> {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const { stdout } = await execAsync(
      `echo '${escapedPrompt}' | ollama run ${this.modelName}`,
      { maxBuffer: MAX_BUFFER_SIZE }
    );
    return stdout;
  }

  private async callRemoteLLM(prompt: string): Promise<string> {
    const response = await fetch(`${this.endpoint}/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      throw new Error(`Remote LLM failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  }

  private parseResponse(response: string): VerificationResult {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid LLM response format');
      }

      const result = JSON.parse(jsonMatch[0]);

      const passed = result.understood && 
                     result.reasoning_valid && 
                     result.conclusion_correct;

      return {
        passed,
        violations: passed ? [] : [result.issues || 'LLM audit failed'],
        confidence: passed ? DEFAULT_CONFIDENCE_PASS : DEFAULT_CONFIDENCE_FAIL,
        llm_response: result
      };
    } catch (error: any) {
      return {
        passed: false,
        violations: [`Failed to parse LLM response: ${error.message}`],
        confidence: 0
      };
    }
  }
}
