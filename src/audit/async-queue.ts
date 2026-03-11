import type { Task } from '../schema/index.js';
import type { ThinkingChain, VerificationResult } from './types.js';
import { LLMThinkingVerifier } from './llm-verifier.js';

// ─── Async Audit Queue ──────────────────────────────────────

const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 5000;

interface AuditTask {
  task: Task;
  thinking: ThinkingChain;
  timestamp: number;
  retries: number;
}

interface AuditQueueConfig {
  maxRetries?: number;
  retryDelay?: number;
  maxQueueSize?: number;
  onComplete?: (task: Task, result: VerificationResult) => void;
  onError?: (task: Task, error: Error) => void;
}

export class AsyncAuditQueue {
  private queue: AuditTask[] = [];
  private processing = false;
  private verifier: LLMThinkingVerifier;
  private config: Required<AuditQueueConfig>;

  constructor(
    verifier: LLMThinkingVerifier,
    config: AuditQueueConfig = {}
  ) {
    this.verifier = verifier;
    this.config = {
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelay: config.retryDelay ?? DEFAULT_RETRY_DELAY,
      maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      onComplete: config.onComplete ?? (() => {}),
      onError: config.onError ?? (() => {})
    };
  }

  /**
   * Enqueue a task for async audit (non-blocking)
   * @throws Error if queue is full
   */
  enqueue(task: Task, thinking: ThinkingChain): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new Error(`Audit queue full (max: ${this.config.maxQueueSize})`);
    }

    this.queue.push({
      task,
      thinking,
      timestamp: Date.now(),
      retries: 0
    });

    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is processing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      try {
        const result = await this.verifier.verify(item.task, item.thinking);

        // Call completion callback
        this.config.onComplete(item.task, result);
      } catch (error: any) {
        // Retry logic
        if (item.retries < this.config.maxRetries) {
          item.retries++;
          
          // Re-enqueue with delay (fixed: ensure processing continues)
          setTimeout(() => {
            this.queue.push(item);
            // Restart processing if it stopped
            if (!this.processing) {
              this.processQueue();
            }
          }, this.config.retryDelay);
        } else {
          // Max retries reached, call error callback
          this.config.onError(item.task, error);
        }
      }
    }

    this.processing = false;
  }
}
