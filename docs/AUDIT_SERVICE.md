# Tiered Audit Service - Usage Guide

## Overview

The Tiered Audit Service provides optional, non-blocking quality verification for CoT (Chain-of-Thought) reasoning chains in ATEL task results.

**Key Features**:
- **Zero-config**: No external dependencies (no Ollama installation required)
- **Auto-download**: Automatically downloads audit model on first run (~400MB)
- **Non-blocking**: Uses async queue, doesn't block task completion
- **Optional**: Disabled by default, controlled by config
- **Tiered strategy**: Rule-based (fast) → LLM (deep) based on risk level
- **Pure Node.js**: Uses node-llama-cpp for local inference

## Architecture

```
Task Completed → Extract CoT Chain → [Optional] Submit to Audit Service
                                            ↓
                                      Async Queue
                                            ↓
                                Tiered Verifier (Rule/LLM/Hybrid)
                                            ↓
                                Callback (DB/Log/Metrics)
```

## Zero-Config Deployment

### First Run (Auto-Download Model)
```bash
npm start
# 📦 Downloading model (first time only, ~400MB)...
#    Progress: 100% (408.9/408.9 MB)
# ✅ Model ready
# 🚀 Agent started
```

### Subsequent Runs
```bash
npm start
# 🔄 Loading model...
# ✅ Model ready
# 🚀 Agent started
```

**No Ollama installation required!** The audit system uses node-llama-cpp for local inference.

## Usage

### 1. SDK Integration (Executor)

```typescript
import { AuditService } from './audit/service.js';

// Initialize service (auto-downloads model if needed)
const auditService = new AuditService({
  enabled: process.env.ENABLE_AUDIT === 'true',
  strategy: 'hybrid',
  require_cot_reasoning_capability: true,
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
if (cotChain) {
  await auditService.submitForAudit(task, cotChain, modelInfo);
}
```

### 2. Platform Integration (Go)

Platform can call SDK's audit endpoint or implement its own audit service.

**Option A: Call SDK audit endpoint**
```go
// After receiving task result
if result.CoTReasoning != nil {
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

# Strategy: rule | llm | hybrid
AUDIT_STRATEGY=hybrid

# Require CoT reasoning capability from agent model
REQUIRE_COT_REASONING_CAPABILITY=true
```

**Config File** (`.atel/audit-config.json`):
```json
{
  "enabled": true,
  "strategy": "hybrid",
  "require_cot_reasoning_capability": true,
  "maxQueueSize": 1000,
  "maxRetries": 3,
  "retryDelay": 5000
}
```

**Note**: No need to configure LLM endpoint or model path. The audit system automatically manages the model using node-llama-cpp.

## Tiered Strategy

### Low Risk Tasks
- **Verifier**: Rule-based (fast, ~10ms)
- **Checks**: 
  - CoT chain length >= 10 chars
  - Steps count >= 2
  - Conclusion exists
  - Keyword matching >= 30%

### Medium Risk Tasks
- **Verifier**: Rule-based first, LLM fallback
- **Flow**: Try rules → If fail, use LLM

### High/Critical Risk Tasks
- **Verifier**: Always LLM (~25s)
- **Checks**: Deep semantic analysis via node-llama-cpp

## CoT Reasoning Requirement

The audit system requires agents to provide CoT (Chain-of-Thought) reasoning in their responses.

### Handshake Notification

When an agent connects, it receives a notification about the CoT requirement:

```json
{
  "...": "...",
  "requirements": {
    "cot_reasoning": {
      "required": true,
      "reason": "This agent uses CoT reasoning audit for task verification"
    }
  }
}
```

### Rejection Message

If an agent doesn't support CoT reasoning, it receives a clear error message:

```json
{
  "passed": false,
  "violations": [
    "Model xxx does not support CoT reasoning - connection rejected",
    "This agent requires CoT reasoning for task verification.",
    "Please ensure your agent includes CoT reasoning capability.",
    "Hint: Add { \"type\": \"cot_reasoning\", ... } to capabilities."
  ]
}
```

## API

### AuditService

```typescript
class AuditService {
  constructor(config: AuditServiceConfig)
  
  // Submit for async audit (non-blocking)
  submitForAudit(task: Task, cotChain: CoTReasoningChain, modelInfo?: AgentModelInfo): Promise<void>
  
  // Synchronous audit (blocks until complete)
  auditSync(task: Task, cotChain: CoTReasoningChain, modelInfo?: AgentModelInfo): Promise<VerificationResult>
  
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
# No setup needed! Model downloads automatically
node scripts/cot-test.mjs
```

### Manual Test
```typescript
import { AuditService } from './audit/service.js';

const service = new AuditService({
  enabled: true,
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

const cotChain = {
  steps: ['Step 1: Add 5 and 3', 'Step 2: Result is 8'],
  reasoning: 'Simple addition: 5 + 3 = 8',
  conclusion: '8',
};

const result = await service.auditSync(task, cotChain);
console.log('Audit result:', result);
```

## Performance

| Risk Level | Verifier | Avg Time | Throughput |
|------------|----------|----------|------------|
| Low        | Rule     | ~10ms    | 100 tasks/s |
| Medium     | Hybrid   | ~15s     | 4 tasks/s |
| High       | LLM      | ~25s     | 2 tasks/s |

**Queue capacity**: 1000 tasks (configurable)

**First run**: ~90s (download + load + inference)
**Subsequent runs**: ~30s (load + inference)

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
npm start
```

### Docker
```yaml
services:
  atel-sdk:
    environment:
      - ENABLE_AUDIT=true
    volumes:
      - ./models:/app/.atel/models  # Cache models
```

**Note**: Mount `.atel/models` to persist downloaded models across container restarts.

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
- Verify model downloaded: `ls .atel/models/`

### Model download fails
- Check network connection
- Check disk space (~400MB required)
- Try manual download from HuggingFace

### Queue full errors
- Increase `maxQueueSize` in config
- Check if LLM is responding slowly
- Monitor queue status: `auditService.getStatus()`

### LLM verification slow
- First run is slower (model loading)
- Subsequent runs are faster (~30s)
- Use `strategy: 'rule'` for low-risk tasks only

## Migration

### From Ollama-based audit
1. Remove Ollama installation (optional)
2. Update config (remove `llm_endpoint` and `llm_model_path`)
3. Restart agent (model downloads automatically)
4. No code changes required

### Rollback
Set `ENABLE_AUDIT=false` or remove config. Service is fully optional.

## Technical Details

### Model
- **Name**: qwen2.5-0.5b-instruct-q4_0.gguf
- **Size**: ~400MB
- **Source**: HuggingFace (Qwen/Qwen2.5-0.5B-Instruct-GGUF)
- **Location**: `.atel/models/`

### Inference Engine
- **Library**: node-llama-cpp (v3.17.1)
- **Backend**: llama.cpp (CPU inference)
- **Context size**: 2048 tokens
- **Temperature**: 0.7

### Performance Optimization
- Model is loaded once and reused
- Inference runs in separate context
- Async queue prevents blocking
- Graceful degradation if model unavailable
