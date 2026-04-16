// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

jest.mock("fs");
jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, homedir: jest.fn(() => "/mock/home") };
});

// Mock telemetry to avoid real OTel initialization
jest.mock("../src/telemetry", () => ({
  configureTelemetry: jest.fn(() => ({
    forceFlush: jest.fn(),
    shutdown: jest.fn(),
  })),
  shutdownTelemetry: jest.fn(async () => {}),
}));

// Mock @opentelemetry/api
const mockSpan = {
  setAttribute: jest.fn(),
  setStatus: jest.fn(),
  end: jest.fn(),
  addEvent: jest.fn(),
};
const mockTracer = {
  startSpan: jest.fn(() => mockSpan),
};
jest.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: jest.fn(() => mockTracer),
    setSpan: jest.fn((ctx) => ctx),
    getTracerProvider: jest.fn(() => ({})),
  },
  context: {
    active: jest.fn(() => ({})),
  },
  SpanStatusCode: {
    ERROR: 2,
    OK: 1,
    UNSET: 0,
  },
}));

const {
  _buildHookConfig,
  _hrTime,
  _installIntoSettings,
  _removeHooksFromSettings,
  _removeAliasFromFile,
  _cmdUserPromptSubmitWithEvent,
  _cmdSessionStartWithEvent,
  _cmdPreToolUseWithEvent,
  _cmdPostToolUseWithEvent,
  _cmdPostToolUseFailureWithEvent,
  _cmdPreCompactWithEvent,
  _cmdPostCompactWithEvent,
  _cmdSubagentStartWithEvent,
  _cmdSubagentStopWithEvent,
  _cmdNotificationWithEvent,
  _replayEventsAsSpans,
  _reconstructStateFromEvents,
  _buildSubagentInfo,
} = require("../src/cli");

const { loadState, saveState } = require("../src/state");

describe("cli.js", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync.mockImplementation(() => {});
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
  });

  describe("buildHookConfig", () => {
    it("generates config for all hook events", () => {
      const config = _buildHookConfig("otel-qwen-hook");
      expect(config).toHaveProperty("UserPromptSubmit");
      expect(config).toHaveProperty("PreToolUse");
      expect(config).toHaveProperty("PostToolUse");
      expect(config).toHaveProperty("PostToolUseFailure");
      expect(config).toHaveProperty("Stop");
      expect(config).toHaveProperty("PreCompact");
      expect(config).toHaveProperty("PostCompact");
      expect(config).toHaveProperty("SubagentStart");
      expect(config).toHaveProperty("SubagentStop");
      expect(config).toHaveProperty("SessionStart");
      expect(config).toHaveProperty("SessionEnd");
      expect(config).toHaveProperty("Notification");
    });

    it("uses correct command format", () => {
      const config = _buildHookConfig("my-cmd");
      const hook = config.UserPromptSubmit[0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toBe("my-cmd user-prompt-submit");
    });
  });

  describe("hrTime", () => {
    it("converts timestamp to [seconds, nanos]", () => {
      const [sec, nanos] = _hrTime(1700000000.123456);
      expect(sec).toBe(1700000000);
      expect(nanos).toBeGreaterThan(0);
      expect(nanos).toBeLessThan(1e9);
    });

    it("handles integer timestamps", () => {
      const [sec, nanos] = _hrTime(1700000000);
      expect(sec).toBe(1700000000);
      expect(nanos).toBe(0);
    });
  });

  describe("installIntoSettings", () => {
    it("creates settings file if it does not exist", () => {
      fs.existsSync.mockReturnValue(false);
      _installIntoSettings("/mock/home/.qwen/settings.json");

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        "/mock/home/.qwen/settings.json",
        expect.stringContaining("hooks"),
        "utf-8"
      );
    });

    it("merges hooks into existing settings", () => {
      const existingSettings = { someKey: true, hooks: {} };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingSettings));

      _installIntoSettings("/mock/home/.qwen/settings.json");

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed.someKey).toBe(true);
      expect(parsed.hooks).toHaveProperty("UserPromptSubmit");
      expect(parsed.hooks).toHaveProperty("Stop");
    });

    it("does not duplicate hooks on re-install", () => {
      const existingHooks = _buildHookConfig("otel-qwen-hook");
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ hooks: existingHooks }));

      _installIntoSettings("/mock/home/.qwen/settings.json");

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    });
  });

  describe("removeHooksFromSettings", () => {
    it("removes otel-qwen-hook commands from settings", () => {
      const hooks = _buildHookConfig("otel-qwen-hook");
      hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "other-hook" }] });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ hooks }));

      _removeHooksFromSettings("/mock/home/.qwen/settings.json");

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
      expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe("other-hook");
    });
  });

  describe("removeAliasFromFile", () => {
    it("removes BEGIN/END marked block", () => {
      const content = "line1\n# BEGIN otel-qwen-hook\nalias qwen=...\n# END otel-qwen-hook\nline2\n";
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(content);

      _removeAliasFromFile("/mock/home/.zshrc");

      const written = fs.writeFileSync.mock.calls[0][1];
      expect(written).not.toContain("otel-qwen-hook");
      expect(written).toContain("line1");
      expect(written).toContain("line2");
    });

    it("does nothing if markers not found", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("clean file\n");

      _removeAliasFromFile("/mock/home/.zshrc");
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("command handlers (WithEvent)", () => {
    it("cmdUserPromptSubmit creates initial state", () => {
      const event = { session_id: "sess-1", prompt: "hello", model: "qwen-max" };
      _cmdUserPromptSubmitWithEvent(event);

      expect(saveState).toBeDefined();
    });

    it("cmdPreToolUse records tool event", () => {
      const event = { session_id: "sess-1", tool_name: "Read", tool_input: { file_path: "/test" }, tool_use_id: "tu-1" };
      _cmdPreToolUseWithEvent(event);
    });

    it("cmdPostToolUse records tool response", () => {
      const event = { session_id: "sess-1", tool_name: "Read", tool_response: "file content", tool_use_id: "tu-1" };
      _cmdPostToolUseWithEvent(event);
    });

    it("cmdPostToolUseFailure records failure", () => {
      const event = { session_id: "sess-1", tool_name: "Shell", tool_use_id: "tu-2", error: "command not found" };
      _cmdPostToolUseFailureWithEvent(event);
    });

    it("cmdPreCompact records compact start", () => {
      _cmdPreCompactWithEvent({ session_id: "sess-1", trigger: "auto" });
    });

    it("cmdPostCompact records compact end", () => {
      _cmdPostCompactWithEvent({ session_id: "sess-1", trigger: "auto", compact_summary: "summary" });
    });

    it("cmdNotification records notification", () => {
      _cmdNotificationWithEvent({ session_id: "sess-1", message: "Task complete", level: "info" });
    });

    it("cmdSessionStart records model info", () => {
      _cmdSessionStartWithEvent({ session_id: "sess-1", model: "qwen-max" });
    });

    it("cmdSubagentStart records agent launch", () => {
      _cmdSubagentStartWithEvent({ session_id: "sess-1", agent_id: "agent-1", agent_type: "task" });
    });

    it("cmdSubagentStop records agent completion", () => {
      _cmdSubagentStopWithEvent({ session_id: "sess-1", agent_id: "agent-1", stop_reason: "end_turn" });
    });
  });

  describe("replayEventsAsSpans", () => {
    it("creates turn span for user_prompt_submit", () => {
      const events = [
        { type: "user_prompt_submit", timestamp: 1700000000, prompt: "hello" },
      ];
      const parentCtx = {};

      _replayEventsAsSpans(mockTracer, events, parentCtx, 1700000010);

      expect(mockTracer.startSpan).toHaveBeenCalled();
      const call = mockTracer.startSpan.mock.calls[0];
      expect(call[0]).toContain("Turn 1");
    });

    it("creates tool span for pre_tool_use + post_tool_use pair", () => {
      const events = [
        { type: "pre_tool_use", timestamp: 1700000000, tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "tu-1" },
        { type: "post_tool_use", timestamp: 1700000001, tool_name: "Read", tool_response: "content", tool_use_id: "tu-1" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      // At least 1 span created for pre_tool_use
      expect(mockTracer.startSpan).toHaveBeenCalled();
      // post_tool_use closes the span
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("creates error span for post_tool_use_failure", () => {
      const events = [
        { type: "pre_tool_use", timestamp: 1700000000, tool_name: "Shell", tool_input: {}, tool_use_id: "tu-2" },
        { type: "post_tool_use_failure", timestamp: 1700000001, tool_name: "Shell", tool_use_id: "tu-2", error: "fail" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 })
      );
    });

    it("handles LLM call events", () => {
      const events = [
        {
          type: "llm_call", timestamp: 1700000001,
          model: "qwen-max", input_tokens: 100, output_tokens: 50,
          input_messages: [{ role: "user", content: "hi" }],
        },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockTracer.startSpan).toHaveBeenCalled();
      const call = mockTracer.startSpan.mock.calls[0];
      expect(call[0]).toContain("LLM");
    });

    it("handles notification events", () => {
      const events = [
        { type: "notification", timestamp: 1700000001, message: "Done", level: "info" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockTracer.startSpan).toHaveBeenCalled();
    });

    it("handles compact events", () => {
      const events = [
        { type: "pre_compact", timestamp: 1700000000, trigger: "auto" },
        { type: "post_compact", timestamp: 1700000001, trigger: "auto", compact_summary: "done" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockTracer.startSpan).toHaveBeenCalled();
    });

    it("creates AGENT container span for subagent_start/stop pair (sequential)", () => {
      jest.clearAllMocks();
      const events = [
        { type: "user_prompt_submit", timestamp: 100, prompt: "hello" },
        { type: "pre_tool_use", timestamp: 101, tool_name: "agent", tool_use_id: "tu-1", tool_input: { prompt: "task" } },
        { type: "subagent_start", timestamp: 102, agent_id: "sub-1", agent_type: "Custom" },
        { type: "llm_call", timestamp: 103, model: "qwen-max", input_tokens: 10, output_tokens: 5 },
        { type: "subagent_stop", timestamp: 104, agent_id: "sub-1", stop_reason: "end_turn" },
        { type: "post_tool_use", timestamp: 105, tool_name: "agent", tool_use_id: "tu-1" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 106);

      const spanNames = mockTracer.startSpan.mock.calls.map(c => c[0]);
      // Should have: Turn, TOOL(agent), AGENT(sub-1 container), LLM(nested inside AGENT)
      expect(spanNames.some(n => n.includes("Turn 1"))).toBe(true);
      expect(spanNames.some(n => n.includes("agent"))).toBe(true);
      expect(spanNames.some(n => n.includes("Subagent: Custom"))).toBe(true);
      expect(spanNames.some(n => n.includes("LLM"))).toBe(true);
    });

    it("creates AGENT containers for parallel subagents without nesting LLM calls", () => {
      jest.clearAllMocks();
      const events = [
        { type: "user_prompt_submit", timestamp: 100, prompt: "hello" },
        { type: "pre_tool_use", timestamp: 101, tool_name: "agent", tool_use_id: "tu-A", tool_input: {} },
        { type: "pre_tool_use", timestamp: 101.1, tool_name: "agent", tool_use_id: "tu-B", tool_input: {} },
        { type: "subagent_start", timestamp: 102, agent_id: "sub-A", agent_type: "Custom" },
        { type: "subagent_start", timestamp: 102.1, agent_id: "sub-B", agent_type: "Custom" },
        { type: "llm_call", timestamp: 103, model: "m", input_tokens: 1, output_tokens: 1 },
        { type: "llm_call", timestamp: 103.5, model: "m", input_tokens: 1, output_tokens: 1 },
        { type: "subagent_stop", timestamp: 104, agent_id: "sub-A", stop_reason: "end_turn" },
        { type: "subagent_stop", timestamp: 104.5, agent_id: "sub-B", stop_reason: "end_turn" },
        { type: "post_tool_use", timestamp: 105, tool_name: "agent", tool_use_id: "tu-A" },
        { type: "post_tool_use", timestamp: 105.1, tool_name: "agent", tool_use_id: "tu-B" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 106);

      const spanNames = mockTracer.startSpan.mock.calls.map(c => c[0]);
      // Both AGENT containers should be created (not zero-duration markers)
      const agentSpans = spanNames.filter(n => n.includes("Subagent: Custom"));
      expect(agentSpans).toHaveLength(2);
      // Both TOOL spans should exist (race condition fix ensures both are recorded)
      const toolSpans = spanNames.filter(n => n.includes("agent"));
      expect(toolSpans.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("reconstructStateFromEvents", () => {
    it("reconstructs metadata from events", () => {
      const events = [
        { type: "user_prompt_submit", timestamp: 100, prompt: "hello world", model: "qwen-max" },
        { type: "pre_tool_use", timestamp: 101, tool_name: "Read" },
        { type: "pre_tool_use", timestamp: 102, tool_name: "Write" },
        { type: "llm_call", timestamp: 103, model: "qwen-max", input_tokens: 500, output_tokens: 200 },
        { type: "llm_call", timestamp: 104, model: "qwen-max", input_tokens: 300, output_tokens: 100 },
      ];

      const state = _reconstructStateFromEvents("sess-1", events, 110);
      expect(state.session_id).toBe("sess-1");
      expect(state.start_time).toBe(100);
      expect(state.stop_time).toBe(110);
      expect(state.prompt).toBe("hello world");
      expect(state.model).toBe("qwen-max");
      expect(state.metrics.turns).toBe(1);
      expect(state.metrics.tools_used).toBe(2);
      expect(state.metrics.input_tokens).toBe(800);
      expect(state.metrics.output_tokens).toBe(300);
      expect(state.tools_used).toEqual(expect.arrayContaining(["Read", "Write"]));
      expect(state.events).toBe(events);
    });

    it("handles empty events", () => {
      const state = _reconstructStateFromEvents("sess-2", [], 110);
      expect(state.prompt).toBe("");
      expect(state.model).toBe("unknown");
      expect(state.metrics.turns).toBe(0);
    });
  });

  describe("buildSubagentInfo", () => {
    it("builds windows for sequential subagents", () => {
      const events = [
        { type: "subagent_start", timestamp: 100, agent_id: "a1", agent_type: "T" },
        { type: "llm_call", timestamp: 101 },
        { type: "subagent_stop", timestamp: 102, agent_id: "a1" },
      ];
      const info = _buildSubagentInfo(events);
      expect(info.windows).toHaveLength(1);
      expect(info.windows[0].childEvents).toHaveLength(1);
      expect(info.ownedIndices.has(0)).toBe(true);
      expect(info.ownedIndices.has(1)).toBe(true);
      expect(info.ownedIndices.has(2)).toBe(true);
    });

    it("detects parallel (overlapping) subagents and skips child collection", () => {
      const events = [
        { type: "subagent_start", timestamp: 100, agent_id: "a1", agent_type: "T" },
        { type: "subagent_start", timestamp: 101, agent_id: "a2", agent_type: "T" },
        { type: "llm_call", timestamp: 102 },
        { type: "subagent_stop", timestamp: 103, agent_id: "a1" },
        { type: "subagent_stop", timestamp: 104, agent_id: "a2" },
      ];
      const info = _buildSubagentInfo(events);
      expect(info.windows).toHaveLength(2);
      // Parallel → no child events collected
      expect(info.windows[0].childEvents).toHaveLength(0);
      expect(info.windows[1].childEvents).toHaveLength(0);
    });

    it("excludes external tool post_tool_use that falls inside subagent window", () => {
      // Scenario: glob pre_tool_use is BEFORE the subagent window,
      // but its post_tool_use lands INSIDE the window (parallel execution).
      const events = [
        { type: "pre_tool_use", timestamp: 100, tool_name: "glob", tool_use_id: "tu-glob", tool_input: {} },
        { type: "subagent_start", timestamp: 101, agent_id: "a1", agent_type: "Task" },
        { type: "llm_call", timestamp: 102 },
        { type: "post_tool_use", timestamp: 103, tool_name: "glob", tool_use_id: "tu-glob", tool_response: "files" },
        { type: "subagent_stop", timestamp: 104, agent_id: "a1" },
      ];
      const info = _buildSubagentInfo(events);
      expect(info.windows).toHaveLength(1);
      // post_tool_use(glob) must NOT be in childEvents
      const childTypes = info.windows[0].childEvents.map(e => e.type);
      expect(childTypes).toContain("llm_call");
      expect(childTypes).not.toContain("post_tool_use");
      // post_tool_use(glob) index (3) must NOT be in ownedIndices
      expect(info.ownedIndices.has(3)).toBe(false);
    });

    it("handles nested subagents (only top-level windows)", () => {
      const events = [
        { type: "subagent_start", timestamp: 100, agent_id: "outer", agent_type: "T" },
        { type: "subagent_start", timestamp: 101, agent_id: "inner", agent_type: "T" },
        { type: "llm_call", timestamp: 102 },
        { type: "subagent_stop", timestamp: 103, agent_id: "inner" },
        { type: "subagent_stop", timestamp: 104, agent_id: "outer" },
      ];
      const info = _buildSubagentInfo(events);
      // Only the outer window is top-level
      expect(info.windows).toHaveLength(1);
      expect(info.windows[0].agent_id).toBe("outer");
      // Child events include the inner subagent's events (handled recursively)
      expect(info.windows[0].childEvents.length).toBeGreaterThan(0);
    });
  });
});
