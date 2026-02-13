/**
 * Module 4: Tool Gateway
 *
 * All external tool/API calls MUST pass through the ToolGateway.
 * It enforces policy checks, records call logs, and computes
 * deterministic hashes for every input/output pair.
 */

import { createHash } from 'node:crypto';
import type { PolicyEngine } from '../policy/index.js';
import type { ExecutionTrace } from '../trace/index.js';
import type { RiskLevel } from '../schema/index.js';

// ─── Interfaces from Module 2/3 (aligned during integration) ────

/** PolicyEngine adapter interface for the gateway */
export interface GatewayPolicyEngine {
  evaluate(action: GatewayProposedAction, context?: Record<string, unknown>): GatewayPolicyDecision;
}

/** A proposed action derived from the tool call */
export interface GatewayProposedAction {
  type: string;
  resource: string;
  parameters?: Record<string, unknown>;
}

/** Result of a policy evaluation */
export interface GatewayPolicyDecision {
  decision: 'allow' | 'deny' | 'needs_confirm';
  reason?: string;
  matched_rule?: string;
}

// ─── Gateway Types ───────────────────────────────────────────────

/** Request to invoke a tool through the gateway */
export interface ToolCallRequest {
  /** Tool name, e.g. "http.get" */
  tool: string;
  /** Arbitrary input payload for the tool */
  input: unknown;
  /** Risk level of this specific call (defaults to gateway default). */
  risk_level?: RiskLevel;
  /** Data scope for this call (e.g. "public_web:read"). */
  data_scope?: string;
  /**
   * Serialized Consent Token proving user authorization.
   * Optional if the ToolGateway was constructed with a PolicyEngine
   * (the token is already embedded in the engine).
   */
  consentToken?: string;
}

/** Options for ToolGateway construction */
export interface ToolGatewayOptions {
  /** If provided, tool calls are automatically recorded in this trace */
  trace?: ExecutionTrace;
  /**
   * Default data scope used when adapting PolicyEngine to GatewayPolicyEngine.
   * Defaults to '*'.
   */
  defaultDataScope?: string;
  /**
   * Default risk level used when adapting a PolicyEngine.
   * Defaults to "low".
   */
  defaultRiskLevel?: RiskLevel;
}

/**
 * Create a GatewayPolicyEngine adapter from a PolicyEngine instance.
 *
 * This bridges the gap between the Policy module's `PolicyEngine` and
 * the Gateway module's `GatewayPolicyEngine` interface, so users don't
 * need to write their own adapter.
 *
 * @param policyEngine - The PolicyEngine to adapt.
 * @param defaultDataScope - Default data scope for action mapping. If not provided,
 *   the adapter extracts the first `data:*` scope from the consent token.
 * @returns A GatewayPolicyEngine that delegates to the PolicyEngine.
 */
export function createGatewayPolicy(
  policyEngine: PolicyEngine,
  defaultDataScope?: string,
): GatewayPolicyEngine {
  // Extract data scope from consent token if not explicitly provided
  const dataScope = defaultDataScope ?? extractDataScope(policyEngine);

  return {
    evaluate(action: GatewayProposedAction, context?: Record<string, unknown>): GatewayPolicyDecision {
      const requestedDataScope = typeof context?.data_scope === 'string'
        ? context.data_scope
        : dataScope;
      const requestedRisk = typeof context?.risk_level === 'string' && isRiskLevel(context.risk_level)
        ? context.risk_level
        : 'low';
      const policyAction = {
        tool: action.type,
        method: action.resource,
        dataScope: requestedDataScope,
      };
      const decision = policyEngine.evaluate(policyAction, requestedRisk);
      if (decision === 'allow') {
        policyEngine.recordCall();
      }
      return {
        decision,
        reason: decision === 'deny'
          ? 'Policy denied this action'
          : decision === 'needs_confirm'
            ? 'User confirmation required'
            : undefined,
      };
    },
  };
}

/**
 * Extract the data scope from a PolicyEngine's consent token.
 * Looks for the first scope starting with "data:" and strips the prefix.
 */
function extractDataScope(policyEngine: PolicyEngine): string {
  const token = policyEngine.getToken();
  for (const scope of token.scopes) {
    if (scope.startsWith('data:')) {
      return scope.slice(5); // Remove "data:" prefix
    }
  }
  return '*';
}

function isRiskLevel(value: string): value is RiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

/** Result returned after a successful tool invocation */
export interface ToolCallResult {
  output: unknown;
  status: 'ok' | 'error' | 'timeout';
  duration_ms: number;
  /** SHA-256 of deterministic-serialized input */
  input_hash: string;
  /** SHA-256 of deterministic-serialized output */
  output_hash: string;
}

/** A handler function that implements a tool */
export type ToolHandler = (input: unknown) => Promise<unknown>;

/** Internal log entry for every call that passes through the gateway */
export interface CallLogEntry {
  tool: string;
  input_hash: string;
  output_hash: string;
  status: 'ok' | 'error' | 'timeout';
  duration_ms: number;
  timestamp: string;
}

// ─── Custom Errors ───────────────────────────────────────────────

/** Thrown when a policy evaluation returns "deny" */
export class UnauthorizedError extends Error {
  public readonly tool: string;
  public readonly reason: string;

  constructor(tool: string, reason: string) {
    super(`Unauthorized: tool "${tool}" denied — ${reason}`);
    this.name = 'UnauthorizedError';
    this.tool = tool;
    this.reason = reason;
  }
}

/** Thrown when a policy evaluation returns "needs_confirm" */
export class ConfirmationRequiredError extends Error {
  public readonly tool: string;
  public readonly reason: string;

  constructor(tool: string, reason: string) {
    super(`Confirmation required: tool "${tool}" — ${reason}`);
    this.name = 'ConfirmationRequiredError';
    this.tool = tool;
    this.reason = reason;
  }
}

/** Thrown when a tool is not registered */
export class ToolNotFoundError extends Error {
  constructor(tool: string) {
    super(`Tool not found: "${tool}"`);
    this.name = 'ToolNotFoundError';
  }
}

// ─── Deterministic Serialization & Hashing ───────────────────────

/**
 * Deterministic JSON serialization (simplified RFC 8785).
 * Recursively sorts object keys then stringifies.
 *
 * @param obj - The value to serialize.
 * @returns A deterministic JSON string.
 */
export function serializeForHash(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }

  if (typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const items = obj.map((item) => serializeForHash(item));
    return `[${items.join(',')}]`;
  }

  // Object — sort keys
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${serializeForHash(record[key])}`
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Compute SHA-256 hash of arbitrary data.
 * Data is first deterministically serialized, then hashed.
 *
 * @param data - The value to hash.
 * @returns Hex-encoded SHA-256 digest.
 */
export function computeHash(data: unknown): string {
  const serialized = serializeForHash(data);
  return createHash('sha256').update(serialized, 'utf-8').digest('hex');
}

// ─── Tool Gateway ────────────────────────────────────────────────

/**
 * Central gateway for all tool invocations.
 *
 * Every call is:
 * 1. Policy-checked via the injected PolicyEngine
 * 2. Logged with deterministic input/output hashes
 * 3. Returned as a ToolCallResult
 *
 * Accepts either a `GatewayPolicyEngine` or a `PolicyEngine` from the
 * policy module. When a `PolicyEngine` is provided, it is automatically
 * adapted via {@link createGatewayPolicy}.
 */
export class ToolGateway {
  private readonly policyEngine: GatewayPolicyEngine;
  private readonly tools: Map<string, ToolHandler> = new Map();
  private readonly callLog: CallLogEntry[] = [];
  private callCount: number = 0;
  private readonly trace?: ExecutionTrace;
  private readonly defaultRiskLevel: RiskLevel;

  /**
   * @param policyEngine - A GatewayPolicyEngine or PolicyEngine instance.
   *   If a PolicyEngine is provided, it is automatically adapted.
   * @param options - Optional configuration (trace integration, etc.).
   */
  constructor(policyEngine: GatewayPolicyEngine | PolicyEngine, options?: ToolGatewayOptions) {
    // Duck-type check: PolicyEngine has `getToken` and `recordCall` methods
    if (isPolicyEngine(policyEngine)) {
      this.policyEngine = createGatewayPolicy(policyEngine, options?.defaultDataScope);
    } else {
      this.policyEngine = policyEngine;
    }
    this.trace = options?.trace;
    this.defaultRiskLevel = options?.defaultRiskLevel ?? 'low';
  }

  /**
   * Register a tool handler under a given name.
   *
   * @param name - Unique tool identifier (e.g. "http.get").
   * @param handler - Async function that executes the tool logic.
   */
  registerTool(name: string, handler: ToolHandler): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools.set(name, handler);
  }

  /**
   * Invoke a tool through the gateway.
   *
   * Flow:
   * 1. Parse tool name into a ProposedAction
   * 2. Evaluate against PolicyEngine
   * 3. Deny → throw UnauthorizedError
   * 4. needs_confirm → throw ConfirmationRequiredError
   * 5. allow → execute handler, compute hashes, return result
   *
   * @param request - The tool call request.
   * @returns The tool call result with hashes and timing.
   * @throws {ToolNotFoundError} If the tool is not registered.
   * @throws {UnauthorizedError} If the policy denies the call.
   * @throws {ConfirmationRequiredError} If the policy requires confirmation.
   */
  async callTool(request: ToolCallRequest): Promise<ToolCallResult> {
    const { tool, input, consentToken } = request;

    // Ensure tool exists
    const handler = this.tools.get(tool);
    if (!handler) {
      throw new ToolNotFoundError(tool);
    }

    // Parse tool name into a proposed action
    const proposedAction = this.parseToolAction(tool, input);

    // Policy check
    const decision = this.policyEngine.evaluate(proposedAction, {
      consentToken: consentToken ?? '',
      tool,
      data_scope: request.data_scope,
      risk_level: request.risk_level ?? this.defaultRiskLevel,
    });

    if (decision.decision === 'deny') {
      throw new UnauthorizedError(tool, decision.reason ?? 'Policy denied');
    }

    if (decision.decision === 'needs_confirm') {
      throw new ConfirmationRequiredError(
        tool,
        decision.reason ?? 'User confirmation required'
      );
    }

    // Execute
    this.callCount++;
    const inputHash = computeHash(input);
    const start = performance.now();
    let output: unknown;
    let status: 'ok' | 'error' | 'timeout' = 'ok';

    // Auto-trace: record TOOL_CALL before execution
    if (this.trace) {
      this.trace.append('TOOL_CALL', {
        tool,
        input_hash: inputHash,
      });
    }

    try {
      output = await handler(input);
    } catch (err) {
      status = 'error';
      output = {
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const duration_ms = Math.round(performance.now() - start);
    const outputHash = computeHash(output);

    // Auto-trace: record TOOL_RESULT after execution
    if (this.trace) {
      this.trace.append('TOOL_RESULT', {
        tool,
        output_hash: outputHash,
        status,
        duration_ms,
      });
    }

    const entry: CallLogEntry = {
      tool,
      input_hash: inputHash,
      output_hash: outputHash,
      status,
      duration_ms,
      timestamp: new Date().toISOString(),
    };
    this.callLog.push(entry);

    return {
      output,
      status,
      duration_ms,
      input_hash: inputHash,
      output_hash: outputHash,
    };
  }

  /**
   * Return a copy of all call log entries.
   *
   * @returns Array of CallLogEntry objects.
   */
  getCallLog(): ReadonlyArray<CallLogEntry> {
    return [...this.callLog];
  }

  /**
   * Return the total number of successful + failed calls.
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Parse a tool name (e.g. "http.get") into a ProposedAction.
   *
   * @param tool - The dot-separated tool name.
   * @param input - The call input (used for resource extraction).
   * @returns A ProposedAction suitable for policy evaluation.
   */
  private parseToolAction(tool: string, input: unknown): GatewayProposedAction {
    const parts = tool.split('.');
    const type = parts[0] ?? tool;
    const resource = parts.slice(1).join('.') || '*';

    return {
      type,
      resource,
      parameters: typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : { value: input },
    };
  }
}

// ─── Built-in Tool Adapters ──────────────────────────────────────

/** Input shape for the built-in HTTP tool */
export interface HttpToolInput {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
}

/** Output shape from the built-in HTTP tool */
export interface HttpToolOutput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Built-in HTTP tool adapter.
 * Supports GET and POST via the global `fetch` API.
 */
export class HttpTool {
  /** Default timeout in milliseconds */
  static readonly DEFAULT_TIMEOUT_MS = 30_000;

  /**
   * Create a ToolHandler function for HTTP requests.
   *
   * @returns A ToolHandler that accepts HttpToolInput and returns HttpToolOutput.
   */
  static createHandler(): ToolHandler {
    return async (rawInput: unknown): Promise<HttpToolOutput> => {
      const input = rawInput as HttpToolInput;

      if (!input.url || typeof input.url !== 'string') {
        throw new Error('HttpTool: "url" is required and must be a string');
      }

      const method = input.method ?? 'GET';
      if (method !== 'GET' && method !== 'POST') {
        throw new Error(`HttpTool: unsupported method "${method}"`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        input.timeout_ms ?? HttpTool.DEFAULT_TIMEOUT_MS
      );

      try {
        const fetchOptions: RequestInit = {
          method,
          headers: input.headers,
          signal: controller.signal,
        };

        if (method === 'POST' && input.body !== undefined) {
          fetchOptions.body =
            typeof input.body === 'string'
              ? input.body
              : JSON.stringify(input.body);
          // Set content-type if not already provided
          if (!input.headers?.['content-type'] && !input.headers?.['Content-Type']) {
            fetchOptions.headers = {
              ...input.headers,
              'Content-Type': 'application/json',
            };
          }
        }

        const response = await fetch(input.url, fetchOptions);

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Try to parse body as JSON, fall back to text
        let body: unknown;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          body = await response.json();
        } else {
          body = await response.text();
        }

        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
        };
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new Error(`HttpTool: request timed out after ${input.timeout_ms ?? HttpTool.DEFAULT_TIMEOUT_MS}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    };
  }

  /**
   * Convenience: register the HTTP tool on a ToolGateway.
   *
   * @param gateway - The ToolGateway to register on.
   * @param name - Tool name (defaults to "http").
   */
  static register(gateway: ToolGateway, name: string = 'http'): void {
    gateway.registerTool(`${name}.get`, HttpTool.createHandler());
    gateway.registerTool(`${name}.post`, HttpTool.createHandler());
  }
}

// ─── Real HTTP Tool ──────────────────────────────────────────────

/** Response shape from RealHttpTool methods */
export interface RealHttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Real HTTP tool using Node.js global `fetch`.
 *
 * Provides simple GET/POST methods that can be registered
 * as built-in tools on a ToolGateway.
 */
export class RealHttpTool {
  /** Default timeout in milliseconds */
  static readonly DEFAULT_TIMEOUT_MS = 30_000;

  /**
   * Perform an HTTP GET request.
   *
   * @param url - The URL to fetch.
   * @param headers - Optional request headers.
   * @returns Response with status, parsed body, and headers.
   */
  static async get(
    url: string,
    headers?: Record<string, string>,
  ): Promise<RealHttpResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RealHttpTool.DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      return RealHttpTool.parseResponse(response);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`RealHttpTool: GET request timed out after ${RealHttpTool.DEFAULT_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Perform an HTTP POST request.
   *
   * @param url - The URL to post to.
   * @param body - The request body (will be JSON-serialized if not a string).
   * @param headers - Optional request headers.
   * @returns Response with status, parsed body, and headers.
   */
  static async post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<RealHttpResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RealHttpTool.DEFAULT_TIMEOUT_MS,
    );

    const requestHeaders: Record<string, string> = { ...headers };
    if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
      });

      return RealHttpTool.parseResponse(response);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`RealHttpTool: POST request timed out after ${RealHttpTool.DEFAULT_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Register RealHttpTool as built-in tools on a ToolGateway.
   *
   * Registers:
   * - "http.get" → wraps RealHttpTool.get
   * - "http.post" → wraps RealHttpTool.post
   *
   * @param gateway - The ToolGateway to register on.
   */
  static register(gateway: ToolGateway): void {
    gateway.registerTool('http.get', async (input: unknown) => {
      const req = input as { url: string; headers?: Record<string, string> };
      return RealHttpTool.get(req.url, req.headers);
    });

    gateway.registerTool('http.post', async (input: unknown) => {
      const req = input as { url: string; body?: unknown; headers?: Record<string, string> };
      return RealHttpTool.post(req.url, req.body, req.headers);
    });
  }

  /**
   * Parse a fetch Response into a RealHttpResponse.
   *
   * @param response - The fetch Response object.
   * @returns Parsed response.
   */
  private static async parseResponse(response: Response): Promise<RealHttpResponse> {
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let body: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return {
      status: response.status,
      body,
      headers: responseHeaders,
    };
  }
}

// ─── Internal Helpers ────────────────────────────────────────────

/**
 * Duck-type check to distinguish PolicyEngine from GatewayPolicyEngine.
 * PolicyEngine has `getToken`, `recordCall`, and `evaluate` that takes
 * a ProposedAction + RiskLevel, while GatewayPolicyEngine.evaluate takes
 * a GatewayProposedAction + context.
 */
function isPolicyEngine(obj: unknown): obj is PolicyEngine {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'getToken' in obj &&
    'recordCall' in obj &&
    'getRemainingCalls' in obj
  );
}
