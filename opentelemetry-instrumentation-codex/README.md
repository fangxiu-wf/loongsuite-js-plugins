# opentelemetry-instrumentation-codex

OpenAI Codex CLI plugin — report AI Agent execution traces to any OTLP-compatible backend via OpenTelemetry.

No modification to Codex source code is required. The instrumentation works through Codex's built-in hooks system, accumulating events during a session and exporting ARMS-compliant OpenTelemetry spans on session end.

Each turn in a multi-turn session produces an independent trace (unique traceId), while all turns share the same `gen_ai.session.id`.

## Span Hierarchy

Spans follow the [ARMS GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

```
enter_ai_application_system (ENTRY)
└── invoke_agent codex (AGENT)
    ├── react step (STEP, round=1)
    │   ├── chat <model> (LLM)
    │   ├── execute_tool shell (TOOL)
    │   └── execute_tool apply_patch (TOOL)
    ├── react step (STEP, round=2)
    │   ├── chat <model> (LLM)
    │   └── execute_tool shell (TOOL)
    └── react step (STEP, round=3)
        └── chat <model> (LLM)
```

| Span | gen_ai.span.kind | gen_ai.operation.name | Description |
|------|------------------|-----------------------|-------------|
| `enter_ai_application_system` | ENTRY | enter | Per-turn request entry point |
| `invoke_agent codex` | AGENT | invoke_agent | Agent invocation |
| `react step` | STEP | react | One Reasoning-Acting iteration |
| `chat <model>` | LLM | chat | Model inference (inferred from event gaps) |
| `execute_tool shell` | TOOL | execute_tool | Shell command execution |
| `execute_tool apply_patch` | TOOL | execute_tool | File change (apply patch) |

---

## Quick Start

```bash
npm install -g @loongsuite/opentelemetry-instrumentation-codex
```

Hooks are auto-registered to `~/.codex/config.toml` on install.

---

## Configuration

The plugin supports two configuration methods: **config file** (recommended) and **environment variables**. Config file values take priority over environment variables.

### Config File (Recommended)

Create a JSON config file at one of the following locations (searched in order, config file values override environment variables):

| Priority | Path | Scope |
|----------|------|-------|
| 1 | `./codex.config.json` | Project-level |
| 2 | `~/.codex/otel.config.json` | Global |

Example `codex.config.json`:

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

### Environment Variables

Alternatively, set environment variables directly:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-otlp-endpoint:4318"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=your-key"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Or for debug output to console:

```bash
export CODEX_TELEMETRY_DEBUG=1
```

### Enable Message Content Capture

By default, `gen_ai.input.messages` and `gen_ai.output.messages` are not included in spans. To enable, add these to your config file or set them as env vars:

```json
{
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

> Note: the value must be `gen_ai_latest_experimental` — `gen_ai` alone does not work.

### Verify

```bash
otel-codex-hook check-env
```

---

## Backend: Alibaba Cloud ARMS

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

> Obtain `x-arms-license-key`, `x-arms-project`, and `x-cms-workspace` from the ARMS console → Integration Center.

---

## Manual Hook Configuration

If auto-install didn't work, add the following to `~/.codex/config.toml`:

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

Or print the config:

```bash
otel-codex-hook show-config
```

---

## Uninstall

```bash
otel-codex-hook uninstall          # Remove hooks from config.toml
otel-codex-hook uninstall --purge  # Also delete cache/session data
```

---

## Development

```bash
pnpm install
pnpm run build      # Compile TypeScript
pnpm run dev        # Watch mode
pnpm run typecheck  # Type check only
```

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
