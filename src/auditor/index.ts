/**
 * ContentAuditor — Protocol-level security auditing for ATEL payloads
 * 
 * Detects common attack patterns that should be blocked at protocol level,
 * regardless of agent capabilities or business logic.
 */

export interface AuditResult {
  safe: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  pattern?: string;
}

export interface AuditConfig {
  enableInjectionCheck?: boolean;
  enablePathTraversalCheck?: boolean;
  enableCommandCheck?: boolean;
  enableCredentialCheck?: boolean;
  enableRecursionCheck?: boolean;
  maxDepth?: number;
  customPatterns?: Array<{ pattern: RegExp; reason: string; severity: AuditResult['severity'] }>;
}

const DEFAULT_CONFIG: Required<AuditConfig> = {
  enableInjectionCheck: true,
  enablePathTraversalCheck: true,
  enableCommandCheck: true,
  enableCredentialCheck: true,
  enableRecursionCheck: true,
  maxDepth: 10,
  customPatterns: [],
};

/**
 * Protocol-level attack patterns
 * These should be blocked regardless of agent capabilities
 */
const ATTACK_PATTERNS = {
  // SQL/NoSQL injection
  injection: [
    { pattern: /(\bOR\b|\bAND\b)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i, reason: 'SQL injection pattern', severity: 'critical' as const },
    { pattern: /UNION\s+SELECT/i, reason: 'SQL UNION injection', severity: 'critical' as const },
    { pattern: /;\s*DROP\s+TABLE/i, reason: 'SQL DROP command', severity: 'critical' as const },
    { pattern: /\$where\s*:/i, reason: 'MongoDB $where injection', severity: 'critical' as const },
    { pattern: /\{\s*\$ne\s*:\s*null\s*\}/i, reason: 'NoSQL injection pattern', severity: 'high' as const },
  ],

  // Path traversal
  pathTraversal: [
    { pattern: /\.\.[\/\\]/g, reason: 'Path traversal attempt', severity: 'high' as const },
    { pattern: /[\/\\]etc[\/\\]passwd/i, reason: 'System file access attempt', severity: 'critical' as const },
    { pattern: /[\/\\]\.ssh[\/\\]/i, reason: 'SSH directory access', severity: 'critical' as const },
    { pattern: /[\/\\]\.aws[\/\\]/i, reason: 'AWS credentials access', severity: 'critical' as const },
  ],

  // Command injection
  command: [
    { pattern: /\b(rm|del|rmdir)\s+-[rf]+/i, reason: 'Destructive file operation', severity: 'critical' as const },
    { pattern: /`[^`]*`/g, reason: 'Shell command backticks', severity: 'high' as const },
    { pattern: /\$\([^)]*\)/g, reason: 'Shell command substitution', severity: 'high' as const },
    { pattern: /&&|\|\|/g, reason: 'Shell command chaining', severity: 'medium' as const },
    { pattern: />\s*[\/\\]/g, reason: 'Shell output redirection', severity: 'medium' as const },
    { pattern: /\bsudo\b/i, reason: 'Privilege escalation attempt', severity: 'critical' as const },
    { pattern: /\bchmod\s+777/i, reason: 'Dangerous permission change', severity: 'high' as const },
  ],

  // Credential/secret access
  credential: [
    { pattern: /private[_-]?key/i, reason: 'Private key access', severity: 'critical' as const },
    { pattern: /secret[_-]?key/i, reason: 'Secret key access', severity: 'critical' as const },
    { pattern: /api[_-]?key/i, reason: 'API key access', severity: 'high' as const },
    { pattern: /password/i, reason: 'Password access', severity: 'high' as const },
    { pattern: /\.env/i, reason: 'Environment file access', severity: 'high' as const },
    { pattern: /\.pem\b/i, reason: 'Certificate file access', severity: 'high' as const },
  ],
};

export class ContentAuditor {
  private config: Required<AuditConfig>;

  constructor(config: AuditConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Audit a payload for protocol-level security issues
   */
  audit(payload: unknown, context?: { action?: string; from?: string }): AuditResult {
    // Convert payload to searchable string
    const payloadStr = JSON.stringify(payload);

    // Check recursion depth (nested objects can cause DoS)
    if (this.config.enableRecursionCheck) {
      const depth = this.getDepth(payload);
      if (depth > this.config.maxDepth) {
        return {
          safe: false,
          reason: `Payload depth (${depth}) exceeds limit (${this.config.maxDepth})`,
          severity: 'high',
        };
      }
    }

    // Check injection patterns
    if (this.config.enableInjectionCheck) {
      for (const { pattern, reason, severity } of ATTACK_PATTERNS.injection) {
        if (pattern.test(payloadStr)) {
          return { safe: false, reason, severity, pattern: pattern.source };
        }
      }
    }

    // Check path traversal
    if (this.config.enablePathTraversalCheck) {
      for (const { pattern, reason, severity } of ATTACK_PATTERNS.pathTraversal) {
        if (pattern.test(payloadStr)) {
          return { safe: false, reason, severity, pattern: pattern.source };
        }
      }
    }

    // Check command injection
    if (this.config.enableCommandCheck) {
      for (const { pattern, reason, severity } of ATTACK_PATTERNS.command) {
        if (pattern.test(payloadStr)) {
          return { safe: false, reason, severity, pattern: pattern.source };
        }
      }
    }

    // Check credential access
    if (this.config.enableCredentialCheck) {
      for (const { pattern, reason, severity } of ATTACK_PATTERNS.credential) {
        if (pattern.test(payloadStr)) {
          return { safe: false, reason, severity, pattern: pattern.source };
        }
      }
    }

    // Check custom patterns
    for (const { pattern, reason, severity } of this.config.customPatterns) {
      if (pattern.test(payloadStr)) {
        return { safe: false, reason, severity, pattern: pattern.source };
      }
    }

    return { safe: true };
  }

  /**
   * Calculate nesting depth of an object (DoS protection)
   */
  private getDepth(obj: unknown, currentDepth = 0): number {
    if (obj === null || typeof obj !== 'object') {
      return currentDepth;
    }

    if (Array.isArray(obj)) {
      return Math.max(currentDepth, ...obj.map(item => this.getDepth(item, currentDepth + 1)));
    }

    const depths = Object.values(obj).map(value => this.getDepth(value, currentDepth + 1));
    return depths.length > 0 ? Math.max(...depths) : currentDepth;
  }

  /**
   * Audit multiple payloads in batch
   */
  auditBatch(payloads: Array<{ payload: unknown; context?: { action?: string; from?: string } }>): AuditResult[] {
    return payloads.map(({ payload, context }) => this.audit(payload, context));
  }
}

/**
 * Default auditor instance with standard config
 */
export const defaultAuditor = new ContentAuditor();
