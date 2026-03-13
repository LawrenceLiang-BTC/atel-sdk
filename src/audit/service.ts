/**
 * Audit Service - Optional background CoT reasoning chain auditor
 * 
 * Design:
 * - Non-blocking: uses async queue, doesn't block main flow
 * - Optional: controlled by config, disabled by default
 * - Standalone: can run in Platform or SDK without coupling
 * - Result storage: callbacks for custom handling (DB, logs, etc.)
 */

import type { Task } from '../schema/index.js';
import type { CoTReasoningChain, VerificationResult, AgentModelInfo, LLMAuditConfig } from './types.js';
import { TieredAuditVerifier } from './tiered-verifier.js';
import { LLMThinkingVerifier } from './llm-verifier.js';
import { AsyncAuditQueue } from './async-queue.js';

export interface AuditServiceConfig extends LLMAuditConfig {
  /** Enable audit service (default: false) */
  enabled?: boolean;
  /** Max queue size (default: 1000) */
  maxQueueSize?: number;
  /** Max retries on failure (default: 3) */
  maxRetries?: number;
  /** Retry delay in ms (default: 5000) */
  retryDelay?: number;
  /** Callback when audit completes */
  onAuditComplete?: (taskId: string, result: VerificationResult) => void | Promise<void>;
  /** Callback when audit fails after retries */
  onAuditError?: (taskId: string, error: Error) => void | Promise<void>;
  /** Logger function */
  log?: (obj: Record<string, unknown>) => void;
}

export class AuditService {
  private config: Required<Omit<AuditServiceConfig, 'onAuditComplete' | 'onAuditError'>> & {
    onAuditComplete?: (taskId: string, result: VerificationResult) => void | Promise<void>;
    onAuditError?: (taskId: string, error: Error) => void | Promise<void>;
  };
  private verifier: TieredAuditVerifier | null = null;
  private queue: AsyncAuditQueue | null = null;

  constructor(config: AuditServiceConfig = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      llm_model_path: config.llm_model_path ?? 'qwen2.5:0.5b',
      strategy: config.strategy ?? 'hybrid',
      fallback: config.fallback ?? 'rule',
      require_cot_reasoning_capability: config.require_cot_reasoning_capability ?? true,
      maxQueueSize: config.maxQueueSize ?? 1000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 5000,
      log: config.log ?? (() => {}),
      onAuditComplete: config.onAuditComplete,
      onAuditError: config.onAuditError,
    };

    if (this.config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    // Create LLM verifier
    const llmVerifier = new LLMThinkingVerifier({
      modelName: this.config.llm_model_path,
    });

    // Create tiered verifier
    this.verifier = new TieredAuditVerifier(llmVerifier, {
      requireCoTReasoningCapability: this.config.require_cot_reasoning_capability,
    });

    // Create async queue
    this.queue = new AsyncAuditQueue(llmVerifier, {
      maxQueueSize: this.config.maxQueueSize,
      maxRetries: this.config.maxRetries,
      retryDelay: this.config.retryDelay,
      onComplete: (task, result) => {
        this.config.log({ event: 'audit_complete', taskId: task.task_id, passed: result.passed });
        if (this.config.onAuditComplete) {
          this.config.onAuditComplete(task.task_id, result);
        }
      },
      onError: (task, error) => {
        this.config.log({ event: 'audit_error', taskId: task.task_id, error: error.message });
        if (this.config.onAuditError) {
          this.config.onAuditError(task.task_id, error);
        }
      },
    });

    this.config.log({ event: 'audit_service_initialized', strategy: this.config.strategy });
  }

  /**
   * Submit a task result for async audit (non-blocking)
   * Returns immediately, audit happens in background
   */
  async submitForAudit(
    task: Task,
    thinking: CoTReasoningChain,
    modelInfo?: AgentModelInfo
  ): Promise<void> {
    if (!this.config.enabled || !this.queue) {
      return; // Service disabled, skip silently
    }

    try {
      this.queue.enqueue(task, thinking);
      this.config.log({ event: 'audit_enqueued', taskId: task.task_id, queueSize: this.queue.size() });
    } catch (error: any) {
      this.config.log({ event: 'audit_enqueue_failed', taskId: task.task_id, error: error.message });
    }
  }

  /**
   * Synchronous audit (blocks until complete)
   * Use only when immediate result is needed
   */
  async auditSync(
    task: Task,
    thinking: CoTReasoningChain,
    modelInfo?: AgentModelInfo
  ): Promise<VerificationResult> {
    if (!this.config.enabled || !this.verifier) {
      // Service disabled, return pass-through result
      return {
        passed: true,
        violations: [],
        skipped: true,
        skip_reason: 'Audit service disabled',
      };
    }

    try {
      const result = await this.verifier.verify(task, thinking, modelInfo);
      this.config.log({ event: 'audit_sync_complete', taskId: task.task_id, passed: result.passed });
      return result;
    } catch (error: any) {
      this.config.log({ event: 'audit_sync_error', taskId: task.task_id, error: error.message });
      throw error;
    }
  }

  /**
   * Get current queue status
   */
  getStatus(): { enabled: boolean; queueSize: number; processing: boolean } {
    return {
      enabled: this.config.enabled,
      queueSize: this.queue?.size() ?? 0,
      processing: this.queue?.isProcessing() ?? false,
    };
  }

  /**
   * Enable/disable the service at runtime
   */
  setEnabled(enabled: boolean): void {
    if (enabled && !this.config.enabled) {
      this.config.enabled = true;
      this.initialize();
    } else if (!enabled) {
      this.config.enabled = false;
      this.verifier = null;
      this.queue = null;
    }
  }
}
