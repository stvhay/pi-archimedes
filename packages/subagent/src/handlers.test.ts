import { describe, it, expect } from "vitest";
import {
  extractArgsPreview,
  handleAgentEnd,
  handleMessageEnd,
  handleMessageStart,
  handleMessageUpdate,
} from "./handlers.js";
import { readUsage } from "./usage.js";
import type { StreamState } from "./types.js";

// ── extractArgsPreview ──────────────────────────────────────────────────────

describe("extractArgsPreview", () => {
  it("returns string args truncated", () => {
    const long = "a".repeat(200);
    expect(extractArgsPreview(long)).toBe("a".repeat(120));
  });

  it("replaces newlines in string args", () => {
    expect(extractArgsPreview("hello\nworld")).toBe("hello world");
  });

  it("replaces newlines in single-key object value", () => {
    const args = { command: "cat file.txt\ngrep -A5 \"test\"" };
    const result = extractArgsPreview(args);
    expect(result).not.toContain("\n");
    expect(result).toBe("cat file.txt grep -A5 \"test\"");
  });

  it("replaces newlines in multi-key longest string value", () => {
    const args = { short: "x", long: "hello\nworld\nfoo" };
    expect(extractArgsPreview(args)).toBe("hello world foo");
  });

  it("handles number and boolean values", () => {
    expect(extractArgsPreview({ count: 42 })).toBe("42");
    expect(extractArgsPreview({ enabled: true })).toBe("true");
  });
});

function streamState(): StreamState {
  return {
    toolCount: 0,
    turnCount: 0,
    usage: readUsage(undefined),
    turnUsage: readUsage(undefined),
    partialUsage: readUsage(undefined),
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    provider: undefined,
    model: undefined,
    accumulatedOutput: [],
    streamingOutput: undefined,
    streamingParts: new Map(),
    outputLimit: undefined,
    recentOutput: [],
    toolCalls: [],
    finalOutput: undefined,
  };
}

describe("assistant event handling", () => {
  it("assembles Pi 0.84 text and thinking deltas by content index", () => {
    const state = streamState();

    for (const assistantMessageEvent of [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "check " },
      { type: "thinking_delta", contentIndex: 0, delta: "facts" },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: "final " },
      { type: "text_end", contentIndex: 1, content: "final answer" },
    ]) {
      handleMessageUpdate(state, {
        type: "message_update",
        assistantMessageEvent,
      } as Parameters<typeof handleMessageUpdate>[1]);
    }

    expect(state.streamingOutput).toBe("[thinking] check facts\n\nfinal answer");
    expect(state.partialUsage.totalTokens).toBe(0);
  });

  it("bounds Pi 0.84 live delta reconstruction", () => {
    const state = streamState();

    for (let index = 0; index < 12_000; index++) {
      handleMessageUpdate(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      } as Parameters<typeof handleMessageUpdate>[1]);
    }
    const changed = handleMessageUpdate(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ignored" },
    } as Parameters<typeof handleMessageUpdate>[1]);

    expect(changed).toBe(false);
    expect(state.streamingOutput).toHaveLength(12_000);
    expect(state.streamingParts.get(0)?.content).toHaveLength(12_000);
  });

  it("captures provider and model from a Pi 0.84 assistant message start", () => {
    const state = streamState();

    handleMessageStart(state, {
      type: "message_start",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "test-provider",
        model: "live-model",
        content: [],
        usage: readUsage(undefined),
        stopReason: "stop",
        timestamp: 1,
      },
    } as Parameters<typeof handleMessageStart>[1]);

    expect(state.provider).toBe("test-provider");
    expect(state.model).toBe("live-model");
  });

  it("does not expose an empty thinking block before its first delta", () => {
    const state = streamState();

    handleMessageUpdate(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as Parameters<typeof handleMessageUpdate>[1]);

    expect(state.streamingOutput).toBeUndefined();
  });

  it("replaces Pi 0.84 deltas with authoritative finalized output and usage", () => {
    const state = streamState();
    handleMessageUpdate(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    } as Parameters<typeof handleMessageUpdate>[1]);

    handleMessageEnd(state, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        usage: readUsage({ input: 4, output: 2, cacheRead: 1, cacheWrite: 0 }),
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1]);

    expect(state.streamingOutput).toBeUndefined();
    expect(state.streamingParts.size).toBe(0);
    expect(state.accumulatedOutput).toEqual(["final"]);
    expect(state.usage.totalTokens).toBe(7);
  });

  it("ignores malformed final assistant parts from the child event stream", () => {
    const state = streamState();
    const event = {
      type: "agent_end",
      messages: [null, {
        role: "assistant",
        content: [
          null,
          { type: "text", text: 42 },
          { type: "text", text: "final answer" },
        ],
      }],
    } as unknown as Parameters<typeof handleAgentEnd>[1];

    handleAgentEnd(state, event);

    expect(state.finalOutput).toBe("final answer");
  });

  it("rejects a completed assistant event containing malformed parts", () => {
    const state = streamState();
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          null,
          { type: "text", text: 42 },
          { type: "text", text: "completed answer" },
        ],
        usage: readUsage(undefined),
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1];

    handleMessageEnd(state, event);

    expect(state.accumulatedOutput).toEqual([]);
  });

  it("preserves in-flight state for a malformed assistant update", () => {
    const state = streamState();
    state.streamingOutput = "partial answer";
    state.partialUsage = readUsage({ input: 4, output: 2, cacheRead: 0, cacheWrite: 0 });
    const event = {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: 42 }],
        usage: readUsage(undefined),
      },
    } as unknown as Parameters<typeof handleMessageUpdate>[1];

    handleMessageUpdate(state, event);

    expect(state.streamingOutput).toBe("partial answer");
    expect(state.partialUsage.totalTokens).toBe(6);
  });

  it("ignores a malformed completed assistant message", () => {
    const state = streamState();
    const event = {
      type: "message_end",
      message: null,
    } as unknown as Parameters<typeof handleMessageEnd>[1];

    handleMessageEnd(state, event);

    expect(state.accumulatedOutput).toEqual([]);
  });

  it("preserves in-flight state for malformed completed assistant content", () => {
    const state = streamState();
    state.streamingOutput = "partial answer";
    state.partialUsage = readUsage({ input: 4, output: 2, cacheRead: 0, cacheWrite: 0 });
    const event = {
      type: "message_end",
      message: { role: "assistant", content: null, usage: null },
    } as unknown as Parameters<typeof handleMessageEnd>[1];

    handleMessageEnd(state, event);

    expect(state.streamingOutput).toBe("partial answer");
    expect(state.partialUsage.totalTokens).toBe(6);
  });

  it("preserves in-flight state for malformed completed assistant usage", () => {
    const state = streamState();
    state.streamingOutput = "partial answer";
    state.partialUsage = readUsage({ input: 4, output: 2, cacheRead: 0, cacheWrite: 0 });
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "completed answer" }],
        usage: { ...readUsage(undefined), input: "bad" },
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1];

    handleMessageEnd(state, event);

    expect(state.streamingOutput).toBe("partial answer");
    expect(state.partialUsage.totalTokens).toBe(6);
  });

  it("ignores a malformed final message collection", () => {
    const state = streamState();
    const event = {
      type: "agent_end",
      messages: null,
    } as unknown as Parameters<typeof handleAgentEnd>[1];

    handleAgentEnd(state, event);

    expect(state.finalOutput).toBeUndefined();
  });
});
