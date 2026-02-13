import { describe, it, expect } from 'vitest';
import { RollbackManager } from '../src/rollback/index.js';

describe('rollback', () => {
  describe('registerCompensation', () => {
    it('should register a compensation action and return an id', () => {
      const mgr = new RollbackManager();
      const id = mgr.registerCompensation('undo something', async () => {});
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should store actions with pending status', () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('action 1', async () => {});
      mgr.registerCompensation('action 2', async () => {});

      const actions = mgr.getActions();
      expect(actions.length).toBe(2);
      expect(actions[0].status).toBe('pending');
      expect(actions[1].status).toBe('pending');
      expect(actions[0].description).toBe('action 1');
      expect(actions[1].description).toBe('action 2');
    });

    it('should set registeredAt timestamp', () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('test', async () => {});
      const action = mgr.getActions()[0];
      expect(action.registeredAt).toBeTruthy();
      expect(new Date(action.registeredAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('rollback', () => {
    it('should execute actions in reverse order (LIFO)', async () => {
      const order: number[] = [];
      const mgr = new RollbackManager();

      mgr.registerCompensation('first', async () => { order.push(1); });
      mgr.registerCompensation('second', async () => { order.push(2); });
      mgr.registerCompensation('third', async () => { order.push(3); });

      await mgr.rollback();
      expect(order).toEqual([3, 2, 1]);
    });

    it('should mark successful actions as completed', async () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('undo', async () => {});

      const report = await mgr.rollback();
      expect(report.succeeded).toBe(1);
      expect(report.failed).toBe(0);
      expect(report.actions[0].status).toBe('completed');
      expect(report.actions[0].executedAt).toBeTruthy();
    });

    it('should handle partial failures gracefully', async () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('ok-1', async () => {});
      mgr.registerCompensation('fail', async () => { throw new Error('compensation failed'); });
      mgr.registerCompensation('ok-2', async () => {});

      const report = await mgr.rollback();
      expect(report.total).toBe(3);
      expect(report.succeeded).toBe(2);
      expect(report.failed).toBe(1);

      // The failed action should have error info
      const failedAction = report.actions.find((a) => a.description === 'fail');
      expect(failedAction?.status).toBe('failed');
      expect(failedAction?.error).toBe('compensation failed');
    });

    it('should continue executing remaining actions even after a failure', async () => {
      const executed: string[] = [];
      const mgr = new RollbackManager();

      mgr.registerCompensation('first', async () => { executed.push('first'); });
      mgr.registerCompensation('fail', async () => { throw new Error('boom'); });
      mgr.registerCompensation('last', async () => { executed.push('last'); });

      await mgr.rollback();
      // All three should be attempted (reverse order: last, fail, first)
      expect(executed).toEqual(['last', 'first']);
    });

    it('should return correct report with zero actions', async () => {
      const mgr = new RollbackManager();
      const report = await mgr.rollback();
      expect(report.total).toBe(0);
      expect(report.succeeded).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.actions).toEqual([]);
    });
  });

  describe('getActions', () => {
    it('should return a copy of the actions array', () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('test', async () => {});
      const actions1 = mgr.getActions();
      const actions2 = mgr.getActions();
      expect(actions1).not.toBe(actions2);
      expect(actions1).toEqual(actions2);
    });
  });

  describe('clear', () => {
    it('should remove all registered actions', () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('a', async () => {});
      mgr.registerCompensation('b', async () => {});
      expect(mgr.getActions().length).toBe(2);

      mgr.clear();
      expect(mgr.getActions().length).toBe(0);
    });

    it('should allow new registrations after clear', () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('old', async () => {});
      mgr.clear();
      mgr.registerCompensation('new', async () => {});
      expect(mgr.getActions().length).toBe(1);
      expect(mgr.getActions()[0].description).toBe('new');
    });
  });

  describe('rollback report', () => {
    it('should include all actions with correct statuses', async () => {
      const mgr = new RollbackManager();
      mgr.registerCompensation('success-1', async () => {});
      mgr.registerCompensation('fail-1', async () => { throw new Error('err'); });
      mgr.registerCompensation('success-2', async () => {});

      const report = await mgr.rollback();
      expect(report.total).toBe(3);
      expect(report.actions.length).toBe(3);

      const statuses = report.actions.map((a) => a.status);
      expect(statuses.filter((s) => s === 'completed').length).toBe(2);
      expect(statuses.filter((s) => s === 'failed').length).toBe(1);
    });
  });
});
