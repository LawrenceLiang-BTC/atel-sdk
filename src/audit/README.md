# Tiered Audit System

分层审计系统为 ATEL 任务执行提供可选的 thinking chain 质量验证。

## 设计原则

1. **可选启用**：默认关闭，不影响现有部署
2. **非阻塞**：使用异步队列，不阻塞主流程
3. **独立部署**：可在 Platform 或 SDK 端独立运行
4. **配置驱动**：通过环境变量和配置文件控制

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Audit Service                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Async Queue  │→ │   Tiered     │→ │ LLM/Rule     │      │
│  │              │  │  Verifier    │  │  Verifier    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### 分层策略

- **Low Risk**: 规则验证（快速，<10ms）
  - 检查步骤数量
  - 关键词匹配
  - 长度验证

- **Medium Risk**: 规则 + LLM fallback
  - 先用规则验证
  - 失败则用 LLM 深度验证

- **High/Critical Risk**: LLM 验证
  - 完整的语义理解
  - 逻辑连贯性检查
  - 任务目标匹配度

## 使用方法

### 1. SDK 端集成（可选）

```typescript
import { AuditService } from '@lawrenceliang-btc/atel-sdk/audit';

const auditService = new AuditService({
  enabled: process.env.ENABLE_AUDIT === 'true',
  llm_endpoint: 'http://localhost:11434',
  llm_model_path: 'qwen2.5:0.5b',
  strategy: 'hybrid',
  onAuditComplete: (taskId, result) => {
    // 保存审计结果到数据库
    console.log(`Task ${taskId}: ${result.passed ? 'PASS' : 'FAIL'}`);
  },
});

// 任务完成后提交审计（非阻塞）
await auditService.submitForAudit(task, thinkingChain);
```

### 2. Platform 端集成（推荐）

Platform 收到任务结果后，可选地触发审计：

```go
// Go 代码示例（伪代码）
if enableAudit {
  go func() {
    // 调用审计服务 API
    result := auditService.Verify(task, thinkingChain)
    // 更新任务审计状态
    db.UpdateAuditResult(taskID, result)
  }()
}
```

### 3. 环境变量配置

```bash
# 启用审计
ENABLE_AUDIT=true

# Ollama 配置
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=qwen2.5:0.5b

# 审计策略
AUDIT_STRATEGY=hybrid  # rule | llm | hybrid

# 队列配置
AUDIT_QUEUE_SIZE=1000
AUDIT_MAX_RETRIES=3
```

## 性能影响

| 配置 | 延迟 | 吞吐量影响 |
|------|------|-----------|
| 禁用 | 0ms | 0% |
| 规则验证 | <10ms | <1% |
| LLM 验证 | 3-6s | 0%（异步） |

**关键点**：
- 审计在后台异步执行，不阻塞任务完成
- 审计失败不影响任务已完成的状态
- 审计结果用于信誉评分和质量监控

## 测试

```bash
# 运行示例
node examples/audit-service-example.mjs

# 运行测试
npm test -- src/audit
```

## 数据库 Schema（Platform 端）

```sql
CREATE TABLE task_audits (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(255) NOT NULL,
  agent_did VARCHAR(255) NOT NULL,
  passed BOOLEAN NOT NULL,
  violations TEXT[],
  confidence FLOAT,
  strategy VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_task_audits_task_id ON task_audits(task_id);
CREATE INDEX idx_task_audits_agent_did ON task_audits(agent_did);
```

## 监控指标

- `audit_queue_size`: 当前队列长度
- `audit_processing`: 是否正在处理
- `audit_pass_rate`: 通过率
- `audit_avg_time`: 平均审计时间

## 故障处理

1. **Ollama 不可用**：
   - 自动降级到规则验证
   - 记录错误日志
   - 不影响任务执行

2. **队列满**：
   - 拒绝新任务入队
   - 记录警告日志
   - 不影响任务执行

3. **审计超时**：
   - 重试机制（最多3次）
   - 最终失败记录到错误日志
   - 不影响任务执行

## 最佳实践

1. **Platform 端部署**：审计逻辑应该在 Platform 端，作为质量控制
2. **异步处理**：永远使用 `submitForAudit()`，不要用 `auditSync()`
3. **监控队列**：定期检查队列状态，避免积压
4. **分级策略**：根据任务风险等级选择合适的验证策略
5. **结果存储**：审计结果应该持久化，用于后续分析

## 与 Thinking 注册审计的区别

| 特性 | 注册审计 | 分层审计 |
|------|---------|---------|
| 时机 | Agent 注册时 | 任务执行后 |
| 目的 | 验证 thinking 能力 | 验证执行质量 |
| 阻塞 | 阻塞注册流程 | 异步，不阻塞 |
| 策略 | 简单步骤检查 | 分层策略 |
| 部署 | Platform 端 | Platform 或 SDK |

## 未来扩展

- [ ] 支持更多 LLM 后端（OpenAI, Anthropic）
- [ ] 机器学习模型训练（基于历史审计数据）
- [ ] 实时审计仪表板
- [ ] 审计结果影响 Agent 信誉分
- [ ] 自动化审计报告生成
