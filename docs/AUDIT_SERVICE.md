# Tiered Audit Service - Usage Guide

## Overview

The Tiered Audit Service provides optional, non-blocking quality verification for thinking chains in ATEL task results.

**Key Features**:
- **Non-blocking**: Uses async queue, doesn't block task completion
- **Optional**: Disabled by default, controlled by config
- **Tiered strategy**: Rule-based (fast) → LLM (deep) based on risk level
- **Standalone**: Can be used in Platform or SDK independently

## Architecture

```
Task Completed → Extract Thinking Chain → [Optional] Submit to Audit Service
                                                ↓
                                          Async Queue
                                                ↓
                                    Tiered Verifier (Rule/LLM/Hybrid)
                                                ↓
                                    Callback (DB/Log/Metrics)
```

## Usage

### 1. SDK Integration (Executor)

```typescript
import { AuditService } from './audit/service.js';

// Initialize service (disabled by default)
const auditService = new AuditService({
  enabled: process.env.ENABLE_AUDIT === 'true',
  llm_endpoint: 'http://localhost:11434',
  llm_model_path: 'qwen2.5:0.5b',
  strategy: 'hybrid',
  maxQueueSize: 1000,
  onAuditComplete: async (taskId, result) => {
    console.log(`Audit ${taskId}: ${result.passed ? 'PASS' : 'FAIL'}`);
    // Save to DB, update metrics, etc.
  },
  onAuditError: async (taskId, error) => {
    console.error(`Audit ${taskId} failed:`, error.message);
  },
  log: (obj) => console.log('[Audit]', obj),
});

// After task completion, submit for audit (non-blocking)
if (thinkingChain) {
  await auditService.submitForAudit(task, thinkingChain, modelInfo);
}
```

### 2. Platform Integration (Go)

Platform can call SDK's audit endpoint or implement its own audit service.

**Option A: Call SDK audit endpoint**
```go
// After receiving task result
if result.Thinking != nil {
    go func() {
        // Async audit call to SDK
        resp, _ := http.Post(
            agentEndpoint + "/audit",
            "application/json",
            bytes.NewBuffer(auditPayload),
        )
        // Handle audit result
    }()
}
```

**Option B: Implement in Platform**
Port the TypeScript audit logic to Go, or use a sidecar service.

### 3. Configuration

**Environment Variables**:
```bash
# Enable audit service
ENABLE_AUDIT=true

# Ollama endpoint for LLM verification
OLLAMA_ENDPOINT=http://localhost:11434

# Model for LLM verification
OLLAMA_MODEL=qwen2.5:0.5b

# Strategy: rule | llm | hybrid
AUDIT_STRATEGY=hybrid

# Require thinking capability from agent model
REQUIRE_THINKING_CAPABILITY=true
```

**Config File** (`.atel/audit-config.json`):
```json
{
  "enabled": true,
  "llm_endpoint": "http://localhost:11434",
  "llm_model_path": "qwen2.5:0.5b",
  "strategy": "hybrid",
  "require_thinking_capability": true,
  "maxQueueSize": 1000,
  "maxRetries": 3,
  "retryDelay": 5000
}
```

## Tiered Strategy

### Low Risk Tasks
- **Verifier**: Rule-based (fast, ~10ms)
- **Checks**: 
  - Thinking chain length >= 10 chars
  - Steps count >= 2
  - Conclusion exists
  - Keyword matching >= 30%

### Medium Risk Tasks
- **Verifier**: Rule-based first, LLM fallback
- **Flow**: Try rules → If fail, use LLM

### High/Critical Risk Tasks
- **Verifier**: Always LLM (~3-6s)
- **Checks**: Deep semantic analysis via Ollama

## API

### AuditService

```typescript
class AuditService {
  constructor(config: AuditServiceConfig)
  
  // Submit for async audit (non-blocking)
  submitForAudit(task: Task, thinking: ThinkingChain, modelInfo?: AgentModelInfo): Promise<void>
  
  // Synchronous audit (blocks until complete)
  auditSync(task: Task, thinking: ThinkingChain, modelInfo?: AgentModelInfo): Promise<VerificationResult>
  
  // Get queue status
  getStatus(): { enabled: boolean; queueSize: number; processing: boolean }
  
  // Enable/disable at runtime
  setEnabled(enabled: boolean): void
}
```

### VerificationResult

```typescript
interface VerificationResult {
  passed: boolean;
  violations: string[];
  confidence?: number;
  llm_response?: any;
  skipped?: boolean;
  skip_reason?: string;
}
```

## Testing

### Unit Test
```bash
cd ~/repos/atel-sdk
npm test -- src/audit/service.test.ts
```

### Integration Test
```bash
# Start Ollama
ollama serve

# Pull model
ollama pull qwen2.5:0.5b

# Run audit test
node scripts/thinking-test.mjs
```

### Manual Test
```typescript
import { AuditService } from './audit/service.js';

const service = new AuditService({
  enabled: true,
  llm_endpoint: 'http://localhost:11434',
  llm_model_path: 'qwen2.5:0.5b',
  log: console.log,
});

const task = {
  task_id: 'test-1',
  version: 'task.v0.1',
  issuer: 'did:test:123',
  intent: { type: 'math', goal: 'Calculate 5 + 3' },
  risk: { level: 'low' },
  nonce: '123',
};

const thinking = {
  steps: ['Step 1: Add 5 and 3', 'Step 2: Result is 8'],
  reasoning: 'Simple addition: 5 + 3 = 8',
  conclusion: '8',
};

const result = await service.auditSync(task, thinking);
console.log('Audit result:', result);
```

## Performance

| Risk Level | Verifier | Avg Time | Throughput |
|------------|----------|----------|------------|
| Low        | Rule     | ~10ms    | 100 tasks/s |
| Medium     | Hybrid   | ~1.5s    | 20 tasks/s |
| High       | LLM      | ~6s      | 5 tasks/s |

**Queue capacity**: 1000 tasks (configurable)

## Deployment

### Development
```bash
# Disabled by default
npm run dev
```

### Production
```bash
# Enable audit service
export ENABLE_AUDIT=true
export OLLAMA_ENDPOINT=http://ollama-service:11434
npm start
```

### Docker
```yaml
services:
  atel-sdk:
    environment:
      - ENABLE_AUDIT=true
      - OLLAMA_ENDPOINT=http://ollama:11434
  
  ollama:
    image: ollama/ollama
    ports:
      - "11434:11434"
```

## Monitoring

### Metrics
- `audit_enqueued`: Task submitted to queue
- `audit_complete`: Audit finished (passed/failed)
- `audit_error`: Audit failed after retries
- `audit_enqueue_failed`: Queue full

### Health Check
```typescript
const status = auditService.getStatus();
console.log(status);
// { enabled: true, queueSize: 5, processing: true }
```

## Troubleshooting

### Audit service not starting
- Check `ENABLE_AUDIT=true`
- Verify Ollama is running: `curl http://localhost:11434/api/tags`

### Queue full errors
- Increase `maxQueueSize` in config
- Check if Ollama is responding slowly
- Monitor queue status: `auditService.getStatus()`

### LLM verification slow
- Use smaller model: `qwen2.5:0.5b` instead of `qwen2.5:7b`
- Switch to `strategy: 'rule'` for low-risk tasks
- Increase `maxRetries` and `retryDelay`

## Migration

### From old audit code
1. Remove inline audit logic from executor
2. Initialize `AuditService` with config
3. Call `submitForAudit()` after task completion
4. Handle results in callbacks

### Rollback
Set `ENABLE_AUDIT=false` or remove config. Service is fully optional.
