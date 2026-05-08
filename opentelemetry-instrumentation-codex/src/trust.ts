import * as crypto from "node:crypto";
import * as fs from "node:fs";

const EVENT_KEY_MAP: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  Stop: "stop",
};

// Recursive key-sorted JSON — replicates canonical_json() from
// codex-rs/config/src/fingerprint.rs
function canonicalJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// Replicates version_for_toml() from codex-rs/config/src/fingerprint.rs
function versionForToml(obj: unknown): string {
  const canonical = canonicalJson(obj);
  const serialized = JSON.stringify(canonical);
  const hex = crypto
    .createHash("sha256")
    .update(serialized, "utf-8")
    .digest("hex");
  return `sha256:${hex}`;
}

// Replicates command_hook_hash() from codex-rs/hooks/src/engine/discovery.rs
// NormalizedHookIdentity { event_name, #[flatten] group: MatcherGroup }
// MatcherGroup { matcher: Option<String>, hooks: Vec<HookHandlerConfig> }
// When matcher is None, TOML serialization omits the field entirely.
export function computeHookTrustHash(
  eventName: string,
  command: string,
): string {
  const eventKey = EVENT_KEY_MAP[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);

  const identity: Record<string, unknown> = {
    event_name: eventKey,
    // matcher: None → absent (TOML has no null, serde skips None)
    hooks: [
      {
        type: "command",
        command,
        timeout: 600,
        async: false,
        // status_message: None → absent
      },
    ],
  };

  return versionForToml(identity);
}

export function hookStateKey(
  hooksJsonAbsPath: string,
  eventName: string,
): string {
  const eventKey = EVENT_KEY_MAP[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
  return `${hooksJsonAbsPath}:${eventKey}:0:0`;
}

const TRUST_BEGIN = "# BEGIN otel-codex-hook trust";
const TRUST_END = "# END otel-codex-hook trust";

export function writeTrustedHashes(
  configPath: string,
  hooksJsonAbsPath: string,
  entryPath: string,
  hookEvents: readonly string[],
  eventToSubcommand: Record<string, string>,
): void {
  let content = "";
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, "utf-8");
  }

  // Remove existing trust block (idempotent re-install)
  const beginIdx = content.indexOf(TRUST_BEGIN);
  const endIdx = content.indexOf(TRUST_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    let cutEnd = endIdx + TRUST_END.length;
    while (cutEnd < content.length && content[cutEnd] === "\n") cutEnd++;
    content = content.slice(0, beginIdx) + content.slice(cutEnd);
  }

  // Build new trust block
  const lines: string[] = [TRUST_BEGIN];
  for (const event of hookEvents) {
    const sub = eventToSubcommand[event]!;
    const command = `bash ${entryPath} ${sub}`;
    const hash = computeHookTrustHash(event, command);
    const key = hookStateKey(hooksJsonAbsPath, event);
    lines.push(`[hooks.state."${key}"]`);
    lines.push(`trusted_hash = "${hash}"`);
    lines.push("");
  }
  lines.push(TRUST_END);

  const separator = content.endsWith("\n") || !content ? "" : "\n";
  content += separator + "\n" + lines.join("\n") + "\n";
  content = content.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, content, "utf-8");
}

export function removeTrustBlock(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  let content = fs.readFileSync(configPath, "utf-8");
  const beginIdx = content.indexOf(TRUST_BEGIN);
  const endIdx = content.indexOf(TRUST_END);
  if (beginIdx === -1 || endIdx === -1) return false;

  let cutEnd = endIdx + TRUST_END.length;
  while (cutEnd < content.length && content[cutEnd] === "\n") cutEnd++;
  content = content.slice(0, beginIdx) + content.slice(cutEnd);
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.writeFileSync(configPath, content, "utf-8");
  return true;
}
