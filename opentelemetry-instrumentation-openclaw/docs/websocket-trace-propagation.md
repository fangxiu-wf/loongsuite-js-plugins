# WebSocket Trace Context 与自定义属性透传方案

## 背景

在 WebSocket 场景中，B-service 通过 WebSocket 连接 openclaw，有两个透传需求：

1. **Trace Context 继承**：将上游 A-service 传入的 trace context（traceId、spanId）传递给插件，使采集的 trace 能与上游链路关联
2. **自定义属性注入**：将业务相关的 key-value 数据传递给插件，注入到 trace 的所有 span attributes 中（如用户 ID、环境标识、订单号等）

### 约束条件

- **不可修改 openclaw 源码**
- openclaw WebSocket 协议 `ChatSendParamsSchema` 使用 `additionalProperties: false`，自定义字段被 schema 校验拒绝
- `toPluginMessageReceivedEvent()` 仅从固定业务字段组装 `metadata`，不透传自定义字段
- openclaw 的 hook 系统对用户消息内容（user prompt）采用**只读**设计：`message_received` 是 fire-and-forget（`runVoidHook`），`before_agent_start` 仅允许修改 system prompt，无 hook 可在 LLM 调用前修改用户消息

### 可用通道

`ChatSendParamsSchema` 所有字段中，只有 `message`（`Type.String()`）的值会原样传递到插件 hook 的 `event.content`：

```
B-service WebSocket send → params.message → MsgContext.content → hook event.content
```

其他字段要么需要 admin scope 权限、要么经过 normalize 丢失原值、要么不到达 hook。

**`message` 是唯一可用通道。**

---

## 协议格式

### 设计原则

- 使用 HTML 注释语法 `<!-- -->`，LLM 模型通常忽略此类标记
- 内部使用 JSON 载体，天然支持复杂值（含特殊字符的字符串、数字、布尔值）
- 位于消息末尾，正则锚定 `$`，避免误匹配正文内容
- traceparent 和自定义属性均为可选，B-service 可按需组合

### 格式定义

```
{用户原始消息}\n<!--otel:{JSON}-->
```

JSON 结构：

```typescript
{
  "tp"?: string,                                    // W3C traceparent
  "attr"?: Record<string, string | number | boolean> // 自定义 span attributes
}
```

### 示例

**仅 traceparent：**

```
请帮我查询今天的天气
<!--otel:{"tp":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}-->
```

**仅自定义属性：**

```
请帮我查询订单状态
<!--otel:{"attr":{"user.id":"U-12345","biz.order_id":"ORD-9876","env":"production"}}-->
```

**traceparent + 自定义属性：**

```
请帮我查询今天的天气
<!--otel:{"tp":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","attr":{"user.id":"U-12345","tenant":"acme-corp"}}-->
```

### 提取正则

```typescript
const OTEL_CONTENT_RE = /\n?<!--otel:(.*?)-->$/s;
```

---

## 处理流程

```
B-service                         openclaw                        Plugin
   │                                │                               │
   │ chat.send({                    │                               │
   │   message: "...\n<!--otel:..-->│                               │
   │ })                             │                               │
   │ ──────────────────────────────>│                               │
   │                                │ schema 校验通过               │
   │                                │ (message 是合法 string)       │
   │                                │                               │
   │                                │  message_received hook        │
   │                                │ ─────────────────────────────>│
   │                                │  event.content =              │
   │                                │    "...\n<!--otel:..-->"      │
   │                                │                               │
   │                                │                   ┌───────────┤
   │                                │                   │ 1. 正则提取│
   │                                │                   │    JSON    │
   │                                │                   │ 2. 解析 tp │
   │                                │                   │    → remote│
   │                                │                   │    parent  │
   │                                │                   │    context │
   │                                │                   │ 3. 解析attr│
   │                                │                   │    → custom│
   │                                │                   │    Attributes
   │                                │                   │ 4. clean   │
   │                                │                   │    Content │
   │                                │                   │    → user  │
   │                                │                   │    Input   │
   │                                │                   └───────────┤
   │                                │                               │
   │                                │        ensureEntrySpan()      │
   │                                │        继承上游 traceId       │
   │                                │        + customAttributes     │
   │                                │                               │
   │                                │        ensureAgentSpan()      │
   │                                │        + customAttributes     │
   │                                │                               │
   │                                │        ensureStepSpan()       │
   │                                │        + customAttributes     │
   │                                │                               │
   │                                │        exportPendingLlmSpan() │
   │                                │        + customAttributes     │
   │                                │                               │
   │                                │        tool span              │
   │                                │        + customAttributes     │
```

---

## 自定义属性注入规则

### 注入范围

自定义属性注入到**当前 trace 的所有 span**：

| Span 类型 | 注入方式 |
|-----------|---------|
| Entry     | `ensureEntrySpan` 中合并到 `entryInv.attributes` |
| Agent     | `ensureAgentSpan` 中合并到 `agentInv.attributes` |
| Step      | `ensureStepSpan` 中合并到 `stepInv.attributes` |
| LLM       | `exportPendingLlmSpan` 中合并到 `inv.attributes` |
| Tool      | `after_tool_call` handler 中合并到 `toolInv.attributes` |

### Key 命名

插件透传 B-service 传入的原始 key，不自动添加前缀。建议 B-service 使用业务前缀避免冲突：

- 推荐：`app.user.id`、`biz.order_id`、`env`
- 避免：`openclaw.*`、`gen_ai.*`（插件内部使用）

### 安全限制

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 最大 key 数量 | 20 | 防止 span attribute 膨胀 |
| key 最大长度 | 128 字符 | OTel 语义约定建议 |
| value 最大长度 | 1024 字符 | 防止属性值过大 |
| value 类型 | `string \| number \| boolean` | 符合 OTel attribute 规范 |
| 保留 key 前缀 | `openclaw.`、`gen_ai.` | 禁止覆盖，静默忽略 |

---

## 实现变更

### 1. `src/trace-propagation.ts` — 新增提取函数

```typescript
/** 自定义属性安全限制 */
const MAX_CUSTOM_ATTR_COUNT = 20;
const MAX_CUSTOM_ATTR_KEY_LEN = 128;
const MAX_CUSTOM_ATTR_VALUE_LEN = 1024;
const RESERVED_ATTR_PREFIXES = ["openclaw.", "gen_ai."];

/** 从消息内容末尾提取 otel 载荷 */
const OTEL_CONTENT_RE = /\n?<!--otel:(.*?)-->$/s;

export interface OtelContentPayload {
  spanContext?: SpanContext;
  customAttributes?: Record<string, string | number | boolean>;
  cleanContent: string;
}

export function extractOtelFromContent(content: string): OtelContentPayload | null {
  const m = OTEL_CONTENT_RE.exec(content);
  if (!m) return null;

  let parsed: { tp?: string; attr?: Record<string, unknown> };
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const result: OtelContentPayload = {
    cleanContent: content.slice(0, m.index),
  };

  // 解析 traceparent
  if (typeof parsed.tp === "string") {
    const spanCtx = parseTraceparent(parsed.tp);
    if (spanCtx) {
      result.spanContext = spanCtx;
    }
  }

  // 解析自定义属性（带安全限制）
  if (parsed.attr && typeof parsed.attr === "object" && !Array.isArray(parsed.attr)) {
    const attrs: Record<string, string | number | boolean> = {};
    let count = 0;
    for (const [key, value] of Object.entries(parsed.attr)) {
      if (count >= MAX_CUSTOM_ATTR_COUNT) break;
      if (key.length > MAX_CUSTOM_ATTR_KEY_LEN) continue;
      if (RESERVED_ATTR_PREFIXES.some((p) => key.startsWith(p))) continue;

      if (typeof value === "string") {
        attrs[key] = value.length > MAX_CUSTOM_ATTR_VALUE_LEN
          ? value.slice(0, MAX_CUSTOM_ATTR_VALUE_LEN)
          : value;
        count++;
      } else if (typeof value === "number" || typeof value === "boolean") {
        attrs[key] = value;
        count++;
      }
    }
    if (count > 0) {
      result.customAttributes = attrs;
    }
  }

  // 至少要有 tp 或 attr 之一有效，否则视为非 otel 载荷
  if (!result.spanContext && !result.customAttributes) return null;

  return result;
}
```

### 2. `src/index.ts` — TraceContext 新增字段

```typescript
interface TraceContext {
  // ... 现有字段 ...
  customAttributes?: Record<string, string | number | boolean>;
}
```

### 3. `src/index.ts` — 修改 `message_received` hook

替换当前 `event.metadata.traceparent` 逻辑：

```typescript
// 替换为:
if (config.enableTracePropagation) {
  const otelPayload = extractOtelFromContent(event.content);
  if (otelPayload) {
    // trace context 继承
    if (otelPayload.spanContext) {
      updatePropagationStore({
        remoteParentContext: trace.setSpanContext(ROOT_CONTEXT, otelPayload.spanContext),
      });
    }
    // 自定义属性存入 TraceContext
    if (otelPayload.customAttributes) {
      ctx.customAttributes = otelPayload.customAttributes;
    }
    // 使用清理后的内容（不含 otel 标记）
    ctx.userInput = otelPayload.cleanContent;
  } else {
    ctx.userInput = event.content;
  }
}
```

### 4. `src/index.ts` — 各 span 注入自定义属性

在以下位置合并 `ctx.customAttributes`：

**createSpan（兜底路径）：**
```typescript
const createSpan = (ctx, channelId, name, type, ...) => ({
  // ...
  attributes: {
    ...attributes,
    ...ctx.customAttributes,  // 新增
    "openclaw.version": openclawVersion,
    // ...
  },
});
```

**ensureEntrySpan：**
```typescript
if (ctx.customAttributes && entryInv.attributes) {
  Object.assign(entryInv.attributes, ctx.customAttributes);
}
```

**ensureAgentSpan、ensureStepSpan、exportPendingLlmSpan、tool span** 同理。

### 5. 测试新增

```typescript
describe("extractOtelFromContent", () => {
  it("extracts traceparent only", () => {
    const content = '你好\n<!--otel:{"tp":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}-->';
    const result = extractOtelFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.spanContext!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(result!.customAttributes).toBeUndefined();
    expect(result!.cleanContent).toBe("你好");
  });

  it("extracts custom attributes only", () => {
    const content = '查询订单\n<!--otel:{"attr":{"user.id":"U-123","count":42,"debug":true}}-->';
    const result = extractOtelFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.spanContext).toBeUndefined();
    expect(result!.customAttributes).toEqual({
      "user.id": "U-123",
      "count": 42,
      "debug": true,
    });
    expect(result!.cleanContent).toBe("查询订单");
  });

  it("extracts both traceparent and attributes", () => {
    const content = '你好\n<!--otel:{"tp":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","attr":{"env":"prod"}}-->';
    const result = extractOtelFromContent(content);
    expect(result!.spanContext!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(result!.customAttributes).toEqual({ "env": "prod" });
  });

  it("returns null for message without otel payload", () => {
    expect(extractOtelFromContent("普通消息")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractOtelFromContent("msg\n<!--otel:not-json-->")).toBeNull();
  });

  it("returns null for otel payload not at end", () => {
    expect(extractOtelFromContent('<!--otel:{"tp":"00-abc"}-->\n后续')).toBeNull();
  });

  it("ignores reserved attribute prefixes", () => {
    const content = '消息\n<!--otel:{"attr":{"openclaw.version":"hacked","user.id":"ok"}}-->';
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes).toEqual({ "user.id": "ok" });
  });

  it("enforces max attribute count", () => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < 25; i++) attrs[`key${i}`] = `val${i}`;
    const content = `消息\n<!--otel:${JSON.stringify({ attr: attrs })}-->`;
    const result = extractOtelFromContent(content);
    expect(Object.keys(result!.customAttributes!).length).toBe(20);
  });

  it("truncates long attribute values", () => {
    const longVal = "x".repeat(2000);
    const content = `消息\n<!--otel:{"attr":{"key":"${longVal}"}}-->`;
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes!["key"]).toHaveLength(1024);
  });

  it("skips non-primitive attribute values", () => {
    const content = '消息\n<!--otel:{"attr":{"obj":{"nested":1},"arr":[1,2],"ok":"yes"}}-->';
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes).toEqual({ "ok": "yes" });
  });
});
```

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/trace-propagation.ts` | 修改 | 新增 `extractOtelFromContent()`、安全限制常量、`OtelContentPayload` 类型 |
| `src/index.ts` | 修改 | `TraceContext` 新增 `customAttributes`；`message_received` 替换提取逻辑；各 span 创建点合并属性 |
| `test/trace-propagation.test.ts` | 修改 | 新增 `extractOtelFromContent` 测试用例 |
| `docs/trace-propagation.md` | 修改 | 更新 WebSocket 入方向描述，移除不可用的 metadata 路径 |

---

## B-service 接入指南

### 前提条件

- openclaw 配置启用 trace propagation：
  ```json
  {
    "enableTracePropagation": true
  }
  ```

### 消息发送格式

在 `chat.send` 的 `message` 字段末尾追加 `<!--otel:{JSON}-->` 标记：

```javascript
// B-service 示例代码（Node.js）
function sendMessageWithOtel(ws, sessionKey, message, options = {}) {
  const otelPayload = {};

  // 可选：携带 trace context
  if (options.traceContext) {
    const { traceId, spanId } = options.traceContext;
    otelPayload.tp = `00-${traceId}-${spanId}-01`;
  }

  // 可选：携带自定义属性
  if (options.attributes) {
    otelPayload.attr = options.attributes;
  }

  // 拼接到消息末尾
  const messageWithOtel = Object.keys(otelPayload).length > 0
    ? `${message}\n<!--otel:${JSON.stringify(otelPayload)}-->`
    : message;

  ws.send(JSON.stringify({
    method: "chat.send",
    params: {
      sessionKey,
      message: messageWithOtel,
      idempotencyKey: crypto.randomUUID(),
    },
  }));
}

// 使用示例
sendMessageWithOtel(ws, "session-1", "请帮我查询订单状态", {
  traceContext: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" },
  attributes: {
    "user.id": "U-12345",
    "biz.order_id": "ORD-9876",
    "env": "production",
    "priority": 1,
    "debug": false,
  },
});
```

### Java / Spring 示例

```java
import com.google.gson.Gson;
import com.google.gson.JsonObject;

public String buildMessageWithOtel(String userMessage, Span span, Map<String, Object> customAttrs) {
    JsonObject otel = new JsonObject();

    // 可选：trace context
    if (span != null) {
        String traceId = span.getSpanContext().getTraceId();
        String spanId  = span.getSpanContext().getSpanId();
        otel.addProperty("tp", String.format("00-%s-%s-01", traceId, spanId));
    }

    // 可选：自定义属性
    if (customAttrs != null && !customAttrs.isEmpty()) {
        JsonObject attrs = new JsonObject();
        for (Map.Entry<String, Object> entry : customAttrs.entrySet()) {
            Object v = entry.getValue();
            if (v instanceof String)  attrs.addProperty(entry.getKey(), (String) v);
            if (v instanceof Number)  attrs.addProperty(entry.getKey(), (Number) v);
            if (v instanceof Boolean) attrs.addProperty(entry.getKey(), (Boolean) v);
        }
        otel.add("attr", attrs);
    }

    if (otel.size() == 0) return userMessage;
    return userMessage + "\n<!--otel:" + new Gson().toJson(otel) + "-->";
}
```

### Python 示例

```python
import json
from opentelemetry import trace

def build_message_with_otel(
    user_message: str,
    trace_context: bool = True,
    attributes: dict | None = None,
) -> str:
    otel = {}

    # 可选：trace context
    if trace_context:
        span = trace.get_current_span()
        ctx = span.get_span_context()
        if ctx.is_valid:
            otel["tp"] = f"00-{format(ctx.trace_id, '032x')}-{format(ctx.span_id, '016x')}-01"

    # 可选：自定义属性
    if attributes:
        # 仅保留 str/int/float/bool 类型的值
        otel["attr"] = {
            k: v for k, v in attributes.items()
            if isinstance(v, (str, int, float, bool))
        }

    if not otel:
        return user_message

    return f"{user_message}\n<!--otel:{json.dumps(otel, ensure_ascii=False)}-->"

# 使用示例
message = build_message_with_otel(
    "请帮我查询订单状态",
    attributes={
        "user.id": "U-12345",
        "biz.order_id": "ORD-9876",
        "env": "production",
    },
)
```

---

## 已知限制与注意事项

### 1. LLM 可见性

otel 标记会作为消息内容的一部分发送给 LLM，**无法在 LLM 调用前删除**。原因：openclaw 的 hook 系统对用户消息采用只读设计，`message_received` 是 fire-and-forget（`runVoidHook`），没有任何 hook 可以在 LLM 调用前修改用户消息内容。

**缓解措施**：
- HTML 注释格式被主流 LLM（GPT-4、Claude、Qwen）基本忽略
- 如果 B-service 的 openclaw 实例配有自定义 system prompt，可添加指令忽略 `<!--otel:...-->` 标记
- 插件会将 `cleanContent`（去除标记后的内容）写入 span 的 `gen_ai.input.messages` attribute，trace 数据本身不含标记

### 2. 仅适用于 WebSocket chat.send

此方案针对 WebSocket `chat.send` 的 `message` 字段。HTTP 场景（包括 OpenAI 兼容 API）的 trace context 透传通过 HTTP header `traceparent` 实现（已由 `trace-propagation.ts` 的 server emit patch 支持），自定义属性透传需要另行设计（可通过自定义 HTTP header 或 OpenAI API 的 `metadata` 字段）。

### 3. 一个连接多个 trace

WebSocket 是长连接，每条消息独立携带 otel 载荷，不同消息可以关联到不同的上游 trace 并携带不同的自定义属性。

### 4. 与 HTTP 入方向的优先级

如果同时存在 HTTP header `traceparent`（通过 `upgrade` 握手阶段注入）和 content 中嵌入的 traceparent，以 **content 中的为准**，因为它更贴近实际请求粒度。HTTP header 的 traceparent 在 WebSocket 长连接场景中只代表握手时刻的 trace，无法区分后续不同消息。

### 5. 自定义属性与 HTTP 场景

当前方案仅覆盖 WebSocket 场景的自定义属性透传。如果 HTTP 场景也需要自定义属性，可通过以下方式扩展（不在本方案范围内）：
- 自定义 HTTP header（如 `X-Otel-Attr-{key}: {value}`）
- 在 `patchHttpServer` 中提取并存入 propagation store
