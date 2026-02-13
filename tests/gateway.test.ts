import { describe, it, expect } from 'vitest';
import {
  ToolGateway,
  computeHash,
  serializeForHash,
  ToolNotFoundError,
  UnauthorizedError,
  RealHttpTool,
} from '../src/gateway/index.js';
import type {
  GatewayPolicyEngine,
  GatewayPolicyDecision,
} from '../src/gateway/index.js';
import { AgentIdentity } from '../src/identity/index.js';
import { mintConsentToken, PolicyEngine } from '../src/policy/index.js';

// Simple allow-all policy engine for testing
function makeAllowPolicy(): GatewayPolicyEngine {
  return {
    evaluate: (): GatewayPolicyDecision => ({ decision: 'allow' }),
  };
}

// Deny-all policy engine
function makeDenyPolicy(reason = 'denied'): GatewayPolicyEngine {
  return {
    evaluate: (): GatewayPolicyDecision => ({ decision: 'deny', reason }),
  };
}

describe('gateway', () => {
  describe('registerTool and callTool', () => {
    it('should register a tool and call it successfully', async () => {
      const gw = new ToolGateway(makeAllowPolicy());
      gw.registerTool('echo', async (input) => ({ echoed: input }));

      const result = await gw.callTool({
        tool: 'echo',
        input: { message: 'hello' },
        consentToken: 'token',
      });

      expect(result.status).toBe('ok');
      expect(result.output).toEqual({ echoed: { message: 'hello' } });
      expect(result.input_hash).toBeTruthy();
      expect(result.output_hash).toBeTruthy();
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should throw ToolNotFoundError for unregistered tool', async () => {
      const gw = new ToolGateway(makeAllowPolicy());
      await expect(
        gw.callTool({ tool: 'nonexistent', input: {}, consentToken: 'token' })
      ).rejects.toThrow(ToolNotFoundError);
    });

    it('should throw when registering a duplicate tool name', () => {
      const gw = new ToolGateway(makeAllowPolicy());
      gw.registerTool('dup', async () => ({}));
      expect(() => gw.registerTool('dup', async () => ({}))).toThrow();
    });
  });

  describe('policy enforcement', () => {
    it('should throw UnauthorizedError when policy denies', async () => {
      const gw = new ToolGateway(makeDenyPolicy('not allowed'));
      gw.registerTool('secret', async () => ({ data: 'classified' }));

      await expect(
        gw.callTool({ tool: 'secret', input: {}, consentToken: 'token' })
      ).rejects.toThrow(UnauthorizedError);
    });

    it('should pass risk level to PolicyEngine adapter and deny high-risk call', async () => {
      const issuer = new AgentIdentity();
      const executor = new AgentIdentity();
      const token = mintConsentToken(
        issuer.did,
        executor.did,
        ['tool:http:get', 'data:public_web:read'],
        { max_calls: 5, ttl_sec: 3600 },
        'low',
        issuer.secretKey,
      );
      const gw = new ToolGateway(new PolicyEngine(token), {
        defaultRiskLevel: 'low',
      });
      gw.registerTool('http.get', async () => ({ ok: true }));

      await expect(
        gw.callTool({
          tool: 'http.get',
          input: { url: 'https://example.com' },
          risk_level: 'high',
        }),
      ).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('call log', () => {
    it('should record calls in the log', async () => {
      const gw = new ToolGateway(makeAllowPolicy());
      gw.registerTool('add', async (input: any) => ({
        sum: input.a + input.b,
      }));

      await gw.callTool({ tool: 'add', input: { a: 1, b: 2 }, consentToken: 'tok' });
      await gw.callTool({ tool: 'add', input: { a: 3, b: 4 }, consentToken: 'tok' });

      const log = gw.getCallLog();
      expect(log.length).toBe(2);
      expect(log[0].tool).toBe('add');
      expect(log[0].status).toBe('ok');
      expect(log[1].tool).toBe('add');
      expect(gw.getCallCount()).toBe(2);
    });
  });

  describe('input_hash and output_hash', () => {
    it('should compute deterministic hashes', async () => {
      const gw = new ToolGateway(makeAllowPolicy());
      gw.registerTool('identity', async (input) => input);

      const input = { x: 1, y: 2 };
      const result = await gw.callTool({ tool: 'identity', input, consentToken: 'tok' });

      expect(result.input_hash).toBe(computeHash(input));
      expect(result.output_hash).toBe(computeHash(input)); // output === input
    });

    it('should produce same hash for same data regardless of key order', () => {
      const hash1 = computeHash({ b: 2, a: 1 });
      const hash2 = computeHash({ a: 1, b: 2 });
      expect(hash1).toBe(hash2);
    });
  });

  describe('tool execution error', () => {
    it('should capture errors and record them in the log', async () => {
      const gw = new ToolGateway(makeAllowPolicy());
      gw.registerTool('fail', async () => {
        throw new Error('boom');
      });

      const result = await gw.callTool({ tool: 'fail', input: {}, consentToken: 'tok' });
      expect(result.status).toBe('error');
      expect((result.output as any).error).toBe('boom');

      const log = gw.getCallLog();
      expect(log[0].status).toBe('error');
    });
  });

  describe('serializeForHash', () => {
    it('should serialize primitives', () => {
      expect(serializeForHash(42)).toBe('42');
      expect(serializeForHash('hello')).toBe('"hello"');
      expect(serializeForHash(null)).toBe('null');
      expect(serializeForHash(true)).toBe('true');
    });

    it('should serialize arrays', () => {
      expect(serializeForHash([1, 2, 3])).toBe('[1,2,3]');
    });

    it('should serialize objects with sorted keys', () => {
      expect(serializeForHash({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    });
  });

  describe('RealHttpTool', () => {
    it('should perform a real GET request', async () => {
      const result = await RealHttpTool.get('https://jsonplaceholder.typicode.com/posts/1');
      expect(result.status).toBe(200);
      expect(result.body).toBeDefined();
      expect((result.body as any).id).toBe(1);
      expect(result.headers).toBeDefined();
    });

    it('should perform a real POST request', async () => {
      const result = await RealHttpTool.post(
        'https://jsonplaceholder.typicode.com/posts',
        { title: 'test', body: 'hello', userId: 1 },
      );
      expect(result.status).toBe(201);
      expect(result.body).toBeDefined();
      expect((result.body as any).title).toBe('test');
    });

    it('should pass custom headers on GET', async () => {
      const result = await RealHttpTool.get(
        'https://jsonplaceholder.typicode.com/posts/1',
        { 'Accept': 'application/json' },
      );
      expect(result.status).toBe(200);
    });

    it('should register on a ToolGateway and work via callTool', async () => {
      const gw = new ToolGateway(makeAllowPolicy());
      RealHttpTool.register(gw);

      const result = await gw.callTool({
        tool: 'http.get',
        input: { url: 'https://jsonplaceholder.typicode.com/posts/1' },
        consentToken: 'token',
      });

      expect(result.status).toBe('ok');
      expect((result.output as any).status).toBe(200);
      expect((result.output as any).body.id).toBe(1);
    });
  });
});
