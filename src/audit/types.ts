// ─── Audit Types ─────────────────────────────────────────────

export interface ThinkingChain {
  steps: string[];
  reasoning: string;
  conclusion: string;
}

export interface VerificationResult {
  passed: boolean;
  violations: string[];
  confidence?: number;
  llm_response?: any;
  skipped?: boolean;
  skip_reason?: string;
}

export interface LLMAuditConfig {
  llm_model_path?: string;
  llm_endpoint?: string;
  strategy?: 'rule' | 'llm' | 'hybrid';
  fallback?: 'rule' | 'reject';
  require_thinking_capability?: boolean;
}

export interface AgentModelInfo {
  name?: string;
  provider?: string;
  capabilities?: string[];
  hasThinking?: boolean;
}
