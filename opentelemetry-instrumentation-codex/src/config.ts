import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function candidatePaths(): string[] {
  return [
    path.join(process.cwd(), "codex.config.json"),
    path.join(process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex"), "otel.config.json"),
  ];
}

export function loadOtelConfig(): string | null {
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw);
    } catch {
      process.stderr.write(`[otel-codex-hook] Failed to parse config: ${candidate}\n`);
      continue;
    }

    if (typeof config !== "object" || config === null) continue;

    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string") {
        process.env[key] = value;
      }
    }

    return candidate;
  }

  return null;
}
