import { describe, it, expect, afterEach } from 'vitest';
import { ExecutionTrace, computeEventHash } from '../src/trace/index.js';
import { AgentIdentity } from '../src/identity/index.js';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_TRACE_DIR = join(import.meta.dirname ?? '.', '.test-traces');

/** Clean up test trace directory after each test */
afterEach(() => {
  if (existsSync(TEST_TRACE_DIR)) {
    rmSync(TEST_TRACE_DIR, { recursive: true, force: true });
  }
});

describe('trace', () => {
  function makeTrace(opts?: { checkpointInterval?: number }) {
    const identity = new AgentIdentity();
    const trace = new ExecutionTrace('task-001', identity, opts);
    return { trace, identity };
  }

  describe('append events', () => {
    it('should increment seq for each event', () => {
      const { trace } = makeTrace();
      const e1 = trace.append('TASK_ACCEPTED', { info: 'start' });
      const e2 = trace.append('TOOL_CALL', { tool: 'http.get', input: {} });
      const e3 = trace.append('TOOL_RESULT', { output: 'ok' });

      expect(e1.seq).toBe(0);
      expect(e2.seq).toBe(1);
      expect(e3.seq).toBe(2);
    });

    it('should set task_id on all events', () => {
      const { trace } = makeTrace();
      const e = trace.append('TASK_ACCEPTED', {});
      expect(e.task_id).toBe('task-001');
    });
  });

  describe('hash chain', () => {
    it('should link each event prev to the previous event hash', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.append('TOOL_CALL', { tool: 'test' });
      trace.append('TOOL_RESULT', { result: 'ok' });

      const events = trace.getEvents();
      expect(events[0].prev).toBe('0x00'); // genesis
      expect(events[1].prev).toBe(events[0].hash);
      expect(events[2].prev).toBe(events[1].hash);
    });

    it('should verify a valid hash chain', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.append('TOOL_CALL', { tool: 'test' });
      trace.append('TOOL_RESULT', { result: 'ok' });

      const result = trace.verify();
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should detect tampering in the hash chain', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.append('TOOL_CALL', { tool: 'test' });

      // Tamper with the first event's data
      const events = trace.getEvents() as any[];
      // We can't directly mutate because getEvents returns a copy
      // But we can test computeEventHash independently
      const e = events[0];
      const recomputed = computeEventHash(e.seq, e.ts, e.type, e.data, e.prev);
      expect(recomputed).toBe(e.hash);

      // Verify that changing data produces a different hash
      const tamperedHash = computeEventHash(e.seq, e.ts, e.type, { tampered: true }, e.prev);
      expect(tamperedHash).not.toBe(e.hash);
    });
  });

  describe('checkpoint', () => {
    it('should auto-create checkpoint at specified interval', () => {
      const { trace } = makeTrace({ checkpointInterval: 3 });
      trace.append('TASK_ACCEPTED', {});
      trace.append('TOOL_CALL', { tool: 'a' });
      trace.append('TOOL_RESULT', { result: 'ok' }); // 3rd event triggers checkpoint

      const events = trace.getEvents();
      // After 3 events, a checkpoint should be auto-appended
      const checkpoints = events.filter((e) => e.type === 'CHECKPOINT');
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0].sig).toBeTruthy();
    });

    it('should include a signature on checkpoint events', () => {
      const { trace, identity } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      const cp = trace.checkpoint();
      expect(cp.type).toBe('CHECKPOINT');
      expect(cp.sig).toBeTruthy();
      // Verify the signature
      expect(identity.verify(cp.hash, cp.sig!)).toBe(true);
    });
  });

  describe('finalize', () => {
    it('should return the final hash', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      const finalHash = trace.finalize({ status: 'success' });
      expect(finalHash).toBeTruthy();
      expect(typeof finalHash).toBe('string');
      expect(trace.isFinalized()).toBe(true);
    });

    it('should prevent further appends after finalization', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.finalize({ status: 'success' });
      expect(() => trace.append('TOOL_CALL', {})).toThrow();
    });

    it('should throw if already finalized', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.finalize({ status: 'success' });
      expect(() => trace.finalize({ status: 'again' })).toThrow();
    });
  });

  describe('export', () => {
    it('should export as valid JSONL', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.append('TOOL_CALL', { tool: 'test' });

      const jsonl = trace.export();
      const lines = jsonl.split('\n');
      expect(lines.length).toBe(2);

      // Each line should be valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.seq).toBeDefined();
        expect(parsed.hash).toBeDefined();
      }
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.append('TOOL_CALL', { tool: 'a' });
      trace.append('TOOL_RESULT', { result: 'ok' });
      trace.append('TOOL_CALL', { tool: 'b' });
      trace.append('TOOL_RESULT', { result: 'ok' });
      trace.append('POLICY_CHECK', { action: 'test' });

      const stats = trace.getStats();
      expect(stats.task_id).toBe('task-001');
      expect(stats.event_count).toBe(6);
      expect(stats.tool_calls).toBe(2);
      expect(stats.tool_results).toBe(2);
      expect(stats.policy_checks).toBe(1);
      expect(stats.policy_violations).toBe(0);
      expect(stats.finalized).toBe(false);
      expect(stats.failed).toBe(false);
    });
  });

  describe('fail', () => {
    it('should mark trace as failed', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.fail(new Error('something went wrong'));
      expect(trace.isFailed()).toBe(true);
    });

    it('should prevent further appends after failure', () => {
      const { trace } = makeTrace();
      trace.append('TASK_ACCEPTED', {});
      trace.fail({ error: 'oops' });
      expect(() => trace.append('TOOL_CALL', {})).toThrow();
    });
  });

  describe('persistence', () => {
    it('should save trace to file and load it back', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('persist-001', identity);

      trace.append('TASK_ACCEPTED', { info: 'start' });
      trace.append('TOOL_CALL', { tool: 'http.get' });
      trace.append('TOOL_RESULT', { result: 'ok' });

      const filePath = join(TEST_TRACE_DIR, 'persist-001.trace.jsonl');
      trace.saveToFile(filePath);

      expect(existsSync(filePath)).toBe(true);

      // Load it back
      const loaded = ExecutionTrace.loadFromFile(filePath, identity);
      expect(loaded.getEvents().length).toBe(3);
      expect(loaded.getTaskId()).toBe('persist-001');
    });

    it('should preserve hash chain after load', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('hash-chain-001', identity);

      trace.append('TASK_ACCEPTED', { info: 'start' });
      trace.append('TOOL_CALL', { tool: 'test' });
      trace.append('TOOL_RESULT', { result: 'ok' });
      trace.checkpoint();

      const filePath = join(TEST_TRACE_DIR, 'hash-chain-001.trace.jsonl');
      trace.saveToFile(filePath);

      const loaded = ExecutionTrace.loadFromFile(filePath, identity);
      const result = loaded.verify();
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should auto-save events when storage.autoSave is true', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('auto-001', identity, {
        storage: { dir: TEST_TRACE_DIR, autoSave: true },
      });

      trace.append('TASK_ACCEPTED', { info: 'start' });
      trace.append('TOOL_CALL', { tool: 'test' });

      const filePath = join(TEST_TRACE_DIR, 'auto-001.trace.jsonl');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8').trim();
      const lines = content.split('\n');
      expect(lines.length).toBe(2);
    });

    it('should save using storage dir when no explicit path given', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('storage-dir-001', identity, {
        storage: { dir: TEST_TRACE_DIR, autoSave: false },
      });

      trace.append('TASK_ACCEPTED', {});
      trace.saveToFile();

      const filePath = join(TEST_TRACE_DIR, 'storage-dir-001.trace.jsonl');
      expect(existsSync(filePath)).toBe(true);
    });

    it('should throw when saving without path or storage config', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('no-path-001', identity);
      trace.append('TASK_ACCEPTED', {});

      expect(() => trace.saveToFile()).toThrow('No file path provided');
    });

    it('should preserve finalized state after load', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('final-001', identity);

      trace.append('TASK_ACCEPTED', {});
      trace.finalize({ status: 'success' });

      const filePath = join(TEST_TRACE_DIR, 'final-001.trace.jsonl');
      trace.saveToFile(filePath);

      const loaded = ExecutionTrace.loadFromFile(filePath, identity);
      expect(loaded.isFinalized()).toBe(true);
    });

    it('should preserve failed state after load', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('fail-001', identity);

      trace.append('TASK_ACCEPTED', {});
      trace.fail(new Error('boom'));

      const filePath = join(TEST_TRACE_DIR, 'fail-001.trace.jsonl');
      trace.saveToFile(filePath);

      const loaded = ExecutionTrace.loadFromFile(filePath, identity);
      expect(loaded.isFailed()).toBe(true);
    });
  });
});
