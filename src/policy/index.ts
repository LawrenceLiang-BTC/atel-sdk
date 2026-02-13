import { v4 as uuidv4 } from 'uuid';
import { sign, verify, serializePayload } from '../identity/index.js';
import type { RiskLevel } from '../schema/index.js';

// ─── Custom Errors ───────────────────────────────────────────────

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

// ─── Types ───────────────────────────────────────────────────────

export interface ConsentConstraints {
  max_calls: number;
  ttl_sec: number;
}

export interface ConsentToken {
  iss: string;
  sub: string;
  scopes: string[];
  constraints: ConsentConstraints;
  risk_ceiling: RiskLevel;
  nonce: string;
  iat: number;
  exp: number;
  sig: string;
}

export interface ProposedAction {
  tool: string;
  method: string;
  dataScope: string;
}

export type PolicyDecision = 'allow' | 'deny' | 'needs_confirm';

// ─── Scope Matching ──────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Check if a granted scope covers a requested scope.
 * Uses colon-delimited hierarchical matching:
 * "tool:http" matches "tool:http:get" and "tool:http:post".
 * @param granted - The scope string from the consent token.
 * @param requested - The scope string being requested.
 * @returns True if the granted scope covers the requested scope.
 */
export function scopeMatches(granted: string, requested: string): boolean {
  if (granted === requested) return true;
  // Hierarchical: granted is a prefix followed by ':'
  return requested.startsWith(granted + ':');
}

/**
 * Build the scope strings for a proposed action.
 * Returns two scopes: one for the tool/method, one for the data access.
 * @param action - The proposed action.
 * @returns Array of scope strings to check.
 */
function actionToScopes(action: ProposedAction): string[] {
  return [
    `tool:${action.tool}:${action.method}`,
    `data:${action.dataScope}`,
  ];
}

// ─── Consent Token Functions ─────────────────────────────────────

/**
 * Create the signable body of a consent token (everything except `sig`).
 */
function consentBody(token: Omit<ConsentToken, 'sig'>): string {
  return serializePayload({
    iss: token.iss,
    sub: token.sub,
    scopes: token.scopes,
    constraints: token.constraints,
    risk_ceiling: token.risk_ceiling,
    nonce: token.nonce,
    iat: token.iat,
    exp: token.exp,
  });
}

/**
 * Mint (create and sign) a ConsentToken.
 * The issuer grants the executor permission to act within defined scopes.
 *
 * Supports two signing modes:
 * - Pass `issuerSecretKey` (Uint8Array) for direct signing (convenience).
 * - Pass a `signer` function for delegated signing (e.g., HSM, remote signer).
 *
 * @param issuer - DID of the issuing agent.
 * @param executor - DID of the executing agent.
 * @param scopes - Array of scope strings (e.g. "tool:http:get", "data:public_web:read").
 * @param constraints - Call limits and TTL.
 * @param riskCeiling - Maximum risk level allowed.
 * @param issuerSecretKeyOrSigner - The issuer's 64-byte Ed25519 secret key, or a signer function.
 * @returns A signed ConsentToken.
 */
export function mintConsentToken(
  issuer: string,
  executor: string,
  scopes: string[],
  constraints: ConsentConstraints,
  riskCeiling: RiskLevel,
  issuerSecretKeyOrSigner: Uint8Array | ((payload: Uint8Array) => Uint8Array),
): ConsentToken {
  if (scopes.length === 0) {
    throw new ConsentError('At least one scope is required');
  }
  if (constraints.max_calls < 1) {
    throw new ConsentError('max_calls must be at least 1');
  }
  if (constraints.ttl_sec < 1) {
    throw new ConsentError('ttl_sec must be at least 1');
  }

  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: issuer,
    sub: executor,
    scopes,
    constraints,
    risk_ceiling: riskCeiling,
    nonce: uuidv4(),
    iat: now,
    exp: now + constraints.ttl_sec,
  };

  let sig: string;
  if (typeof issuerSecretKeyOrSigner === 'function') {
    // Signer function mode: caller provides a signing function
    const bodyStr = consentBody(body);
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const sigBytes = issuerSecretKeyOrSigner(bodyBytes);
    sig = Buffer.from(sigBytes).toString('base64');
  } else {
    // Direct secret key mode (convenience)
    sig = sign(consentBody(body), issuerSecretKeyOrSigner);
  }

  return { ...body, sig };
}

/**
 * Verify a ConsentToken's signature and check that it has not expired.
 * @param token - The consent token to verify.
 * @param issuerPublicKey - The issuer's 32-byte Ed25519 public key.
 * @returns True if the token is valid (signature OK and not expired).
 * @throws ConsentError if the token is invalid.
 */
export function verifyConsentToken(token: ConsentToken, issuerPublicKey: Uint8Array): boolean {
  const { sig, ...body } = token;
  const bodyStr = consentBody(body);

  if (!verify(bodyStr, sig, issuerPublicKey)) {
    throw new ConsentError('Invalid consent token signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (now >= token.exp) {
    throw new ConsentError('Consent token has expired');
  }
  if (now < token.iat) {
    throw new ConsentError('Consent token issued in the future');
  }

  return true;
}

// ─── PolicyEngine ────────────────────────────────────────────────

/**
 * Evaluates proposed actions against a ConsentToken.
 * Tracks call count and enforces scope, risk, and expiry constraints.
 */
export class PolicyEngine {
  private readonly token: ConsentToken;
  private callCount: number = 0;

  /**
   * @param consentToken - The consent token governing this engine.
   */
  constructor(consentToken: ConsentToken) {
    this.token = consentToken;
  }

  /**
   * Evaluate whether a proposed action is allowed under the current consent.
   * @param action - The action to evaluate.
   * @param actionRisk - The risk level of the proposed action (defaults to "low").
   * @returns 'allow', 'deny', or 'needs_confirm'.
   */
  evaluate(action: ProposedAction, actionRisk: RiskLevel = 'low'): PolicyDecision {
    // Check expiry
    if (this.isExpired()) return 'deny';

    // Check call limit
    if (this.callCount >= this.token.constraints.max_calls) return 'deny';

    // Check risk ceiling
    const actionRiskLevel = RISK_ORDER[actionRisk];
    const ceilingLevel = RISK_ORDER[this.token.risk_ceiling];
    if (actionRiskLevel > ceilingLevel) {
      // If it's one level above, request confirmation; otherwise deny
      return actionRiskLevel === ceilingLevel + 1 ? 'needs_confirm' : 'deny';
    }

    // Check scopes
    const requiredScopes = actionToScopes(action);
    for (const required of requiredScopes) {
      const covered = this.token.scopes.some((granted) => scopeMatches(granted, required));
      if (!covered) return 'deny';
    }

    return 'allow';
  }

  /**
   * Record a successful call against the consent token's call limit.
   * @throws PolicyError if the call limit has been reached.
   */
  recordCall(): void {
    if (this.callCount >= this.token.constraints.max_calls) {
      throw new PolicyError('Call limit exceeded');
    }
    this.callCount++;
  }

  /**
   * Check if the consent token has expired.
   * @returns True if the current time is past the token's expiry.
   */
  isExpired(): boolean {
    return Math.floor(Date.now() / 1000) >= this.token.exp;
  }

  /**
   * Get the number of remaining calls allowed.
   * @returns Number of remaining calls (minimum 0).
   */
  getRemainingCalls(): number {
    return Math.max(0, this.token.constraints.max_calls - this.callCount);
  }

  /**
   * Get the underlying consent token.
   */
  getToken(): ConsentToken {
    return { ...this.token };
  }
}
