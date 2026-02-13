/**
 * Module 5: Execution Trace
 *
 * Tamper-evident execution trace built on a hash chain.
 * Every event links to the previous event's hash, forming
 * an append-only, verifiable log of agent activity.
 */

import { createHash } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AgentIdentity } from '../identity/index.js';

// ─── Trace Types ─────────────────────────────────────────────────

/** All recognized trace event types */
export type TraceEventType =
  | 'TASK_ACCEPTED'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'POLICY_CHECK'
  | 'POLICY_VIOLATION'
  | 'CHECKPOINT'
  | 'TASK_RESULT'
  | 'TASK_FAILED'
  | 'ROLLBACK';

/** A single event in the execution trace */
export interface TraceEvent {
  /** Monotonically increasing sequence number (0-based) */
  seq: number;
  /** ISO 8601 timestamp */
  ts: string;
  /** Event type */
  type: TraceEventType;
  /** Task this event belongs to */
  task_id: string;
  /** Event-specific payload */
  data: Record<string, unknown>;
  /** Hash of the previous event ("0x00" for the first event) */
  prev: string;
  /** Hash of this event */
  hash: string;
  /** Optional signature (present on CHECKPOINT events) */
  sig?: string;
}

/** Options for ExecutionTrace construction */
export interface TraceOptions {
  /** Number of events between automatic checkpoints (default: 50) */
  checkpointInterval?: number;
  /** Persistence options */
  storage?: TraceStorageOptions;
}

/** Options for trace file persistence */
export interface TraceStorageOptions {
  /** Directory to store trace files */
  dir: string;
  /** Whether to auto-save after each append (default: false) */
  autoSave: boolean;
}

/** Statistics about the trace */
export interface TraceStats {
  task_id: string;
  event_count: number;
  tool_calls: number;
  tool_results: number;
  policy_checks: number;
  policy_violations: number;
  checkpoints: number;
  first_event_ts: string | null;
  last_event_ts: string | null;
  duration_ms: number | null;
  finalized: boolean;
  failed: boolean;
}

// ─── Hash Helpers ────────────────────────────────────────────────

/**
 * Compute SHA-256 of a UTF-8 string.
 *
 * @param input - The string to hash.
 * @returns Hex-encoded SHA-256 digest.
 */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Deterministic JSON serialization (keys sorted recursively).
 *
 * @param obj - The value to serialize.
 * @returns Deterministic JSON string.
 */
function sortedStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  if (typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => sortedStringify(item)).join(',')}]`;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${sortedStringify(record[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Compute the hash of a trace event.
 *
 * Formula:
 * ```
 * SHA256( seq + "|" + ts + "|" + type + "|" + SHA256(sortedStringify(data)) + "|" + prev_hash )
 * ```
 *
 * @param seq - Sequence number.
 * @param ts - ISO 8601 timestamp.
 * @param type - Event type.
 * @param data - Event data payload.
 * @param prev - Previous event hash.
 * @returns Hex-encoded SHA-256 hash.
 */
export function computeEventHash(
  seq: number,
  ts: string,
  type: string,
  data: Record<string, unknown>,
  prev: string
): string {
  const dataHash = sha256(sortedStringify(data));
  const preimage = `${seq}|${ts}|${type}|${dataHash}|${prev}`;
  return sha256(preimage);
}

// ─── Execution Trace ─────────────────────────────────────────────

/** The initial "previous hash" for the first event in a trace */
const GENESIS_PREV = '0x00';

/**
 * Tamper-evident, append-only execution trace.
 *
 * Each event is hash-chained to the previous one. Periodic checkpoints
 * include a signature from the agent identity for non-repudiation.
 */
export class ExecutionTrace {
  private readonly taskId: string;
  private readonly identity: AgentIdentity;
  private readonly checkpointInterval: number;
  private readonly storage?: TraceStorageOptions;
  private readonly events: TraceEvent[] = [];
  private seq: number = 0;
  private finalized: boolean = false;
  private failed: boolean = false;
  private eventsSinceCheckpoint: number = 0;

  /**
   * @param taskId - Unique identifier for the task being traced.
   * @param agentIdentity - The agent's cryptographic identity (for signing).
   * @param options - Optional configuration.
   */
  constructor(taskId: string, agentIdentity: AgentIdentity, options?: TraceOptions) {
    this.taskId = taskId;
    this.identity = agentIdentity;
    this.checkpointInterval = options?.checkpointInterval ?? 50;
    this.storage = options?.storage;

    // Ensure storage directory exists
    if (this.storage) {
      if (!existsSync(this.storage.dir)) {
        mkdirSync(this.storage.dir, { recursive: true });
      }
    }
  }

  /**
   * Append a new event to the trace.
   *
   * Automatically triggers a checkpoint when the configured interval is reached.
   *
   * @param type - The event type.
   * @param data - Event-specific data payload.
   * @returns The created TraceEvent.
   * @throws If the trace has already been finalized or failed.
   */
  append(type: TraceEventType, data: Record<string, unknown>): TraceEvent {
    if (this.finalized) {
      throw new Error('Cannot append to a finalized trace');
    }
    if (this.failed) {
      throw new Error('Cannot append to a failed trace');
    }

    const ts = new Date().toISOString();
    const prev = this.events.length > 0
      ? this.events[this.events.length - 1].hash
      : GENESIS_PREV;

    const hash = computeEventHash(this.seq, ts, type, data, prev);

    const event: TraceEvent = {
      seq: this.seq,
      ts,
      type,
      task_id: this.taskId,
      data,
      prev,
      hash,
    };

    this.events.push(event);
    this.seq++;
    this.eventsSinceCheckpoint++;

    // Auto-save to file if storage is configured
    if (this.storage?.autoSave) {
      this.appendEventToFile(event);
    }

    // Auto-checkpoint
    if (
      type !== 'CHECKPOINT' &&
      this.eventsSinceCheckpoint >= this.checkpointInterval
    ) {
      this.checkpoint();
    }

    return event;
  }

  /**
   * Create a checkpoint event with a signature.
   *
   * The checkpoint captures cumulative statistics and a Merkle root
   * placeholder (full Merkle tree is built in Module 6).
   *
   * @returns The checkpoint TraceEvent.
   */
  checkpoint(): TraceEvent {
    if (this.finalized || this.failed) {
      throw new Error('Cannot checkpoint a finalized or failed trace');
    }

    const stats = this.getStats();
    const lastHash = this.events.length > 0
      ? this.events[this.events.length - 1].hash
      : GENESIS_PREV;

    // Build a simple merkle root from event hashes collected so far
    const eventHashes = this.events.map((e) => e.hash);
    const merkleRoot = this.simpleMerkleRoot(eventHashes);

    const checkpointData: Record<string, unknown> = {
      merkle_root: merkleRoot,
      event_count: stats.event_count,
      tool_calls: stats.tool_calls,
      last_hash: lastHash,
    };

    const ts = new Date().toISOString();
    const prev = this.events.length > 0
      ? this.events[this.events.length - 1].hash
      : GENESIS_PREV;

    const hash = computeEventHash(this.seq, ts, 'CHECKPOINT', checkpointData, prev);

    // Sign the checkpoint hash
    const sig = this.identity.sign(hash);

    const event: TraceEvent = {
      seq: this.seq,
      ts,
      type: 'CHECKPOINT',
      task_id: this.taskId,
      data: checkpointData,
      prev,
      hash,
      sig,
    };

    this.events.push(event);
    this.seq++;
    this.eventsSinceCheckpoint = 0;

    // Auto-save checkpoint to file
    if (this.storage?.autoSave) {
      this.appendEventToFile(event);
    }

    return event;
  }

  /**
   * Finalize the trace with a TASK_RESULT event.
   *
   * @param result - The task result data.
   * @returns The hash of the final event (trace_hash).
   */
  finalize(result: Record<string, unknown>): string {
    if (this.finalized) {
      throw new Error('Trace is already finalized');
    }
    if (this.failed) {
      throw new Error('Cannot finalize a failed trace');
    }

    const event = this.append('TASK_RESULT', result);
    this.finalized = true;
    return event.hash;
  }

  /**
   * Mark the trace as failed with a TASK_FAILED event.
   *
   * @param error - Error information.
   * @returns The TASK_FAILED event.
   */
  fail(error: Record<string, unknown> | Error): TraceEvent {
    if (this.finalized) {
      throw new Error('Cannot fail a finalized trace');
    }
    if (this.failed) {
      throw new Error('Trace has already been marked as failed');
    }

    const data: Record<string, unknown> =
      error instanceof Error
        ? { error: error.message, stack: error.stack }
        : error;

    // Temporarily unset failed so append works
    const event = this.append('TASK_FAILED', data);
    this.failed = true;
    return event;
  }

  /**
   * Verify the integrity of the entire hash chain.
   *
   * Recomputes every event hash and checks it matches the stored hash,
   * and that each event's `prev` matches the preceding event's hash.
   *
   * @returns True if the chain is intact, false otherwise.
   */
  verify(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];

      // Check prev pointer
      const expectedPrev = i === 0 ? GENESIS_PREV : this.events[i - 1].hash;
      if (event.prev !== expectedPrev) {
        errors.push(
          `Event #${event.seq}: prev mismatch — expected "${expectedPrev}", got "${event.prev}"`
        );
      }

      // Recompute hash
      const recomputed = computeEventHash(
        event.seq,
        event.ts,
        event.type,
        event.data,
        event.prev
      );
      if (recomputed !== event.hash) {
        errors.push(
          `Event #${event.seq}: hash mismatch — expected "${recomputed}", got "${event.hash}"`
        );
      }

      // Verify checkpoint signatures
      if (event.type === 'CHECKPOINT' && event.sig) {
        const sigValid = this.identity.verify(event.hash, event.sig);
        if (!sigValid) {
          errors.push(`Event #${event.seq}: checkpoint signature invalid`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Export the trace as a JSONL (JSON Lines) string.
   *
   * @returns Each event serialized as one JSON line.
   */
  export(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n');
  }

  /**
   * Export the trace to a file in JSONL format.
   *
   * @param path - File path to write to.
   */
  async exportToFile(path: string): Promise<void> {
    const content = this.export();
    await writeFile(path, content, 'utf-8');
  }

  /**
   * Return a copy of all events.
   *
   * @returns Array of TraceEvent objects.
   */
  getEvents(): ReadonlyArray<TraceEvent> {
    return [...this.events];
  }

  /**
   * Return statistics about the trace.
   *
   * @returns A TraceStats object.
   */
  getStats(): TraceStats {
    const toolCalls = this.events.filter((e) => e.type === 'TOOL_CALL').length;
    const toolResults = this.events.filter((e) => e.type === 'TOOL_RESULT').length;
    const policyChecks = this.events.filter((e) => e.type === 'POLICY_CHECK').length;
    const policyViolations = this.events.filter((e) => e.type === 'POLICY_VIOLATION').length;
    const checkpoints = this.events.filter((e) => e.type === 'CHECKPOINT').length;

    const firstTs = this.events.length > 0 ? this.events[0].ts : null;
    const lastTs = this.events.length > 0 ? this.events[this.events.length - 1].ts : null;

    let duration_ms: number | null = null;
    if (firstTs && lastTs) {
      duration_ms = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    }

    return {
      task_id: this.taskId,
      event_count: this.events.length,
      tool_calls: toolCalls,
      tool_results: toolResults,
      policy_checks: policyChecks,
      policy_violations: policyViolations,
      checkpoints,
      first_event_ts: firstTs,
      last_event_ts: lastTs,
      duration_ms,
      finalized: this.finalized,
      failed: this.failed,
    };
  }

  /**
   * Get the task ID for this trace.
   */
  getTaskId(): string {
    return this.taskId;
  }

  /**
   * Check whether the trace has been finalized.
   */
  isFinalized(): boolean {
    return this.finalized;
  }

  /**
   * Check whether the trace has been marked as failed.
   */
  isFailed(): boolean {
    return this.failed;
  }

  // ─── Persistence ──────────────────────────────────────────────

  /**
   * Save the entire trace to a JSONL file.
   *
   * @param filePath - Optional file path. Defaults to `{storage.dir}/{task_id}.trace.jsonl`.
   * @throws If no filePath is provided and no storage options are configured.
   */
  saveToFile(filePath?: string): void {
    const path = filePath ?? this.getStoragePath();
    if (!path) {
      throw new Error('No file path provided and no storage options configured');
    }

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const content = this.events.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(path, content + (this.events.length > 0 ? '\n' : ''), 'utf-8');
  }

  /**
   * Load a trace from a JSONL file.
   *
   * Reconstructs the ExecutionTrace with all events, preserving
   * the hash chain. Requires an AgentIdentity for signature verification.
   *
   * @param filePath - Path to the JSONL trace file.
   * @param agentIdentity - The agent identity to associate with the loaded trace.
   * @returns A reconstructed ExecutionTrace.
   */
  static loadFromFile(filePath: string, agentIdentity: AgentIdentity): ExecutionTrace {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);

    if (lines.length === 0) {
      throw new Error('Trace file is empty');
    }

    const events: TraceEvent[] = lines.map((line) => JSON.parse(line) as TraceEvent);
    const taskId = events[0].task_id;

    const trace = new ExecutionTrace(taskId, agentIdentity);

    // Directly inject events (bypassing append to preserve original timestamps/hashes)
    for (const event of events) {
      trace.events.push(event);
      trace.seq = event.seq + 1;

      if (event.type === 'TASK_RESULT') {
        trace.finalized = true;
      }
      if (event.type === 'TASK_FAILED') {
        trace.failed = true;
      }
    }

    return trace;
  }

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * Get the default storage file path.
   *
   * @returns The file path, or undefined if no storage is configured.
   */
  private getStoragePath(): string | undefined {
    if (!this.storage) return undefined;
    return join(this.storage.dir, `${this.taskId}.trace.jsonl`);
  }

  /**
   * Append a single event to the storage file.
   *
   * @param event - The event to append.
   */
  private appendEventToFile(event: TraceEvent): void {
    const path = this.getStoragePath();
    if (!path) return;

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
  }

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * Compute a simple Merkle root from a list of hex hashes.
   * Used internally for checkpoint data.
   *
   * @param leaves - Array of hex-encoded hashes.
   * @returns Hex-encoded Merkle root.
   */
  private simpleMerkleRoot(leaves: string[]): string {
    if (leaves.length === 0) return sha256('empty');
    if (leaves.length === 1) return leaves[0];

    let layer = [...leaves];
    while (layer.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (i + 1 < layer.length) {
          next.push(sha256(layer[i] + layer[i + 1]));
        } else {
          // Odd leaf — promote it
          next.push(sha256(layer[i] + layer[i]));
        }
      }
      layer = next;
    }
    return layer[0];
  }
}
