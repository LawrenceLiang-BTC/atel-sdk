// ─── Audit Types ─────────────────────────────────────────────

export interface CoTReasoningChain {
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
  // llm_endpoint removed: always use local Ollama
  strategy?: 'rule' | 'llm' | 'hybrid';
  fallback?: 'rule' | 'reject';
  require_cot_reasoning_capability?: boolean;
}

export interface AgentModelInfo {
  name?: string;
  provider?: string;
  capabilities?: string[];
  hasCoTReasoning?: boolean;
}
