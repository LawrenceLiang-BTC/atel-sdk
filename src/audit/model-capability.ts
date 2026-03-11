// ─── Model Capability Detection ─────────────────────────────

/**
 * Known models with thinking capability
 */
export const THINKING_CAPABLE_MODELS = [
  // Anthropic Claude
  'claude-3-opus',
  'claude-3.5-sonnet',
  'claude-3-sonnet',
  'claude-sonnet-4',
  
  // OpenAI
  'gpt-4',
  'gpt-4-turbo',
  'o1-preview',
  'o1-mini',
  
  // DeepSeek
  'deepseek-r1',
  'deepseek-reasoner',
  
  // Qwen
  'qwen-plus',
  'qwen-max',
  
  // Local models (if configured for thinking)
  'qwen2.5:0.5b',
  'qwen2.5:1.5b',
  'qwen2.5:7b'
];

/**
 * Model capability metadata
 */
export interface ModelCapability {
  name: string;
  hasThinking: boolean;
  hasToolCalling?: boolean;
  hasVision?: boolean;
  provider?: string;
}

/**
 * Check if a model supports thinking capability
 */
export function hasThinkingCapability(modelName: string): boolean {
  if (!modelName) return false;
  
  const normalized = modelName.toLowerCase().trim();
  
  // Check exact match
  if (THINKING_CAPABLE_MODELS.some(m => normalized.includes(m.toLowerCase()))) {
    return true;
  }
  
  // Check by provider patterns
  if (normalized.includes('claude') && !normalized.includes('instant')) {
    return true;
  }
  
  if (normalized.includes('gpt-4') || normalized.includes('o1')) {
    return true;
  }
  
  if (normalized.includes('deepseek') && normalized.includes('r1')) {
    return true;
  }
  
  return false;
}

/**
 * Extract model name from various formats
 */
export function extractModelName(input: string): string {
  if (!input) return '';
  
  // Handle common formats:
  // - "claude-3.5-sonnet"
  // - "anthropic/claude-3.5-sonnet"
  // - "openai:gpt-4"
  // - "ollama:qwen2.5:0.5b"
  
  const parts = input.split(/[/:]/);
  return parts[parts.length - 1] || input;
}
