# W3C Trace Context 透传实现文档

## 功能概述

为 `opentelemetry-instrumentation-openclaw` 插件新增 **W3C Trace Context 透传能力**（[Issue #33](https://github.com/alibaba/loongsuite-js-plugins/issues/33)），在不修改 openclaw 源码的前提下，实现：

1. **入方向（Inbound）**：继承上游传入的 `traceparent`，OpenClaw Entry span 成为上游 trace 的子节点
2. **出方向（Outbound）**：调用下游 LLM 服务时，在 HTTP 请求头中注入 `traceparent`

支持两种入方向传输路径：
- **HTTP**：从请求头 `traceparent` 提取
- **WebSocket**：从消息 payload 的 `metadata.traceparent` 提取

## 核心实现思路

openclaw 的 hook 系统工作在应用语义层，不暴露 HTTP 传输层（请求头、连接对象等）。因此本方案采用 **Node.js HTTP 模块 monkey-patch** 绕过 hook 系统限制：

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

### ESM 模块 monkey-patch 的关键技术点

Node.js ESM 命名空间对象（`import * as X from 'node:http'`）的属性描述符是 `non-configurable, non-writable`，不能直接赋值修改。解决方案是使用 `createRequire(import.meta.url)` 获取可变的 CJS `module.exports` 对象：

```typescript
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const httpModule  = _require("http");   // 可变的 CJS exports
const httpsModule = _require("https");  // 可变的 CJS exports
```

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/trace-propagation.ts` | 新增 | W3C 工具函数、AsyncLocalStorage、HTTP 模块 monkey-patch |
| `src/types.ts` | 修改 | `ArmsTraceConfig` 新增 2 个配置字段 |
| `src/index.ts` | 修改 | 集成 propagation 生命周期，7 处改动 |
| `openclaw.plugin.json` | 修改 | configSchema 新增 2 个配置项 |
| `test/trace-propagation.test.ts` | 新增 | 34 个单元测试 |

---

## 详细实现

### 1. `src/trace-propagation.ts`（新增）

核心传播模块，包含以下组件：

#### 1.1 AsyncLocalStorage 传播存储

```typescript
interface PropagationStore {
  remoteParentContext?: Context;     // 入方向：解析后的远程 parent context
  outboundSpanContext?: SpanContext; // 出方向：当前 Step span 的 context
}

const propagationStore = new AsyncLocalStorage<PropagationStore>();
```

`enterWith()` 在 Node.js AsyncHooks 体系中，会让当前 async resource 及其所有派生子 resource（后续 hook handler、LLM HTTP 调用）都读到同一个 store。

#### 1.2 W3C Trace Context 解析/格式化

- `parseTraceparent(header)` — 解析 `00-{32hex traceId}-{16hex spanId}-{2hex flags}` 格式，拒绝全零 ID
- `formatTraceparent(ctx)` — 将 SpanContext 格式化为 traceparent 字符串

#### 1.3 Store 读写 API

- `getRemoteParentContext()` — 读取入方向 remote parent context
- `updatePropagationStore(patch)` — 合并式更新 store（无 store 时通过 enterWith 创建）
- `resetPropagationStore()` — 清空 store（主要用于测试）

#### 1.4 HTTP Server Patch（入方向）

Patch `http.Server.prototype.emit`，拦截 `'request'`（HTTP）和 `'upgrade'`（WebSocket 握手）事件：

```typescript
// 'request': HTTP 请求；'upgrade': WebSocket 握手升级
if (event === "request" || event === "upgrade") {
  const tp = req.headers["traceparent"];
  // 解析 → 建立 remote parent context → enterWith 到 async chain
  propagationStore.enterWith(store);
}
```

#### 1.5 HTTP/HTTPS Client Patch（出方向）

Patch `http.request` 和 `https.request`，在满足过滤条件时注入 `traceparent` header：

- `shouldInject(url, targetUrls?, excludeUrl?)` — URL 过滤逻辑
- `makeRequestPatch(original, targetUrls?, excludeUrl?)` — 创建注入 wrapper，处理 3 种调用签名重载

#### 1.6 生命周期

- `installPropagation(cfg)` — 安装所有 patch（幂等）
- `uninstallPropagation()` — 恢复原始函数引用

### 2. `src/types.ts`（修改）

`ArmsTraceConfig` 新增字段：

```typescript
enableTracePropagation?: boolean;   // 默认 false，不影响现有行为
propagationTargetUrls?: string[];   // 出方向 URL 白名单
```

### 3. `src/index.ts`（修改，7 处）

| 改动点 | 位置 | 说明 |
|---|---|---|
| import | 顶部 | 引入 trace-propagation.ts 导出函数 |
| config 构建 | `activate()` | 读取 `enableTracePropagation` 和 `propagationTargetUrls` |
| installPropagation | `activate()` config 之后 | 条件安装 HTTP monkey-patch |
| gateway_stop | hook handler | 条件调用 `uninstallPropagation()` |
| ensureEntrySpan | 函数体 | 读取 `getRemoteParentContext()` 作为 Entry span 的 parent；同步 `ctx.traceId` |
| message_received | hook handler | WebSocket 路径：从 `event.metadata.traceparent` 提取远程 context |
| llm_input | hook handler | 出方向：将 Step span context 写入 propagation store |

#### 入方向两条路径统一

```
HTTP 请求                          WebSocket 消息
─────────────────────              ─────────────────────────────
emit('request') 触发               message_received hook 触发
↓                                  ↓
propagationStore.enterWith(store)  parseTraceparent(event.metadata.traceparent)
                                   ↓
                                   updatePropagationStore({ remoteParentContext })
↓                                  ↓
            ensureEntrySpan() 读取 getRemoteParentContext()
            ↓
            h.startEntry(entryInv, remoteParentCtx, now)
```

#### ctx.traceId 同步

继承上游 traceId 时，OTel SDK 创建的 span 使用上游的 traceId，而 `ctx.traceId` 是本地生成的值。`ensureEntrySpan` 中会同步这两者，并重新映射 `traceTaskQueueByTraceId` 和 `pendingAssistantByTraceId` 两个内部 Map 的 key。

### 4. `openclaw.plugin.json`（修改）

新增配置项：

```json
{
  "enableTracePropagation": {
    "type": "boolean",
    "default": false,
    "description": "Enable W3C Trace Context propagation"
  },
  "propagationTargetUrls": {
    "type": "array",
    "items": { "type": "string" },
    "description": "URL substrings for outbound traceparent injection"
  }
}
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

### 单元测试（34 个用例）

| 模块 | 用例数 | 覆盖内容 |
|---|---|---|
| `parseTraceparent` | 7 | 合法 header、大写转换、格式错误、版本号错误、全零 traceId/spanId、空字符串 |
| `formatTraceparent` | 3 | 格式化、往返一致性、flags 补零 |
| install/uninstall 生命周期 | 8 | patch 安装、幂等性、卸载恢复、无安装时卸载无副作用 |
| HTTP 入方向 | 4 | traceparent 提取、无 header、无效 header、upgrade 事件 |
| WebSocket 入方向 | 2 | updatePropagationStore 直接调用、字段合并 |
| shouldInject | 5 | 无过滤、excludeUrl、匹配 targetUrl、不匹配、优先级 |
| 出方向注入 (makeRequestPatch) | 5 | 有 spanContext 注入、无 spanContext 不注入、白名单匹配/不匹配、OTLP 排除 |

运行测试：

```bash
npx vitest run
```

### 端到端测试

#### 前置条件

- 运行中的 openclaw 实例
- OTLP 兼容的后端（如 Jaeger、阿里云 ARMS、Grafana Tempo）

#### 场景 A：向后兼容验证

```json
{
  "endpoint": "https://your-otlp-backend:4318",
  "enableTracePropagation": false
}
```

**验证**：trace 行为与此前版本完全一致，Entry span 使用自生成的 traceId。

#### 场景 B：HTTP 入方向继承

```json
{
  "endpoint": "https://your-otlp-backend:4318",
  "enableTracePropagation": true
}
```

发送带 traceparent 的 HTTP 请求：

```bash
curl -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
     http://localhost:<openclaw-port>/your-endpoint \
     -d '{"message": "hello"}'
```

**验证**：在 OTLP 后端查看，Entry span 的 `traceId` 为 `4bf92f3577b34da6a3ce929d0e0e4736`，parent spanId 为 `00f067aa0ba902b7`。

#### 场景 C：WebSocket 入方向继承

通过 WebSocket 发送消息，在 payload 的 `metadata` 中携带 `traceparent`：

```json
{
  "content": "hello",
  "metadata": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  }
}
```

**验证**：同场景 B，Entry span 继承上游 traceId。

#### 场景 D：出方向注入

开启透传后，在 OTLP 后端或 LLM API 侧抓包：

**验证**：出方向 HTTP 请求头中包含 `traceparent: 00-{traceId}-{spanId}-01`，其中 traceId 与 Entry span 一致。

#### 场景 E：URL 白名单过滤

```json
{
  "enableTracePropagation": true,
  "propagationTargetUrls": ["api.openai.com"]
}
```

**验证**：只有发往 `api.openai.com` 的请求被注入 traceparent，其他出方向请求不受影响。OTLP endpoint 无论是否在白名单中都不会被注入。

---

## 已知限制

| 限制 | 说明 | 影响 |
|---|---|---|
| `globalThis.fetch` (undici) | Node.js ≥ 18 的 native fetch 不经过 `https.request`，当前 patch 无法覆盖 | 使用 `node-fetch` 或 `https.request` 的 LLM SDK 不受影响；使用 undici 的需要后续 Phase 2 支持 |
| `worker_threads` | `AsyncLocalStorage` 不跨 worker 边界 | 不影响主线程场景，openclaw 当前不使用 worker |

---

## 向后兼容

- `enableTracePropagation` 默认 `false`，所有新增代码路径均在此开关保护下
- 关闭状态下，零额外运行时开销（不安装任何 monkey-patch）
- 现有测试套件（`plugin.test.ts`、`trace-compat.test.ts`、`arms-exporter.test.ts`）全部通过
