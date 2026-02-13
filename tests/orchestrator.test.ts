import { describe, it, expect } from 'vitest';
import {
  ATELOrchestrator,
  type ExecutionResult,
} from '../src/orchestrator/index.js';
import { AgentIdentity } from '../src/identity/index.js';
import { MockAnchorProvider } from '../src/anchor/index.js';
import { ToolGateway, type ToolCallResult } from '../src/gateway/index.js';
import { ExecutionTrace } from '../src/trace/index.js';

describe('ATELOrchestrator', () => {
  describe('constructor', () => {
    it('should create an orchestrator with default config', () => {
      const orch = new ATELOrchestrator();
      expect(orch.identity).toBeDefined();
      expect(orch.identity.did).toMatch(/^did:atel:/);
      expect(orch.trustManager).toBeDefined();
      expect(orch.anchorManager).toBeDefined();
    });

    it('should accept custom agent ID and metadata', () => {
      const orch = new ATELOrchestrator({
        agentId: 'my-agent',
        metadata: { name: 'Test Agent', version: '1.0' },
      });
      expect(orch.identity.agent_id).toBe('my-agent');
      expect(orch.identity.metadata?.name).toBe('Test Agent');
    });

    it('should register anchor providers', () => {
      const orch = new ATELOrchestrator({
        anchors: [new MockAnchorProvider()],
      });
      expect(orch.anchorManager.getProviders()).toContain('mock');
    });
  });

  describe('getIdentity', () => {
    it('should return the agent identity', () => {
      const orch = new ATELOrchestrator({ agentId: 'test' });
      expect(orch.getIdentity().agent_id).toBe('test');
    });
  });

  describe('delegateTask', () => {
    it('should create a task and consent token', () => {
      const delegator = new ATELOrchestrator({ agentId: 'delegator' });
      const executor = new AgentIdentity({ agent_id: 'executor' });

      const ctx = delegator.delegateTask({
        executor,
        intent: { type: 'web_search', goal: 'Find info' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      expect(ctx.task).toBeDefined();
      expect(ctx.task.issuer).toBe(delegator.identity.did);
      expect(ctx.task.intent.type).toBe('web_search');
      expect(ctx.task.signature).toBeDefined();
      expect(ctx.consentToken).toBeDefined();
      expect(ctx.consentToken.iss).toBe(delegator.identity.did);
      expect(ctx.consentToken.sub).toBe(executor.did);
    });

    it('should accept executor as DID string', () => {
      const delegator = new ATELOrchestrator();
      const ctx = delegator.delegateTask({
        executor: 'did:atel:someExecutor',
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });
      expect(ctx.consentToken.sub).toBe('did:atel:someExecutor');
    });

    it('should serialize the delegation context', () => {
      const delegator = new ATELOrchestrator();
      const ctx = delegator.delegateTask({
        executor: 'did:atel:exec',
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });
      const serialized = ctx.serialize();
      const parsed = JSON.parse(serialized);
      expect(parsed.task).toBeDefined();
      expect(parsed.consentToken).toBeDefined();
    });
  });

  describe('executeTask', () => {
    it('should execute a task with automatic tracing and proof', async () => {
      const delegator = new ATELOrchestrator({ agentId: 'delegator' });
      const executor = new ATELOrchestrator({ agentId: 'executor' });

      // Delegate
      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'web_search', goal: 'Find ATEL news' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      // Execute
      const result = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async (input: unknown) => ({
            results: [{ title: 'ATEL News', url: 'https://atel.dev' }],
          }),
        },
        execute: async (gateway, trace) => {
          const res = await gateway.callTool({
            tool: 'http.get',
            input: { url: 'https://api.example.com/search' },
          });
          return { searchResults: res.output };
        },
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.proof).toBeDefined();
      expect(result.proof.proof_id).toBeTruthy();
      expect(result.proof.executor).toBe(executor.identity.did);
      expect(result.trace).toBeDefined();
      expect(result.trace.isFinalized()).toBe(true);
      expect(result.anchor).toBeDefined();
      expect(result.anchor.anchored).toBe(false);
      expect(result.anchor.anchoredHash).toBe(result.proof.trace_root);
      expect(result.trustSync.mode).toBe('local-only');
      expect(result.trustSync.localUpdated).toBe(true);
      expect(result.trustSync.networkSynced).toBe(false);
    });

    it('should handle execution failures gracefully', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator();

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const result = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => { throw new Error('Network error'); },
        },
        execute: async (gateway) => {
          await gateway.callTool({ tool: 'http.get', input: {} });
        },
      });

      // The tool error is caught by gateway (status: 'error'), not thrown
      // So the execute function itself succeeds
      expect(result.proof).toBeDefined();
    });

    it('should anchor proof when providers are available', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator({
        anchors: [new MockAnchorProvider()],
      });

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const result = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => ({ ok: true }),
        },
        execute: async (gateway) => {
          return gateway.callTool({ tool: 'http.get', input: {} });
        },
      });

      expect(result.anchorRecords).toBeDefined();
      expect(result.anchorRecords!.length).toBeGreaterThan(0);
      expect(result.anchorRecords![0].chain).toBe('mock');
      expect(result.anchor.anchored).toBe(true);
      expect(result.anchor.records.length).toBeGreaterThan(0);
      expect(result.anchor.records[0].anchorVerified).toBe(true);
      expect(result.anchor.verificationPassed).toBe(true);
      expect(result.trustSync.mode).toBe('local-only');
    });

    it('should update trust after execution', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator();

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => ({ ok: true }),
        },
        execute: async (gateway) => {
          return gateway.callTool({ tool: 'http.get', input: {} });
        },
      });

      const score = executor.trustManager.getAgentScore(executor.identity.did);
      expect(score.total_tasks).toBe(1);
    });

    it('should reject execution when consent token subject mismatches executor', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator();
      const otherExecutor = new AgentIdentity();

      const ctx = delegator.delegateTask({
        executor: otherExecutor,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      await expect(
        executor.executeTask({
          task: ctx.task,
          consentToken: ctx.consentToken,
          tools: {
            'http.get': async () => ({ ok: true }),
          },
          execute: async (gateway) => gateway.callTool({ tool: 'http.get', input: {} }),
        }),
      ).rejects.toThrow('subject does not match executor DID');
    });

    it('should reject execution when task signature is tampered', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator();

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const tamperedTask = {
        ...ctx.task,
        intent: { ...ctx.task.intent, goal: 'tampered goal' },
      };

      await expect(
        executor.executeTask({
          task: tamperedTask,
          consentToken: ctx.consentToken,
          tools: {
            'http.get': async () => ({ ok: true }),
          },
          execute: async (gateway) => gateway.callTool({ tool: 'http.get', input: {} }),
        }),
      ).rejects.toThrow('Invalid task signature');
    });

    it('should sync trust to optional network adapter when configured', async () => {
      const calls: Array<{ task_id: string }> = [];
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator({
        trustSync: {
          submit: async (submission) => {
            calls.push({ task_id: submission.task_id });
            return {
              synced: true,
              reference: `sync:${submission.task_id}`,
              detail: 'ok',
            };
          },
        },
      });

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const result = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => ({ ok: true }),
        },
        execute: async (gateway) => gateway.callTool({ tool: 'http.get', input: {} }),
      });

      expect(calls.length).toBe(1);
      expect(result.trustSync.mode).toBe('local+network');
      expect(result.trustSync.networkSynced).toBe(true);
      expect(result.trustSync.reference).toContain('sync:');
    });

    it('should degrade gracefully when network trust sync fails', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator({
        trustSync: {
          submit: async () => {
            throw new Error('network unavailable');
          },
        },
      });

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const result = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => ({ ok: true }),
        },
        execute: async (gateway) => gateway.callTool({ tool: 'http.get', input: {} }),
      });

      expect(result.success).toBe(true);
      expect(result.trustSync.mode).toBe('local+network');
      expect(result.trustSync.localUpdated).toBe(true);
      expect(result.trustSync.networkSynced).toBe(false);
      expect(result.trustSync.detail).toContain('network unavailable');
    });
  });

  describe('verifyExecution', () => {
    it('should verify a valid proof', async () => {
      const delegator = new ATELOrchestrator();
      const executor = new ATELOrchestrator();

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const execResult = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => ({ ok: true }),
        },
        execute: async (gateway) => {
          return gateway.callTool({ tool: 'http.get', input: {} });
        },
      });

      const verifyResult = await delegator.verifyExecution(execResult.proof, {
        trace: execResult.trace,
      });

      expect(verifyResult.proofValid).toBe(true);
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.report).toBeDefined();
    });

    it('should verify with anchor chain', async () => {
      const mock = new MockAnchorProvider();
      const delegator = new ATELOrchestrator({ anchors: [mock] });
      const executor = new ATELOrchestrator({ anchors: [mock] });

      const ctx = delegator.delegateTask({
        executor: executor.identity,
        intent: { type: 'test', goal: 'test' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
      });

      const execResult = await executor.executeTask({
        task: ctx.task,
        consentToken: ctx.consentToken,
        tools: {
          'http.get': async () => ({ ok: true }),
        },
        execute: async (gateway) => {
          return gateway.callTool({ tool: 'http.get', input: {} });
        },
      });

      const verifyResult = await delegator.verifyExecution(execResult.proof, {
        trace: execResult.trace,
        anchorChain: 'mock',
      });

      expect(verifyResult.proofValid).toBe(true);
      expect(verifyResult.anchorValid).toBe(true);
    });
  });

  describe('end-to-end workflow', () => {
    it('should complete delegate → execute → verify cycle', async () => {
      const sharedMock = new MockAnchorProvider();

      const alice = new ATELOrchestrator({
        agentId: 'alice',
        metadata: { name: 'Alice', description: 'Travel Planner' },
        anchors: [sharedMock],
      });

      const bob = new ATELOrchestrator({
        agentId: 'bob',
        metadata: { name: 'Bob', description: 'Flight Expert' },
        anchors: [sharedMock],
      });

      // Alice delegates to Bob
      const delegation = alice.delegateTask({
        executor: bob.identity,
        intent: { type: 'flight_search', goal: 'Find flights SIN→HND' },
        risk: 'low',
        scopes: ['tool:http:get', 'data:public_web:read'],
        maxCost: 0.5,
      });

      // Bob executes
      const execResult = await bob.executeTask({
        task: delegation.task,
        consentToken: delegation.consentToken,
        tools: {
          'http.get': async () => ({
            flights: [
              { airline: 'SQ', flight: 'SQ638', price: 580 },
              { airline: 'ANA', flight: 'NH842', price: 520 },
            ],
          }),
        },
        execute: async (gateway) => {
          const res = await gateway.callTool({
            tool: 'http.get',
            input: { url: 'https://flights.example.com/search' },
          });
          return res.output;
        },
      });

      expect(execResult.success).toBe(true);
      expect(execResult.proof).toBeDefined();
      expect(execResult.anchorRecords).toBeDefined();

      // Alice verifies
      const verification = await alice.verifyExecution(execResult.proof, {
        trace: execResult.trace,
        anchorChain: 'mock',
      });

      expect(verification.valid).toBe(true);
      expect(verification.proofValid).toBe(true);
      expect(verification.anchorValid).toBe(true);
    });
  });
});
