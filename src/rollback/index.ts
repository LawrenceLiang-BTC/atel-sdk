/**
 * Module: Rollback Manager
 *
 * Manages compensation actions for undoing side effects when
 * a task fails or is cancelled. Actions are executed in reverse
 * order (LIFO) to properly unwind nested operations.
 */

import { randomUUID } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────

/** A registered compensation action */
export interface CompensationAction {
  /** Unique identifier */
  id: string;
  /** Human-readable description of what this action undoes */
  description: string;
  /** The compensation function to execute */
  execute: () => Promise<void>;
  /** Current status */
  status: 'pending' | 'completed' | 'failed';
  /** Error message if the action failed */
  error?: string;
  /** ISO 8601 timestamp when the action was registered */
  registeredAt: string;
  /** ISO 8601 timestamp when the action was executed */
  executedAt?: string;
}

/** Summary report after a rollback operation */
export interface RollbackReport {
  /** Total number of compensation actions attempted */
  total: number;
  /** Number of actions that completed successfully */
  succeeded: number;
  /** Number of actions that failed */
  failed: number;
  /** All actions with their final statuses */
  actions: CompensationAction[];
}

// ─── RollbackManager ─────────────────────────────────────────────

/**
 * Manages compensation actions for rollback on failure.
 *
 * Usage:
 * 1. After each side-effecting operation, call `registerCompensation()`
 *    with a function that undoes the operation.
 * 2. If the task fails, call `rollback()` to execute all compensations
 *    in reverse order (last registered = first executed).
 * 3. If the task succeeds, call `clear()` to discard all compensations.
 */
export class RollbackManager {
  private actions: CompensationAction[] = [];

  /**
   * Register a compensation action.
   *
   * @param description - Human-readable description (e.g. "Delete created order #123").
   * @param compensateFn - Async function that undoes the side effect.
   * @returns The unique ID of the registered action.
   */
  registerCompensation(description: string, compensateFn: () => Promise<void>): string {
    const id = randomUUID();
    this.actions.push({
      id,
      description,
      execute: compensateFn,
      status: 'pending',
      registeredAt: new Date().toISOString(),
    });
    return id;
  }

  /**
   * Execute all compensation actions in reverse order (LIFO).
   *
   * Each action is attempted regardless of whether previous actions
   * succeeded or failed, ensuring maximum rollback coverage.
   *
   * @returns A RollbackReport summarizing the results.
   */
  async rollback(): Promise<RollbackReport> {
    let succeeded = 0;
    let failed = 0;

    // Execute in reverse order
    const reversed = [...this.actions].reverse();

    for (const action of reversed) {
      if (action.status !== 'pending') continue;

      try {
        await action.execute();
        action.status = 'completed';
        action.executedAt = new Date().toISOString();
        succeeded++;
      } catch (err) {
        action.status = 'failed';
        action.error = err instanceof Error ? err.message : String(err);
        action.executedAt = new Date().toISOString();
        failed++;
      }
    }

    return {
      total: succeeded + failed,
      succeeded,
      failed,
      actions: [...this.actions],
    };
  }

  /**
   * Get all registered compensation actions.
   *
   * @returns A copy of the actions array.
   */
  getActions(): CompensationAction[] {
    return [...this.actions];
  }

  /**
   * Clear all registered compensation actions.
   * Call this after a task completes successfully.
   */
  clear(): void {
    this.actions = [];
  }
}
