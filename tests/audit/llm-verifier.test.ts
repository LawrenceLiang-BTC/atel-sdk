import { describe, it, expect } from 'vitest';
import { LLMThinkingVerifier } from '../../src/audit/llm-verifier.js';

describe('LLMThinkingVerifier', () => {
  it('should verify simple calculation task', async () => {
    const verifier = new LLMThinkingVerifier();
    
    const task = {
      task_id: 'test-1',
      version: 'task.v0.1' as const,
      issuer: 'did:atel:test',
      intent: {
        type: 'calculate',
        goal: '计算 1+1 等于多少'
      },
      risk: {
        level: 'low' as const
      },
      nonce: 'test-nonce'
    };
    
    const thinking = {
      steps: ['这是一个数学问题', '涉及加法运算', '答案是 2'],
      reasoning: 'Step 1: 这是一个数学问题\nStep 2: 涉及加法运算\nStep 3: 答案是 2',
      conclusion: '2'
    };
    
    const result = await verifier.verify(task, thinking);
    
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
  }, 30000); // 30s timeout for LLM
});
