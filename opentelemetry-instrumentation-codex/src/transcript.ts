import * as fs from "node:fs";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TranscriptData {
  model: string;
  modelProvider: string;
  tokenEvents: TokenUsage[];
  totalUsage: TokenUsage | null;
}

function parseTokenUsage(raw: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: Number(raw["input_tokens"] || 0),
    outputTokens: Number(raw["output_tokens"] || 0),
    cachedInputTokens: Number(raw["cached_input_tokens"] || 0),
    reasoningOutputTokens: Number(raw["reasoning_output_tokens"] || 0),
    totalTokens: Number(raw["total_tokens"] || 0),
  };
}

export function parseTranscript(transcriptPath: string): TranscriptData | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  let model = "unknown";
  let modelProvider = "openai";
  const tokenEvents: TokenUsage[] = [];
  let lastTotalUsage: TokenUsage | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = entry["type"] as string | undefined;
    const payload = entry["payload"] as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (entryType === "session_meta") {
      const mp = payload["model_provider"];
      if (typeof mp === "string" && mp) modelProvider = mp;
    } else if (entryType === "turn_context") {
      const m = payload["model"];
      if (typeof m === "string" && m) model = m;
    } else if (entryType === "event_msg") {
      const payloadType = payload["type"] as string | undefined;
      if (payloadType === "token_count") {
        const info = payload["info"] as Record<string, unknown> | null;
        if (!info) continue;

        const lastUsage = info["last_token_usage"] as Record<string, unknown> | undefined;
        if (lastUsage) {
          tokenEvents.push(parseTokenUsage(lastUsage));
        }

        const totalUsage = info["total_token_usage"] as Record<string, unknown> | undefined;
        if (totalUsage) {
          lastTotalUsage = parseTokenUsage(totalUsage);
        }
      }
    }
  }

  if (tokenEvents.length === 0 && !lastTotalUsage) return null;

  return { model, modelProvider, tokenEvents, totalUsage: lastTotalUsage };
}
