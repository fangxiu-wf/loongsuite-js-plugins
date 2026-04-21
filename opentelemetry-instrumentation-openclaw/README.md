# opentelemetry-instrumentation-openclaw

OpenClaw plugin — report AI Agent execution traces to any OTLP-compatible backend via OpenTelemetry.

Spans follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

| Span | gen_ai.span.kind | Description |
|------|-----------------|-------------|
| `enter_ai_application_system` | ENTRY | Request entry point |
| `invoke_agent` | AGENT | Agent invocation |
| `chat` | LLM | LLM call |
| `execute_tool` | TOOL | Tool execution |
| `session_start` / `session_end` | — | Session lifecycle |
| `gateway_start` / `gateway_stop` | — | Gateway lifecycle |

---

## Installation

The install script sets up two components:

1. **opentelemetry-instrumentation-openclaw** — Downloads, extracts, installs dependencies, and writes plugin config (Trace reporting)
2. **diagnostics-otel** — Locates the built-in OpenClaw extension and enables Metrics collection

```bash
curl -fsSL https://<your-plugin-host>/install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --serviceName "my-openclaw-agent"
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--endpoint` | Yes | OTLP endpoint URL |
| `--serviceName` | Yes | Service name for traces |
| `--plugin-url` | No | Custom tarball download URL |
| `--install-dir` | No | Override install directory |
| `--disable-metrics` | No | Skip diagnostics-otel metrics setup |

### Backend-specific auth headers

If your OTLP backend requires authentication headers, pass them to the plugin config after installation. Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "opentelemetry-instrumentation-openclaw": {
        "enabled": true,
        "config": {
          "endpoint": "https://your-otlp-endpoint:4318",
          "headers": {
            "x-api-key": "your-api-key"
          },
          "serviceName": "my-openclaw-agent"
        }
      }
    }
  }
}
```

> **Alibaba Cloud ARMS users**: The headers `x-arms-license-key`, `x-arms-project`, and `x-cms-workspace` are ARMS-specific authentication fields. Obtain these from the ARMS console → Integration Center.

### Prerequisites

- Node.js >= 18
- npm
- OpenClaw CLI (optional, used for auto-restarting the gateway)

---

## Uninstall

```bash
curl -fsSL https://<your-plugin-host>/uninstall.sh | bash
```

| Parameter | Description |
|-----------|-------------|
| `-y` / `--yes` | Skip confirmation prompt |
| `--install-dir` | Specify plugin install directory |
| `--keep-metrics` | Keep diagnostics-otel metrics config |

---

## Manual Configuration

If you prefer to configure manually, edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["opentelemetry-instrumentation-openclaw", "diagnostics-otel"],
    "load": { "paths": ["/path/to/opentelemetry-instrumentation-openclaw"] },
    "entries": {
      "opentelemetry-instrumentation-openclaw": {
        "enabled": true,
        "config": {
          "endpoint": "https://your-otlp-endpoint:4318",
          "headers": {
            "x-api-key": "your-backend-api-key"
          },
          "serviceName": "my-openclaw-agent",
          "debug": false,
          "batchSize": 10,
          "flushIntervalMs": 5000
        }
      },
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://your-otlp-endpoint:4318",
      "protocol": "http/protobuf",
      "headers": { "x-api-key": "your-backend-api-key" },
      "serviceName": "my-openclaw-agent",
      "traces": false,
      "metrics": true,
      "logs": false
    }
  }
}
```

> **Note**: Set `diagnostics.otel.traces: false` to avoid duplicate traces — `opentelemetry-instrumentation-openclaw` already handles trace reporting.

> **Migration compatibility**: Existing `openclaw-cms-plugin` users can upgrade in place. The installer migrates old config entries to the new plugin ID automatically.

---

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm test         # Run tests (Vitest)
```

---

## Maintainer Release Pipeline

This repo includes a manual GitHub Actions workflow:
- `.github/workflows/release-openclaw-plugin.yml`

Trigger it from **Actions → Release OpenClaw Plugin → Run workflow** and provide:
- `version` (must match `package.json`, e.g. `0.1.2`)
- `oss_path_prefix` (e.g. `opentelemetry-instrumentation-openclaw`)
- `create_latest_alias` (`true` uploads an additional `/latest` path)
- `dry_run` (`true` skips OSS upload + GitHub Release)

Required repository secrets:
- `OSS_BUCKET`
- `OSS_ENDPOINT`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`

Workflow outputs:
- builds and packs `opentelemetry-instrumentation-openclaw.tar.gz`
- uploads tarball + `install.sh` + `install-wget.sh` + `uninstall.sh` + `SHA256SUMS` to OSS
- creates tag `opentelemetry-instrumentation-openclaw/v<version>`
- creates a GitHub Release with uploaded assets

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
