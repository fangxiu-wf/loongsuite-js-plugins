# W3C Trace Context 透传实现文档

## 功能概述

为 `opentelemetry-instrumentation-openclaw` 插件新增 **W3C Trace Context 透传能力**（[Issue #33](https://github.com/alibaba/loongsuite-js-plugins/issues/33)），在不修改 openclaw 源码的前提下，实现：

1. **入方向（Inbound）**：继承上游传入的 `traceparent`，OpenClaw Entry span 成为上游 trace 的子节点
2. **出方向（Outbound）**：调用下游 LLM 服务时，在 HTTP 请求头中注入 `traceparent`
3. **自定义属性透传**：B-service 可通过消息内容携带自定义 key-value 属性，注入到所有 span

支持两种入方向传输路径：
- **HTTP**：从请求头 `traceparent` 提取（含 WebSocket 握手阶段的 `upgrade` 事件）
- **WebSocket 消息**：从消息内容末尾的 `<!--otel:{JSON}-->` 标记提取

## 核心实现思路

openclaw 的 hook 系统工作在应用语义层，不暴露 HTTP 传输层（请求头、连接对象等）。

- **HTTP 入方向**：monkey-patch `http.Server.prototype.emit`，在 `'request'` 和 `'upgrade'` 事件中提取 `traceparent` header
- **WebSocket 入方向**：openclaw 的 `toPluginMessageReceivedEvent()` 硬编码了 `metadata` 字段，不透传自定义字段。因此采用 **消息内容嵌入** 方案——在消息末尾追加 HTML 注释格式的 otel 载荷，插件在 `message_received` hook 中提取
- **出方向**：monkey-patch `http.request` / `https.request`，从 `AsyncLocalStorage` 读取当前 Step span context 并注入 `traceparent` header

```
┌─────────────────────────────────────────────────────────┐
│                    Node.js HTTP 层                       │
│  ┌─────────────────────┐    ┌─────────────────────────┐ │
│  │ http.Server.emit    │    │ https.request            │ │
│  │ (monkey-patched)    │    │ (monkey-patched)         │ │
│  │                     │    │                          │ │
│  │ 提取 traceparent    │    │ 注入 traceparent         │ │
│  │ → AsyncLocalStorage │    │ ← AsyncLocalStorage      │ │
│  └─────────────────────┘    └─────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                          ↕
┌─────────────────────────────────────────────────────────┐
│                  openclaw hook 层                        │
│  message_received → llm_input → before_tool_call → ...  │
│  (读写 AsyncLocalStorage，与 HTTP 层共享上下文)           │
└─────────────────────────────────────────────────────────┘
```

### ESM monkey-patch 技术要点

Node.js ESM 命名空间对象（`import * as X from 'node:http'`）的属性描述符是 `non-configurable, non-writable`。使用 `createRequire(import.meta.url)` 获取可变的 CJS `module.exports` 对象来执行 monkey-patch。

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/trace-propagation.ts` | 新增 | W3C 工具函数、AsyncLocalStorage、HTTP monkey-patch、content extraction |
| `src/types.ts` | 修改 | `ArmsTraceConfig` 新增 2 个配置字段 |
| `src/index.ts` | 修改 | 集成 propagation 生命周期 + 自定义属性注入 |
| `openclaw.plugin.json` | 修改 | configSchema 新增 2 个配置项 |
| `test/trace-propagation.test.ts` | 新增 | 单元测试 |

---

## 入方向两条路径

### HTTP 路径

通过 `http.Server.prototype.emit` patch，在 `'request'`（HTTP）和 `'upgrade'`（WebSocket 握手）事件中提取 `traceparent` header，写入 `AsyncLocalStorage`。

### WebSocket 消息路径（content embedding）

openclaw 的 `ChatSendParamsSchema` 中 `message: Type.String()` 的值会原样传递到插件 hook 的 `event.content`：

```
B-service ws.send({ message: "...\n<!--otel:...-->" })
    → ChatSendParamsSchema 校验（message 是合法 string）
    → sanitizeChatSendMessageInput（NFC normalize + 控制字符过滤，不影响 HTML 注释）
    → MsgContext.BodyForCommands = parsedMessage
    → toPluginMessageReceivedEvent() → event.content
    → 插件 message_received hook 提取
```

#### 协议格式

```
{用户原始消息}\n<!--otel:{JSON}-->
```

JSON 结构：

```typescript
{
  "tp"?: string,                                     // W3C traceparent
  "attr"?: Record<string, string | number | boolean>  // 自定义 span attributes
}
```

示例：

```
请帮我查询今天的天气
<!--otel:{"tp":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","attr":{"user.id":"U-12345","env":"production"}}-->
```

#### 安全限制

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 最大 key 数量 | 20 | 防止 span attribute 膨胀 |
| key 最大长度 | 128 字符 | OTel 语义约定建议 |
| value 最大长度 | 1024 字符 | 防止属性值过大 |
| value 类型 | `string \| number \| boolean` | 符合 OTel attribute 规范 |
| 保留 key 前缀 | `openclaw.`、`gen_ai.` | 禁止覆盖，静默忽略 |

#### 自定义属性注入范围

自定义属性注入到当前 trace 的**所有 span**（Entry、Agent、Step、LLM、Tool）。

#### 与 HTTP 路径的优先级

如果同时存在 HTTP header `traceparent`（通过 `upgrade` 握手注入）和 content 中嵌入的 traceparent，以 **content 中的为准**。HTTP header 的 traceparent 在 WebSocket 长连接场景中只代表握手时刻的 trace，无法区分后续不同消息。

### 两条路径汇合

```
HTTP 请求                          WebSocket 消息
─────────────────────              ─────────────────────────────
emit('request'/'upgrade') 触发     message_received hook 触发
↓                                  ↓
propagationStore.enterWith(store)  extractOtelFromContent(event.content)
                                   ↓
                                   updatePropagationStore({ remoteParentContext })
↓                                  ↓
            ensureEntrySpan() 读取 getRemoteParentContext()
            ↓
            h.startEntry(entryInv, remoteParentCtx, now)
```

---

## 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enableTracePropagation` | `boolean` | `false` | 总开关，开启后启用入方向继承和出方向注入 |
| `propagationTargetUrls` | `string[]` | `undefined` | 出方向 URL 白名单，仅对包含这些子串的 URL 注入 traceparent。省略时注入所有出方向请求（OTLP endpoint 自动排除） |

配置示例：

```json
{
  "endpoint": "https://your-otlp-backend:4318",
  "enableTracePropagation": true,
  "propagationTargetUrls": ["api.openai.com", "api.anthropic.com"]
}
```

---

## 测试覆盖

### 单元测试（98 个用例）

| 模块 | 用例数 | 覆盖内容 |
|---|---|---|
| `parseTraceparent` | 7 | 合法 header、大写转换、格式错误、版本号错误、全零 traceId/spanId、空字符串 |
| `formatTraceparent` | 3 | 格式化、往返一致性、flags 补零 |
| install/uninstall 生命周期 | 8 | patch 安装、幂等性、卸载恢复、无安装时卸载无副作用 |
| HTTP 入方向 | 4 | traceparent 提取、无 header、无效 header、upgrade 事件 |
| WebSocket 入方向 | 2 | updatePropagationStore 直接调用、字段合并 |
| shouldInject | 5 | 无过滤、excludeUrl、匹配 targetUrl、不匹配、优先级 |
| 出方向注入 (makeRequestPatch) | 5 | 有 spanContext 注入、无 spanContext 不注入、白名单匹配/不匹配、OTLP 排除 |
| extractOtelFromContent | 13 | traceparent only、attributes only、both、无载荷、JSON 错误、非末尾、无效 tp、保留前缀过滤、数量限制、值截断、非原始类型跳过、key 长度限制、无换行符 |
| 现有测试套件 | 51 | plugin.test.ts、trace-compat.test.ts、arms-exporter.test.ts |

运行测试：

```bash
npx vitest run
```

---

## 端到端测试

### 前置条件

- 运行中的 openclaw 实例
- OTLP 兼容的后端（如 Jaeger、阿里云 ARMS、Grafana Tempo）

### 场景 A：向后兼容

```json
{ "enableTracePropagation": false }
```

**验证**：trace 行为与此前版本完全一致。

### 场景 B：HTTP 入方向

```bash
curl -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
     http://localhost:<port>/your-endpoint \
     -d '{"message": "hello"}'
```

**验证**：Entry span 的 `traceId` 为 `4bf92f3577b34da6a3ce929d0e0e4736`，parent spanId 为 `00f067aa0ba902b7`。

### 场景 C：WebSocket 入方向（content embedding）

通过 WebSocket 发送 `chat.send`，在 message 末尾携带 otel 标记：

```javascript
ws.send(JSON.stringify({
  method: "chat.send",
  params: {
    sessionKey: "session-1",
    message: "请帮我查询天气\n<!--otel:{\"tp\":\"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\",\"attr\":{\"user.id\":\"U-12345\"}}-->",
    idempotencyKey: crypto.randomUUID(),
  },
}));
```

**验证**：
- Entry span 继承上游 traceId
- 所有 span 的 attributes 中包含 `user.id: "U-12345"`
- span 的 `gen_ai.input.messages` 中用户消息为清理后的内容（不含 otel 标记）

### 场景 D：出方向注入

**验证**：下游 LLM API 请求头中包含 `traceparent` header，traceId 与 Entry span 一致。

### 场景 E：URL 白名单过滤

```json
{ "propagationTargetUrls": ["api.openai.com"] }
```

**验证**：仅 `api.openai.com` 的请求被注入 traceparent。

---

## 设计决策说明

### 出方向注入使用 Step span 而非 LLM span

注入到下游 HTTP 请求的 `traceparent` 中的 `spanId` 是 Step span 的 ID，而非 LLM span。原因：LLM span 采用 post-hoc 方式创建（`exportPendingLlmSpan` 中一次性 start+stop），在 `llm_input` hook 触发时尚未创建。Step span 是当前架构下唯一可用的 parent。traceId 一致性不受影响。

### WebSocket otel 标记的 LLM 可见性

otel 标记会作为消息内容的一部分发送给 LLM，因为 openclaw 的 `message_received` 是 fire-and-forget（`runVoidHook`），没有 hook 可以在 LLM 调用前修改用户消息。HTML 注释格式被主流 LLM 基本忽略（约 20-30 tokens 开销）。插件将清理后的内容写入 span 的 `gen_ai.input.messages` attribute。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| `globalThis.fetch` (undici) | Node.js ≥ 18 的 native fetch 不经过 `https.request`，当前 patch 无法覆盖 |
| `worker_threads` | `AsyncLocalStorage` 不跨 worker 边界，不影响主线程场景 |
| `tracestate` 未传播 | 当前仅处理 `traceparent`，不传播 vendor-specific 的 `tracestate` header |

---

## 向后兼容

- `enableTracePropagation` 默认 `false`，所有新增代码路径均在此开关保护下
- 关闭状态下，零额外运行时开销（不安装任何 monkey-patch）
- 现有测试套件全部通过
