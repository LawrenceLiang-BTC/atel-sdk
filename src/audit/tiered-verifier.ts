import type { Task } from '../schema/index.js';
import type { ThinkingChain, VerificationResult, AgentModelInfo } from './types.js';
import { LLMThinkingVerifier } from './llm-verifier.js';
import { hasThinkingCapability, extractModelName } from './model-capability.js';

// ─── Tiered Audit Strategy ─────────────────────────────────

// Constants
const MIN_REASONING_LENGTH = 10;
const MIN_STEPS = 2;
const MIN_KEYWORD_MATCH_RATIO = 0.3;
const STOPWORDS = ['the', 'is', 'a', 'an', 'and', 'or', 'but', '的', '是', '了', '在', '有', '个', '这', '那'];

/**
 * Simple rule-based verifier for low-risk tasks
 */
class RuleBasedVerifier {
  verify(task: Task, thinking: ThinkingChain): VerificationResult {
    const violations: string[] = [];

    // Check 1: Thinking chain must exist
    if (!thinking.reasoning || thinking.reasoning.length < MIN_REASONING_LENGTH) {
      violations.push('Thinking chain too short');
    }

    // Check 2: Must have at least 2 steps
    if (!thinking.steps || thinking.steps.length < MIN_STEPS) {
      violations.push('Insufficient reasoning steps');
    }

    // Check 3: Conclusion must exist
    if (!thinking.conclusion || thinking.conclusion.length < 1) {
      violations.push('Missing conclusion');
    }

    // Check 4: Basic keyword matching
    const taskGoal = task.intent.goal.toLowerCase();
    const thinkingText = thinking.reasoning.toLowerCase();
    
    // Extract keywords from task (simple approach)
    const keywords = taskGoal
      .split(/\s+/)
      .filter(w => w.length > 2)
      .filter(w => !STOPWORDS.includes(w));
    
    let matchedKeywords = 0;
    for (const keyword of keywords) {
      if (thinkingText.includes(keyword)) {
        matchedKeywords++;
      }
    }

    const matchRatio = keywords.length > 0 ? matchedKeywords / keywords.length : 0;
    if (matchRatio < MIN_KEYWORD_MATCH_RATIO) {
      violations.push(`Only ${Math.round(matchRatio * 100)}% keywords matched`);
    }

    return {
      passed: violations.length === 0,
      violations,
      confidence: violations.length === 0 ? 0.7 : 0.3
    };
  }
}

/**
 * Tiered audit verifier that chooses strategy based on risk level
 */
export class TieredAuditVerifier {
  private ruleVerifier: RuleBasedVerifier;
  private llmVerifier: LLMThinkingVerifier;
  private requireThinkingCapability: boolean;

  constructor(
    llmVerifier: LLMThinkingVerifier,
    config: { requireThinkingCapability?: boolean } = {}
  ) {
    this.ruleVerifier = new RuleBasedVerifier();
    this.llmVerifier = llmVerifier;
    this.requireThinkingCapability = config.requireThinkingCapability ?? true;
  }

  async verify(
    task: Task,
    thinking: ThinkingChain,
    modelInfo?: AgentModelInfo
  ): Promise<VerificationResult> {
    // Check if model has thinking capability (REQUIRED)
    if (this.requireThinkingCapability && modelInfo) {
      const modelName = extractModelName(modelInfo.name || '');
      const hasThinking = modelInfo.hasThinking ?? hasThinkingCapability(modelName);
      
      if (!hasThinking) {
        // REJECT: Model does not support thinking
        return {
          passed: false,
          violations: [`Model ${modelName} does not support thinking capability - connection rejected`],
          confidence: 0,
          skipped: false,
          skip_reason: 'Model lacks required thinking capability'
        };
      }
    }

    const riskLevel = task.risk.level;

    // Low risk: use fast rule-based verification
    if (riskLevel === 'low') {
      return this.ruleVerifier.verify(task, thinking);
    }

    // Medium risk: rule-based first, then LLM if failed
    if (riskLevel === 'medium') {
      const ruleResult = this.ruleVerifier.verify(task, thinking);
      
      if (ruleResult.passed) {
        return ruleResult;
      }
      
      // Rule-based failed, use LLM for deeper verification
      return await this.llmVerifier.verify(task, thinking);
    }

    // High/Critical risk: always use LLM
    return await this.llmVerifier.verify(task, thinking);
  }

  /**
   * Get estimated verification time based on risk level
   */
  estimateTime(riskLevel: string): number {
    switch (riskLevel) {
      case 'low':
        return 10; // 10ms
      case 'medium':
        return 3000; // 3s (might use LLM)
      case 'high':
      case 'critical':
        return 6000; // 6s (always LLM)
      default:
        return 6000;
    }
  }
}
