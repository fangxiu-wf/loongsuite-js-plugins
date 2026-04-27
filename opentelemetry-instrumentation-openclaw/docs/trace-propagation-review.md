# Trace Propagation 代码审查

> 审查目标：commit `4b8dff7b` 中 W3C Trace Context 透传实现
> 审查范围：`src/trace-propagation.ts`、`src/index.ts`、`src/types.ts`、`openclaw.plugin.json`、`test/trace-propagation.test.ts`
> WebSocket 相关问题已在 `docs/websocket-trace-propagation.md` 中单独讨论，本文档不重复覆盖

---

## 问题清单

### P1 — 出方向注入的 Span 语义不精确

**位置**：`src/index.ts:1496-1501`

```typescript
if (config.enableTracePropagation && ctx.stepSpanId) {
  const stepSpan = exporter.getOpenSpan(ctx.stepSpanId);
  if (stepSpan) {
    updatePropagationStore({ outboundSpanContext: stepSpan.spanContext() });
  }
}
```

**问题**：注入到下游 LLM HTTP 请求的 `traceparent` 中的 `spanId` 是 **Step span** 的 ID。从 trace 拓扑上看，下游 LLM 服务看到的 parent 是 Step span，而非更精确的 LLM span。

**语义上的期望关系**：
```
Entry → Agent → Step → LLM span → (下游 LLM HTTP 请求)
                              ↑ 应该用 LLM span 作为 parent
```

**当前实际关系**：
```
Entry → Agent → Step → LLM span
                  ↑
            下游看到的 parent（Step span）
```

**影响**：traceId 一致性不受影响（下游仍然在同一个 trace 中），但在 trace 拓扑图中 parent-child 层级不够精确。当 Step 下有多个 LLM 调用时（如 tool use 循环），所有出方向请求共享同一个 Step parent，无法区分是哪个 LLM 调用发起的。

**建议**：在 `llm_input` hook 中，先创建 LLM span，再将 LLM span 的 context 写入 propagation store。但这需要调整 span 生命周期管理（目前 LLM span 在 `exportPendingLlmSpan` 中一次性 start+stop），改动较大。如果当前精度可以接受，建议在文档中说明此设计选择。

**优先级**：低。功能正确，仅影响 trace 拓扑精度。

---

### P2 — 出方向 patch 直接修改调用者的 options 对象

**位置**：`src/trace-propagation.ts:191-193`

```typescript
const headers = (opts.headers as Record<string, string>) || {};
headers["traceparent"] = formatTraceparent(spanCtx);
opts.headers = headers;
```

**问题**：`opts` 直接引用了调用者传入的 options 对象。修改 `opts.headers` 会产生副作用：

1. 如果调用者复用同一个 options 对象发送多次请求，第二次请求会携带上次注入的 stale traceparent
2. 如果调用者在 `request()` 调用后检查 options 对象，会发现被意外修改

**修复建议**：

```typescript
if (spanCtx && shouldInject(urlStr, targetUrls, excludeUrl)) {
  const existingHeaders = (opts.headers as Record<string, string>) || {};
  // 创建 headers 浅拷贝，避免修改调用者的原始对象
  opts = { ...opts, headers: { ...existingHeaders, traceparent: formatTraceparent(spanCtx) } };
  // 同时需要更新传给 original 的参数引用
}
```

注意：修复后还需要确保 `original.call(this, ...)` 使用修改后的 `opts` 而非原始的 `urlOrOptions`/`optionsOrCb`。当前代码中 `original.call(this, urlOrOptions, optionsOrCb, cb)` 传的是原始引用，因为 `opts` 就是对 `urlOrOptions` 或 `optionsOrCb` 的引用，所以在修改指向新对象后，需要同步更新传参。

**优先级**：中。实际场景中 LLM SDK 通常每次请求创建新的 options 对象，触发概率低，但作为通用 HTTP patch 应该避免此类副作用。

---

### P3 — 未传播 `tracestate` header

**位置**：`src/trace-propagation.ts` 全局

**问题**：W3C Trace Context 规范定义了两个 header：
- `traceparent`：必须，包含 traceId、spanId、flags
- `tracestate`：可选，携带 vendor-specific 追踪信息（如阿里云 ARMS 的自定义 tag）

当前实现仅处理 `traceparent`，完全忽略 `tracestate`。如果上游使用了 tracestate（例如 ARMS 注入的 `sw8=...` 或自定义 key-value），这些信息会丢失。

**影响**：
- 不影响 traceId/spanId 的链路关联
- 可能丢失 vendor-specific 的追踪元数据
- 如果下游 LLM 服务或后端依赖 tracestate 中的信息（如采样决策、tenant 标识），会产生问题

**修复建议**：
1. 入方向：在 `patchHttpServer` 中同时读取 `req.headers["tracestate"]`，存入 propagation store
2. 出方向：在 `makeRequestPatch` 中同时注入 `tracestate` header
3. Store 接口扩展：`PropagationStore` 新增 `tracestate?: string` 字段

**优先级**：低。大多数场景不依赖 tracestate。如果客户使用 ARMS 且需要自定义 tag 透传，再考虑支持。

---

### P4 — `http.Server.prototype.emit` patch 的 `enterWith` 时序问题

**位置**：`src/trace-propagation.ts:116`

```typescript
propagationStore.enterWith(store);
```

**问题**：`enterWith()` 在 `emit('request')` 的同步执行上下文中调用。如果 openclaw 的 HTTP server 在同一个 Node.js event loop tick 中处理多个请求（例如 HTTP/2 multiplexing 或极端高并发），前一个请求的 `enterWith` 可能在后一个请求的 `enterWith` 之前还没有进入独立的 async context。

实际上，Node.js 的 `http.Server` 对于每个 TCP 连接的 `request` 事件是在独立的 async resource 中触发的，所以标准 HTTP/1.1 场景下这不是问题。但值得了解此假设。

**影响**：正常 HTTP/1.1 场景无影响。HTTP/2 或特殊 server 实现可能存在竞态。

**优先级**：极低。当前 openclaw 使用标准 HTTP server，不存在此风险。

---

### P5 — `makeRequestPatch` 三种调用签名处理的边界情况

**位置**：`src/trace-propagation.ts:152-197`

**问题 A**：当调用签名为 `request(options, callback)` 且 `options` 中无 `protocol`/`hostname`/`host` 时，构造的 `urlStr` 为 `"https://"`，无法正确匹配 `targetUrls` 过滤。这会导致在某些 SDK 使用 socket path 或 unix domain socket 时，shouldInject 的过滤行为不符合预期。

**问题 B**：`request(url, callback)` 路径中（line 174-178）：
```typescript
cb = optionsOrCb;
optionsOrCb = {};
opts = optionsOrCb as Record<string, unknown>;
```
创建了一个新的空对象作为 options，并将 headers 设置在上面。但最终调用 `original.call(this, urlOrOptions, optionsOrCb, cb)` 时传递了三个参数 `(url, {headers: {...}}, callback)`。这在 Node.js 中是合法的（`http.request(url, options, callback)` 签名），但改变了原始调用签名从 `(url, callback)` 到 `(url, options, callback)`。

对于标准 Node.js `http.request` 这不是问题，但如果有中间层也在做 monkey-patch 并依赖参数个数，可能产生不兼容。

**优先级**：低。实际 LLM SDK 使用标准调用方式，这些边界情况基本不会触发。

---

### P6 — 测试中缺少对 `http.get` 的验证

**位置**：`test/trace-propagation.test.ts`

**问题**：测试只覆盖了 `http.request` / `https.request` 的 patch，没有验证 `http.get` / `https.get` 是否也能正确注入 traceparent。

虽然 Node.js 的 `http.get` 内部调用 `exports.request`（所以 CJS patch 应该生效），但缺少测试覆盖来验证这个假设。

**修复建议**：新增测试用例验证 `http.get` 经过 patch 后也能注入 traceparent。

**优先级**：低。功能上应该是正确的，但测试覆盖不完整。

---

### P7 — 文档中 WebSocket 场景描述与实际实现不符

**位置**：`docs/trace-propagation.md:253-266`（场景 C）

**问题**：文档描述了通过 WebSocket payload 的 `metadata.traceparent` 传递 trace context 的端到端测试场景，但这条路径实际上不可用（如上分析）。文档会误导使用者按照不可用的方式接入。

**修复建议**：更新文档，移除场景 C 或替换为基于 content 嵌入的方案描述。

**优先级**：高。文档错误会直接导致用户接入失败。

---

## 正面评价

以下是实现中值得肯定的设计决策：

1. **ESM monkey-patch 方式正确**：通过 `createRequire(import.meta.url)` 获取可变 CJS exports，绕过 ESM namespace 的 non-configurable 限制
2. **幂等 install/uninstall**：双重调用 `installPropagation` 不会重复 patch，`uninstallPropagation` 正确恢复原始函数引用
3. **traceId 同步**：`ensureEntrySpan` 中正确处理了 OTel SDK 创建的 span（使用上游 traceId）与内部 `ctx.traceId` 的对齐，包括 `traceTaskQueueByTraceId` 和 `pendingAssistantByTraceId` 的 key 重映射
4. **OTLP endpoint 自动排除**：通过 `excludeUrl` 参数确保 trace 上报请求自身不被注入 traceparent，避免循环
5. **配置驱动 + 向后兼容**：`enableTracePropagation` 默认 `false`，关闭时零运行时开销
6. **测试覆盖充分**：34 个测试覆盖了 W3C 解析、生命周期、入方向提取、出方向注入、URL 过滤等核心路径

---

## 汇总

| # | 问题 | 优先级 | 类型 | 建议 |
|---|------|--------|------|------|
| P1 | 出方向注入使用 Step span 而非 LLM span | 低 | 语义精度 | 文档说明或后续优化 |
| P2 | 出方向 patch 修改调用者 options 对象 | 中 | 副作用 | 创建浅拷贝 |
| P3 | 未传播 tracestate header | 低 | 功能缺失 | 按需扩展 |
| P4 | enterWith 在高并发下的理论竞态 | 极低 | 理论风险 | 当前无需处理 |
| P5 | makeRequestPatch 边界调用签名 | 低 | 边界 case | 注意即可 |
| P6 | 缺少 http.get 测试覆盖 | 低 | 测试 | 补充测试 |
| P7 | 文档场景 C 与实现不符 | 高 | 文档 | 更新文档 |

**建议立即修复**：P7（文档错误）、P2（options 对象副作用）
**建议后续版本处理**：P1、P3、P5、P6
**无需处理**：P4
