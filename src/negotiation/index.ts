/**
 * Module: Capability Negotiation
 *
 * Automated negotiation between a requestor and executor agent.
 * After discovery, the requestor queries the executor's capabilities
 * and negotiates execution terms before delegating a task.
 */

import type { AgentIdentity } from '../identity/index.js';
import {
  createMessage,
  type ATELMessage,
} from '../envelope/index.js';
import type { RiskLevel } from '../schema/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** What the requestor needs */
export interface NegotiationRequest {
  /** Task type (e.g. "flight_search") */
  taskType: string;
  /** Required risk level */
  riskLevel: RiskLevel;
  /** Additional constraints */
  constraints?: Record<string, unknown>;
  /** Maximum acceptable cost */
  maxCost?: number;
  /** Required deadline (ISO 8601) */
  deadline?: string;
}

/** What the executor offers */
export interface NegotiationResponse {
  /** Whether the executor can handle this task */
  canHandle: boolean;
  /** Reason if cannot handle */
  reason?: string;
  /** Proposed execution terms */
  terms?: ExecutionTerms;
}

/** Execution terms proposed by the executor */
export interface ExecutionTerms {
  /** Estimated cost */
  estimatedCost?: number;
  /** Currency */
  currency?: string;
  /** Estimated duration in milliseconds */
  estimatedDurationMs?: number;
  /** Maximum risk level the executor accepts */
  maxRiskLevel: RiskLevel;
  /** Required scopes the executor needs */
  requiredScopes: string[];
  /** Consent token TTL the executor requests (seconds) */
  requestedTtlSec: number;
  /** Maximum tool calls the executor expects to make */
  expectedMaxCalls: number;
  /** Additional terms */
  additionalTerms?: Record<string, unknown>;
}

/** Result of a negotiation */
export interface NegotiationResult {
  /** Whether negotiation succeeded */
  success: boolean;
  /** The agreed terms (if successful) */
  agreedTerms?: ExecutionTerms;
  /** Reason for failure */
  reason?: string;
  /** The executor's DID */
  executorDid: string;
}

// ─── Negotiation Handler (Executor Side) ─────────────────────────

/** Configuration for how an executor handles negotiation requests */
export interface NegotiationPolicy {
  /** Capability types this executor supports */
  supportedTypes: string[];
  /** Maximum risk level this executor accepts */
  maxRiskLevel: RiskLevel;
  /** Default scopes the executor requires */
  defaultScopes: string[];
  /** Default TTL request (seconds) */
  defaultTtlSec: number;
  /** Default max calls */
  defaultMaxCalls: number;
  /** Cost estimator function (optional) */
  estimateCost?: (request: NegotiationRequest) => { cost: number; currency: string } | null;
  /** Duration estimator function (optional) */
  estimateDuration?: (request: NegotiationRequest) => number | null;
  /** Custom validator (optional) */
  customValidator?: (request: NegotiationRequest) => { valid: boolean; reason?: string };
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Handles negotiation requests on the executor side.
 *
 * Evaluates incoming requests against the executor's policy
 * and returns proposed terms or rejection.
 */
export class NegotiationHandler {
  private readonly policy: NegotiationPolicy;

  constructor(policy: NegotiationPolicy) {
    this.policy = policy;
  }

  /**
   * Evaluate a negotiation request.
   *
   * @param request - The requestor's negotiation request.
   * @returns The negotiation response.
   */
  evaluate(request: NegotiationRequest): NegotiationResponse {
    // Check if we support this task type
    if (!this.policy.supportedTypes.includes(request.taskType)) {
      return {
        canHandle: false,
        reason: `Unsupported task type: ${request.taskType}`,
      };
    }

    // Check risk level
    if (RISK_ORDER[request.riskLevel] > RISK_ORDER[this.policy.maxRiskLevel]) {
      return {
        canHandle: false,
        reason: `Risk level ${request.riskLevel} exceeds maximum ${this.policy.maxRiskLevel}`,
      };
    }

    // Custom validation
    if (this.policy.customValidator) {
      const validation = this.policy.customValidator(request);
      if (!validation.valid) {
        return { canHandle: false, reason: validation.reason };
      }
    }

    // Build terms
    const terms: ExecutionTerms = {
      maxRiskLevel: this.policy.maxRiskLevel,
      requiredScopes: this.policy.defaultScopes,
      requestedTtlSec: this.policy.defaultTtlSec,
      expectedMaxCalls: this.policy.defaultMaxCalls,
    };

    // Estimate cost
    if (this.policy.estimateCost) {
      const costEstimate = this.policy.estimateCost(request);
      if (costEstimate) {
        terms.estimatedCost = costEstimate.cost;
        terms.currency = costEstimate.currency;

        // Check if within requestor's budget
        if (request.maxCost !== undefined && costEstimate.cost > request.maxCost) {
          return {
            canHandle: false,
            reason: `Estimated cost ${costEstimate.cost} exceeds budget ${request.maxCost}`,
          };
        }
      }
    }

    // Estimate duration
    if (this.policy.estimateDuration) {
      terms.estimatedDurationMs = this.policy.estimateDuration(request) ?? undefined;
    }

    return { canHandle: true, terms };
  }
}

// ─── Negotiation Client (Requestor Side) ─────────────────────────

/**
 * Client for negotiating with remote agents.
 */
export class NegotiationClient {
  private readonly identity: AgentIdentity;
  private readonly timeoutMs: number;

  constructor(identity: AgentIdentity, options?: { timeoutMs?: number }) {
    this.identity = identity;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  /**
   * Negotiate with a remote agent.
   *
   * @param remoteEndpoint - The remote agent's endpoint URL.
   * @param remoteDid - The remote agent's DID.
   * @param request - The negotiation request.
   * @returns The negotiation result.
   */
  async negotiate(
    remoteEndpoint: string,
    remoteDid: string,
    request: NegotiationRequest,
  ): Promise<NegotiationResult> {
    const message = createMessage({
      type: 'capability_query',
      from: this.identity.did,
      to: remoteDid,
      payload: request,
      secretKey: this.identity.secretKey,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${remoteEndpoint}/atel/v1/capability/negotiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          success: false,
          reason: `Negotiation request failed: ${response.status}`,
          executorDid: remoteDid,
        };
      }

      const result = await response.json() as NegotiationResponse;

      return {
        success: result.canHandle,
        agreedTerms: result.terms,
        reason: result.reason,
        executorDid: remoteDid,
      };
    } catch (err) {
      return {
        success: false,
        reason: err instanceof Error ? err.message : String(err),
        executorDid: remoteDid,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Negotiate with multiple agents and pick the best one.
   *
   * @param candidates - Array of {endpoint, did} pairs.
   * @param request - The negotiation request.
   * @returns The best negotiation result, or null if all failed.
   */
  async negotiateBest(
    candidates: Array<{ endpoint: string; did: string }>,
    request: NegotiationRequest,
  ): Promise<NegotiationResult | null> {
    const results = await Promise.all(
      candidates.map((c) => this.negotiate(c.endpoint, c.did, request)),
    );

    const successful = results.filter((r) => r.success);
    if (successful.length === 0) return null;

    // Pick the one with lowest estimated cost, or first if no cost info
    successful.sort((a, b) => {
      const costA = a.agreedTerms?.estimatedCost ?? Infinity;
      const costB = b.agreedTerms?.estimatedCost ?? Infinity;
      return costA - costB;
    });

    return successful[0];
  }
}
