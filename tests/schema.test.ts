import { describe, it, expect } from 'vitest';
import {
  validateTask,
  validateCapability,
  createTask,
  createCapability,
  matchTaskToCapability,
  SchemaValidationError,
} from '../src/schema/index.js';
import type { Task, Capability } from '../src/schema/index.js';
import { AgentIdentity } from '../src/identity/index.js';

// Helper: create a valid issuer DID
function makeDID(): string {
  return new AgentIdentity().did;
}

describe('schema', () => {
  describe('validateTask', () => {
    it('should validate a valid Task', () => {
      const task: Task = {
        task_id: '550e8400-e29b-41d4-a716-446655440000',
        version: 'task.v0.1',
        issuer: makeDID(),
        intent: { type: 'http.get', goal: 'Fetch data' },
        risk: { level: 'low' },
        nonce: 'some-nonce',
      };
      const result = validateTask(task);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject a Task missing required fields', () => {
      const result = validateTask({
        task_id: '550e8400-e29b-41d4-a716-446655440000',
        version: 'task.v0.1',
        // missing issuer, intent, risk, nonce
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should reject a Task with invalid risk level', () => {
      const result = validateTask({
        task_id: '550e8400-e29b-41d4-a716-446655440000',
        version: 'task.v0.1',
        issuer: makeDID(),
        intent: { type: 'test', goal: 'test' },
        risk: { level: 'extreme' }, // invalid
        nonce: 'nonce',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateCapability', () => {
    it('should validate a valid Capability', () => {
      const cap: Capability = {
        cap_id: '550e8400-e29b-41d4-a716-446655440000',
        version: 'cap.v0.1',
        provider: makeDID(),
        capabilities: [
          { type: 'http.get', description: 'HTTP GET requests' },
        ],
      };
      const result = validateCapability(cap);
      expect(result.valid).toBe(true);
    });

    it('should reject a Capability missing required fields', () => {
      const result = validateCapability({
        cap_id: '550e8400-e29b-41d4-a716-446655440000',
        version: 'cap.v0.1',
        // missing provider, capabilities
      });
      expect(result.valid).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should reject a Capability with empty capabilities array', () => {
      const result = validateCapability({
        cap_id: '550e8400-e29b-41d4-a716-446655440000',
        version: 'cap.v0.1',
        provider: makeDID(),
        capabilities: [],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('createTask', () => {
    it('should generate a valid Task with auto-generated IDs', () => {
      const did = makeDID();
      const task = createTask({
        issuer: did,
        intent: { type: 'http.get', goal: 'Fetch data from API' },
        risk: { level: 'low' },
      });
      expect(task.task_id).toBeTruthy();
      expect(task.version).toBe('task.v0.1');
      expect(task.issuer).toBe(did);
      expect(task.nonce).toBeTruthy();
      expect(task.intent.type).toBe('http.get');
      // Validate the created task
      expect(validateTask(task).valid).toBe(true);
    });

    it('should include optional fields when provided', () => {
      const task = createTask({
        issuer: makeDID(),
        intent: { type: 'test', goal: 'test' },
        risk: { level: 'medium' },
        economics: { max_cost: 10, currency: 'USD', settlement: 'offchain' },
        deadline: '2030-01-01T00:00:00Z',
      });
      expect(task.economics).toBeDefined();
      expect(task.economics!.max_cost).toBe(10);
      expect(task.deadline).toBe('2030-01-01T00:00:00Z');
    });
  });

  describe('createCapability', () => {
    it('should generate a valid Capability with auto-generated ID', () => {
      const did = makeDID();
      const cap = createCapability({
        provider: did,
        capabilities: [
          { type: 'http.get', description: 'HTTP GET' },
        ],
      });
      expect(cap.cap_id).toBeTruthy();
      expect(cap.version).toBe('cap.v0.1');
      expect(cap.provider).toBe(did);
      expect(cap.capabilities.length).toBe(1);
      expect(validateCapability(cap).valid).toBe(true);
    });
  });

  describe('matchTaskToCapability', () => {
    const providerDID = makeDID();

    it('should match when types align', () => {
      const task = createTask({
        issuer: makeDID(),
        intent: { type: 'http.get', goal: 'Fetch data' },
        risk: { level: 'low' },
      });
      const cap = createCapability({
        provider: providerDID,
        capabilities: [
          { type: 'http.get', description: 'HTTP GET requests' },
        ],
      });
      const result = matchTaskToCapability(task, cap);
      expect(result.matched).toBe(true);
      expect(result.matchedCapabilities.length).toBe(1);
    });

    it('should fail when types do not match', () => {
      const task = createTask({
        issuer: makeDID(),
        intent: { type: 'http.post', goal: 'Post data' },
        risk: { level: 'low' },
      });
      const cap = createCapability({
        provider: providerDID,
        capabilities: [
          { type: 'http.get', description: 'HTTP GET only' },
        ],
      });
      const result = matchTaskToCapability(task, cap);
      expect(result.matched).toBe(false);
      expect(result.reasons).toBeDefined();
      expect(result.reasons!.length).toBeGreaterThan(0);
    });

    it('should fail when task risk exceeds capability max risk', () => {
      const task = createTask({
        issuer: makeDID(),
        intent: { type: 'http.get', goal: 'Fetch data' },
        risk: { level: 'high' },
      });
      const cap = createCapability({
        provider: providerDID,
        capabilities: [
          {
            type: 'http.get',
            description: 'HTTP GET',
            constraints: { max_risk_level: 'low' },
          },
        ],
      });
      const result = matchTaskToCapability(task, cap);
      expect(result.matched).toBe(false);
      expect(result.reasons!.some((r) => r.includes('risk'))).toBe(true);
    });

    it('should match when task risk is within capability max risk', () => {
      const task = createTask({
        issuer: makeDID(),
        intent: { type: 'http.get', goal: 'Fetch data' },
        risk: { level: 'medium' },
      });
      const cap = createCapability({
        provider: providerDID,
        capabilities: [
          {
            type: 'http.get',
            description: 'HTTP GET',
            constraints: { max_risk_level: 'high' },
          },
        ],
      });
      const result = matchTaskToCapability(task, cap);
      expect(result.matched).toBe(true);
    });
  });
});
