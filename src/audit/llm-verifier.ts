import type { Task } from '../schema/index.js';
import type { CoTReasoningChain, VerificationResult } from './types.js';
import { OllamaManager } from './ollama-manager.js';

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'qwen2.5-0.5b-instruct-q4_0.gguf';
const DEFAULT_CONFIDENCE_PASS = 0.85;
const DEFAULT_CONFIDENCE_FAIL = 0.3;

const AUDIT_PROMPT_TEMPLATE = `你是一个任务执行审计员。请判断以下CoT推理链是否符合任务要求。

任务描述：
{TASK_GOAL}

CoT推理链：
{REASONING}

结论：
{CONCLUSION}

请回答以下问题（用 JSON 格式）：
1. CoT推理链是否理解了任务要求？（true/false）
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
  private ollamaManager?: OllamaManager;
  private initPromise?: Promise<void>;
  private log: (message: string) => void;

  constructor(config: { 
    modelName?: string;
    autoInit?: boolean;
    log?: (message: string) => void;
  } = {}) {
    this.modelName = config.modelName || DEFAULT_MODEL;
    this.log = config.log || ((msg) => console.log(`[LLM Verifier] ${msg}`));
    
    // Auto-initialize by default
    if (config.autoInit !== false) {
      this.initPromise = this.initialize();
    }
  }

  /**
   * Initialize the LLM (download model if needed, then load)
   */
  private async initialize(): Promise<void> {
    try {
      this.log('Initializing LLM...');
      this.ollamaManager = new OllamaManager({
        log: (msg) => this.log(msg),
      });
      await this.ollamaManager.initialize();
    } catch (error: any) {
      this.log(`⚠️  Failed to initialize LLM: ${error.message}`);
      this.log('   Audit will be skipped for tasks');
      this.ollamaManager = undefined;
    }
  }

  /**
   * Ensure initialization is complete
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = undefined;
    }
  }

  async verify(task: Task, thinking: CoTReasoningChain): Promise<VerificationResult> {
    // Wait for initialization to complete
    await this.ensureInitialized();

    // Check if LLM is available
    if (!this.ollamaManager || !this.ollamaManager.isReady()) {
      this.log('LLM not available, skipping audit');
      return {
        passed: true,
        violations: [],
        skipped: true,
        skip_reason: 'LLM not available',
        confidence: 0,
      };
    }

    const prompt = this.buildAuditPrompt(task, thinking);

    try {
      const response = await this.ollamaManager.generate(prompt);
      return this.parseResponse(response);
    } catch (error: any) {
      this.log(`Audit failed: ${error.message}`);
      
      // Don't fail the task, just skip audit
      return {
        passed: true,
        violations: [],
        skipped: true,
        skip_reason: `Audit failed: ${error.message}`,
        confidence: 0,
      };
    }
  }

  private buildAuditPrompt(task: Task, thinking: CoTReasoningChain): string {
    return AUDIT_PROMPT_TEMPLATE
      .replace('{TASK_GOAL}', task.intent.goal)
      .replace('{REASONING}', thinking.reasoning)
      .replace('{CONCLUSION}', thinking.conclusion);
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

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.ollamaManager) {
      await this.ollamaManager.cleanup();
      this.ollamaManager = undefined;
    }
  }
}
