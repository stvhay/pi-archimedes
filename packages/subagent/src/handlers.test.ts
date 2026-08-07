import { describe, it, expect } from "vitest";
import {
  extractArgsPreview,
  handleAgentEnd,
  handleMessageEnd,
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
    partialUsage: readUsage(undefined),
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    model: undefined,
    accumulatedOutput: [],
    streamingOutput: undefined,
    recentOutput: [],
    toolCalls: [],
    finalOutput: undefined,
  };
}

describe("assistant event handling", () => {
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
