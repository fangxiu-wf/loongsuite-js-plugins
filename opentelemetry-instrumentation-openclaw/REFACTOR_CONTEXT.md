# opentelemetry-instrumentation-openclaw 重构摘要

## 目标

将 `@loongsuite/opentelemetry-instrumentation-openclaw` 插件的 trace 数据构建和 span 生命周期管理逻辑，迁移到使用 `@loongsuite/opentelemetry-util-genai` 库实现。

核心原则：
- 尽可能不直接操作 span 对象，改为操作 invocation 对象
- 保证现有 trace 结构、span 属性在重构后完全不变（回归兼容）
- span 生命周期由 `util-genai` handler 管理

## 分支信息

- 分支名：`feat/openclaw-genai-handler-phase12`
- 基于：`upstream/main`（包含 `@loongsuite/opentelemetry-util-genai@0.1.0`）
- 上游仓库：`alibaba/loongsuite-js-plugins`

## 变更文件清单

### 新增文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/invocation-builder.ts` | 273 | 将 openclaw 事件数据转换为 util-genai invocation 对象 |
| `src/invocation-compat.ts` | 102 | 兼容层：确保属性格式与原始实现一致 |
| `test/trace-compat.test.ts` | 999 | 回归基线测试（6 个流程，L1-L4 四级断言） |

### 修改文件

| 文件 | 说明 |
|---|---|
| `src/index.ts` | 主逻辑重构：引入 handler，迁移 Entry/Agent/Step/LLM/Tool span 生命周期 |
| `src/arms-exporter.ts` | 新增公共方法暴露内部能力给 handler 使用 |
| `package.json` | 添加 `@loongsuite/opentelemetry-util-genai: ^0.1.0` 依赖 |
| `package-lock.json` | 锁文件更新 |
| `test/plugin.test.ts` | mock 增强以适配新的 handler 调用模式 |
| `scripts/install-local-test.sh` | 本地测试脚本微调 |
| `README.md` | 版本说明更新 |

## 架构变更详解

### 1. Handler 初始化 (`ensureHandler`)

```typescript
const ensureHandler = async (): Promise<ExtendedTelemetryHandler> => {
  if (handler) return handler;
  await exporter.ensureInitialized();
  const tracerProvider = exporter.getTracerProvider();
  handler = new ExtendedTelemetryHandler({
    tracerProvider: tracerProvider || undefined,
    instrumentationName: "opentelemetry-instrumentation-openclaw",
    instrumentationVersion: PLUGIN_VERSION,
  });
  return handler;
};
```

关键点：传入 `instrumentationName` 和 `instrumentationVersion` 确保 `otel.scope.name` / `otel.scope.version` 保持原值。

### 2. Entry Span 生命周期迁移

- 由 `handler.startEntry(inv, parentCtx, startTime)` 创建
- span 名称改为 `enter_ai_application_system`
- 由 `handler.stopEntry(inv, endTime)` 结束
- invocation 对象存储在 `TraceContext.entryInvocation`

### 3. Agent Span 生命周期迁移

- 由 `handler.startInvokeAgent(inv, parentCtx, startTime)` 创建
- 由 `handler.stopInvokeAgent(inv, endTime)` 结束
- invocation 对象存储在 `TraceContext.agentInvocation`

### 4. Step (ReAct) Span 生命周期迁移

- 由 `handler.startReactStep(inv, parentCtx, startTime)` 创建
- 由 `handler.stopReactStep(inv, endTime)` 结束
- 关键修复：`endStepSpan` 使用 `Math.max(endTime, ctx.lastLlmEndTime)` 确保 Step span 不会早于其子 LLM span 结束

### 5. LLM Span 生命周期迁移

- 由 `handler.startLlm(inv, parentCtx, startTime)` 创建
- 由 `handler.stopLlm(inv, endTime)` 结束
- 支持分段 LLM span（openclaw 的多 LLM 模式）
- `ctx.lastLlmEndTime` 跟踪最后一个 LLM span 的结束时间

### 6. Tool Span 生命周期迁移

- 由 `handler.startExecuteTool(inv, parentCtx, startTime)` 创建
- 由 `handler.stopExecuteTool(inv, endTime)` 结束

### 7. `ArmsExporter` 新增公共方法

```typescript
getTracerProvider(): BasicTracerProvider | null
resolveParentContextFor(parentSpanId?: string): Context
getOpenSpan(spanId: string): Span | undefined
registerOpenSpan(spanId: string, span: Span): void
unregisterOpenSpan(spanId: string): void
```

### 8. 兼容性处理 (`invocation-compat.ts`)

| 函数 | 作用 |
|---|---|
| `compatFinishReasons` | 强制 `gen_ai.response.finish_reasons` 为 JSON 字符串格式 |
| `compatSerializeMessages` | 强制 `gen_ai.input_messages` / `gen_ai.output_messages` 为截断后的 JSON 字符串 |
| `compatSpanKindDialect` | 确保 `gen_ai.span.kind` 为单一 key 输出（不是数组） |

### 9. RunId 重绑定修复

`bindRealRunId` 中同步更新 `ctx.entryInvocation.attributes` 和 `ctx.agentInvocation.attributes`，防止 `applyXxxFinishAttributes` 用旧值覆盖。

### 10. 时间一致性修复

- `TraceContext` 增加 `lastLlmEndTime?: number`
- `exportPendingLlmSpan` 完成时更新 `ctx.lastLlmEndTime`
- `agent_end` hook 中增加等待循环（最多 5s），等待 pending LLM 完成后再结束 Step span

## 回归测试策略

`test/trace-compat.test.ts` 包含 6 个完整流程，4 级断言：

| 级别 | 断言内容 |
|---|---|
| L1 | span 创建数量正确 |
| L2 | span 名称和关键属性正确 |
| L3 | span 属性值完全匹配（token、model、finish_reason 等） |
| L4 | parent-child 链正确 + timestamp 顺序正确 |

6 个测试流程：
1. 基本单轮对话
2. 多轮对话（多个 Step + LLM）
3. 工具调用流程
4. runId 重绑定验证
5. 错误处理流程
6. agent_end 与 LLM 时间竞态

## 已验证的 Trace

以下 trace 在 ARMS 平台经过完整验证：
- `5bf8de6a099af1ceb67c5dc88191e67c` — 初始验证
- `6c627577e657106b9eae6029f6bd691c` — 修复后二次验证

验证确认：span 结构、属性名/值、parent-child 关系、时间顺序均与重构前一致。

## 依赖关系

```
@loongsuite/opentelemetry-instrumentation-openclaw@0.1.2
  └── @loongsuite/opentelemetry-util-genai@^0.1.0 (npm registry)
```

## 待办

- [ ] 提交代码并创建 PR 到 `alibaba/loongsuite-js-plugins`
- [ ] 发布新版本 `@loongsuite/opentelemetry-instrumentation-openclaw`（含 util-genai 集成）
