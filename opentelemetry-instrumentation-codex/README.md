# opentelemetry-instrumentation-codex

OpenAI Codex CLI 的 OpenTelemetry 可观测插件 — 将 AI Agent 执行链路上报到任何兼容 OTLP 的后端。

无需修改 Codex 源码。插件通过 Codex 内置的 Hooks 机制工作：在会话过程中累积事件，会话结束时解析 transcript 文件获取 token 用量，最终导出符合 ARMS GenAI 语义规范的 OpenTelemetry 链路数据。

多轮会话中，每一轮产生独立的 trace（唯一 traceId），所有轮次共享同一个 `gen_ai.session.id`。

## Span 层级结构

遵循 [ARMS GenAI 语义规范](https://opentelemetry.io/docs/specs/semconv/gen-ai/)：

```
enter_ai_application_system (ENTRY)
└── invoke_agent codex (AGENT)          ← 汇总全部 token
    ├── react step (STEP, round=1)
    │   ├── chat <model> (LLM)          ← 每轮 LLM 调用均有 token 指标
    │   ├── execute_tool shell (TOOL)
    │   └── execute_tool apply_patch (TOOL)
    ├── react step (STEP, round=2)
    │   ├── chat <model> (LLM)
    │   └── execute_tool shell (TOOL)
    └── react step (STEP, round=3)
        └── chat <model> (LLM)          ← finish_reason=stop
```

### Span 属性覆盖

| Span 类型 | 关键属性 |
|---|---|
| LLM (`chat`) | `gen_ai.usage.input_tokens`, `output_tokens`, `total_tokens`, `cache_read.input_tokens`, `response.model`, `response.finish_reasons`, `conversation.id`, `provider.name`, `input/output.messages` |
| AGENT (`invoke_agent`) | `agent.name`, `request.model`, `response.model`, 汇总 `usage.*` token, `conversation.id`, `framework` |
| TOOL (`execute_tool`) | `tool.name`, `tool.call.id`, `tool.type`, `tool.call.arguments`, `tool.call.result` |
| STEP (`react`) | `react.round` |
| ENTRY (`enter`) | `session.id`, `conversation.id`, `input/output.messages` |

### Token 用量获取

Token 数据来源于 Codex 的 transcript JSONL 文件（`~/.codex/sessions/.../*.jsonl`）。Codex 在每次 LLM 调用后写入 `token_count` 事件，包含 `last_token_usage`（单次调用）和 `total_token_usage`（累计）。

插件在 Stop hook 时解析 transcript，按时序将 token 数据注入对应的 LLM span，并在 AGENT span 上汇总全轮次 token 总量。

---

## 快速开始

```bash
npm install -g @loongsuite/opentelemetry-instrumentation-codex
```

安装时自动将 hooks 注册到 `~/.codex/config.toml`。

验证安装：

```bash
otel-codex-hook check-env
```

---

## 配置

支持两种配置方式：**配置文件**（推荐）和 **环境变量**。配置文件优先级高于环境变量。

### 配置文件（推荐）

在以下路径创建 JSON 配置文件（按优先级查找）：

| 优先级 | 路径 | 作用域 |
|--------|------|--------|
| 1 | `./codex.config.json` | 项目级 |
| 2 | `~/.codex/otel.config.json` | 全局 |

示例 `codex.config.json`：

```json
{
  "OTEL_EXPORTER_OTLP_ENDPOINT": "https://your-otlp-endpoint/apm/trace/opentelemetry",
  "OTEL_EXPORTER_OTLP_HEADERS": "x-arms-license-key=xxx,x-arms-project=yyy,x-cms-workspace=zzz",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_RESOURCE_ATTRIBUTES": "service.name=my-codex-app",
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

### 环境变量

也可以直接设置环境变量：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-otlp-endpoint:4318"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=your-key"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_RESOURCE_ATTRIBUTES="service.name=my-codex-app"
```

调试模式（输出到控制台）：

```bash
export CODEX_TELEMETRY_DEBUG=1
```

### 服务名设置

服务名按以下优先级确定：

1. `OTEL_SERVICE_NAME` 环境变量
2. `OTEL_RESOURCE_ATTRIBUTES` 中的 `service.name`
3. 默认值 `codex-agent`

### 启用消息内容采集

默认情况下 `gen_ai.input.messages` 和 `gen_ai.output.messages` 不包含在 span 中。启用方式：

```json
{
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

> 注意：值必须是 `gen_ai_latest_experimental`，仅使用 `gen_ai` 不生效。

---

## 接入阿里云 ARMS

```json
{
  "OTEL_EXPORTER_OTLP_ENDPOINT": "https://proj-xxx.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry",
  "OTEL_EXPORTER_OTLP_HEADERS": "x-arms-license-key=xxx,x-arms-project=yyy,x-cms-workspace=zzz",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_RESOURCE_ATTRIBUTES": "service.name=my-app",
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

> 从 ARMS 控制台 → 接入中心 获取 `x-arms-license-key`、`x-arms-project` 和 `x-cms-workspace`。

> 协议必须使用 `http/protobuf`，JSON 格式的 trace 数据不会被 ARMS SLS 正确索引。

---

## CLI 命令

```bash
otel-codex-hook install             # 将 hooks 注册到 ~/.codex/config.toml
otel-codex-hook uninstall           # 从 config.toml 移除 hooks
otel-codex-hook uninstall --purge   # 同时删除缓存和会话数据
otel-codex-hook check-env           # 检查 OTLP 配置状态
otel-codex-hook show-config         # 打印 hook 配置（TOML/JSON 格式）
```

### Hook 事件

| 命令 | Hook 事件 | 说明 |
|------|-----------|------|
| `session-start` | SessionStart | 初始化会话状态 |
| `user-prompt-submit` | UserPromptSubmit | 记录用户输入 |
| `pre-tool-use` | PreToolUse | 记录工具调用开始 |
| `post-tool-use` | PostToolUse | 记录工具调用完成 |
| `stop` | Stop | 解析 transcript、生成并导出 trace |

---

## 手动配置 Hooks

如果自动安装未生效，手动添加到 `~/.codex/config.toml`：

```toml
# OpenTelemetry instrumentation hooks
[[hooks.SessionStart]]
hooks = [{ type = "command", command = "otel-codex-hook session-start" }]

[[hooks.UserPromptSubmit]]
hooks = [{ type = "command", command = "otel-codex-hook user-prompt-submit" }]

[[hooks.PreToolUse]]
hooks = [{ type = "command", command = "otel-codex-hook pre-tool-use" }]

[[hooks.PostToolUse]]
hooks = [{ type = "command", command = "otel-codex-hook post-tool-use" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "otel-codex-hook stop" }]
```

---

## 开发

```bash
pnpm install
pnpm run build      # 编译 TypeScript
pnpm run dev        # 监听模式
pnpm run typecheck  # 仅类型检查
```

要求 Node.js >= 18.0.0。

---

## 许可证

Apache-2.0 — 详见 [LICENSE](./LICENSE)。
