#!/usr/bin/env node

/**
 * Example: Using Tiered Audit Service
 * 
 * This example shows how to use the optional audit service
 * for background thinking chain verification.
 */

import { AuditService } from '../dist/audit/service.js';

// Example 1: Disabled by default (no impact on performance)
const disabledService = new AuditService({
  enabled: false,
});

console.log('Example 1: Disabled service');
console.log('Status:', disabledService.getStatus());
console.log('✓ No overhead when disabled\n');

// Example 2: Enabled with async queue
const auditService = new AuditService({
  enabled: true,
  llm_endpoint: 'http://localhost:11434',
  llm_model_path: 'qwen2.5:0.5b',
  strategy: 'hybrid', // rule-based for low risk, LLM for high risk
  maxQueueSize: 100,
  onAuditComplete: (taskId, result) => {
    console.log(`✓ Audit complete for ${taskId}:`, result.passed ? 'PASS' : 'FAIL');
    if (!result.passed) {
      console.log('  Violations:', result.violations);
    }
  },
  onAuditError: (taskId, error) => {
    console.error(`✗ Audit error for ${taskId}:`, error.message);
  },
  log: (obj) => {
    if (obj.event === 'audit_service_initialized') {
      console.log('Audit service initialized:', obj);
    }
  },
});

console.log('Example 2: Enabled service');
console.log('Status:', auditService.getStatus());

// Example task
const exampleTask = {
  task_id: 'task-123',
  version: 'task.v0.1',
  issuer: 'did:atel:test',
  intent: {
    type: 'calculation',
    goal: 'Calculate 25 × 4',
  },
  risk: {
    level: 'low',
  },
  nonce: Date.now().toString(),
};

const exampleThinking = {
  steps: [
    '1. Break down: 25 × 4 = 25 × (2 × 2)',
    '2. Calculate: 25 × 2 = 50',
    '3. Calculate: 50 × 2 = 100',
  ],
  reasoning: 'Using distributive property to simplify multiplication',
  conclusion: '25 × 4 = 100',
};

// Submit for async audit (non-blocking)
console.log('\nSubmitting task for async audit...');
await auditService.submitForAudit(exampleTask, exampleThinking);
console.log('✓ Task submitted (non-blocking)');
console.log('Status:', auditService.getStatus());

// Wait for audit to complete
await new Promise(resolve => setTimeout(resolve, 2000));

console.log('\nFinal status:', auditService.getStatus());

// Example 3: Synchronous audit (blocking)
console.log('\n\nExample 3: Synchronous audit (blocking)');
const syncResult = await auditService.auditSync(exampleTask, exampleThinking);
console.log('Sync audit result:', syncResult);

console.log('\n✓ All examples completed');
