import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { encodeLimitStop } from "./limits.js";
import { streamEvents } from "./stream.js";

type FakeChild = ChildProcess & { stdout: PassThrough; stderr: PassThrough };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return child;
}

function assistantEvent(type: "message_update" | "message_end", text: string, input: number, output: number) {
  return {
    type,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "test-provider",
      model: "test-model",
      content: [{ type: "text", text }],
      usage: {
        input,
        output,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: input + output + 1,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
  };
}

function assistantDelta(type: string, contentIndex: number, value?: string) {
  return {
    type: "message_update",
    assistantMessageEvent: {
      type,
      contentIndex,
      ...(type.endsWith("_delta") ? { delta: value } : {}),
      ...(type.endsWith("_end") ? { content: value } : {}),
    },
  };
}

function writeEvent(child: FakeChild, event: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

function toolStart(
  child: FakeChild,
  id: unknown,
  args: unknown = { path: "/missing" },
  toolName = "read",
): void {
  writeEvent(child, { type: "tool_execution_start", toolCallId: id, toolName, args });
}

function toolEnd(
  child: FakeChild,
  id: unknown,
  toolName = "read",
  isError: unknown = true,
  result: unknown = { content: [{ type: "text", text: "ENOENT: file not found" }] },
): void {
  writeEvent(child, { type: "tool_execution_end", toolCallId: id, toolName, result, isError });
}

function toolResult(
  child: FakeChild,
  id: string,
  path: string,
  isError = true,
  text = "ENOENT: file not found",
  args: Record<string, unknown> = { path },
): void {
  toolStart(child, id, args);
  toolEnd(child, id, "read", isError, { content: [{ type: "text", text }] });
}

describe("streamEvents bounded termination", () => {
  it("preserves in-flight output and usage when a child limit marker arrives", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stderr.write(`${encodeLimitStop({
      reason: "time-limit",
      limit: 1000,
      observed: 1001,
      usageState: "partial",
    })}\n`);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write(`${JSON.stringify(assistantEvent("message_update", "partial answer", 2, 1))}\n`);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);

    const result = await pending;
    expect(child.kill).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
    expect(result.finalOutput).toBe("partial answer");
    expect(result.usage).toMatchObject({ input: 2, output: 1, cacheRead: 1, cacheWrite: 0 });
    expect(result.termination).toEqual({
      reason: "time-limit",
      limit: 1000,
      observed: 1001,
      usageState: "partial",
    });
    expect(result.error).toBe("Subagent stopped: time-limit");
  });

  it("preserves Pi 0.84 delta output without inventing partial usage", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    writeEvent(child, { type: "turn_start" });
    writeEvent(child, assistantEvent("message_end", "first", 4, 2));
    writeEvent(child, { type: "turn_start" });
    writeEvent(child, {
      type: "message_start",
      message: { role: "assistant", provider: "test-provider", model: "live-model", content: [] },
    });
    writeEvent(child, assistantDelta("thinking_start", 0));
    writeEvent(child, assistantDelta("thinking_delta", 0, "checking"));
    writeEvent(child, assistantDelta("text_start", 1));
    writeEvent(child, assistantDelta("text_delta", 1, "second partial"));
    child.emit("close", 1, null);

    const result = await pending;
    expect(result.finalOutput).toBe("first\n\n[thinking] checking\n\nsecond partial");
    expect(result.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, cacheWrite: 0 });
    expect(result.progress).toMatchObject({ turnCount: 2, turnTokens: 0, tokens: 7, model: "test-model" });
    expect(result.termination).toMatchObject({ reason: "process-error", usageState: "partial" });
  });

  it("replaces Pi 0.84 deltas with finalized output and usage once", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    writeEvent(child, { type: "turn_start" });
    writeEvent(child, { type: "message_start", message: { role: "assistant", content: [] } });
    writeEvent(child, assistantDelta("text_delta", 0, "partial"));
    writeEvent(child, assistantEvent("message_end", "final", 4, 2));
    child.emit("close", 0, null);

    const result = await pending;
    expect(result.finalOutput).toBe("final");
    expect(result.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, cacheWrite: 0 });
    expect(result.progress).toMatchObject({ turnCount: 1, turnTokens: 7, tokens: 7 });
  });

  it("combines finalized output with the latest in-flight message without double counting", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stdout.write(`${JSON.stringify(assistantEvent("message_end", "first", 4, 2))}\n`);
    child.stdout.write(`${JSON.stringify(assistantEvent("message_update", "second partial", 3, 1))}\n`);
    child.emit("close", 1, null);

    const result = await pending;
    expect(result.finalOutput).toBe("first\n\nsecond partial");
    expect(result.usage).toMatchObject({ input: 7, output: 3, cacheRead: 2, cacheWrite: 0 });
    expect(result.termination).toMatchObject({ reason: "process-error", usageState: "partial" });
  });

  it("replaces in-flight usage with finalized usage in the same turn", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
    child.stdout.write(`${JSON.stringify(assistantEvent("message_update", "partial", 2, 1))}\n`);
    child.stdout.write(`${JSON.stringify(assistantEvent("message_end", "final", 4, 2))}\n`);
    child.emit("close", 0, null);

    const result = await pending;
    expect(result.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, cacheWrite: 0 });
    expect(result.progress).toMatchObject({ turnCount: 1, turnTokens: 7, tokens: 7 });
  });

  it("reports current-turn and cumulative tokens across provider turns", async () => {
    const child = fakeChild();
    const updates: Array<{ turnCount?: number; turnTokens?: number; tokens: number }> = [];
    const pending = streamEvents(child, {
      onProgress: (progress) => updates.push(progress),
    });

    child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
    child.stdout.write(`${JSON.stringify(assistantEvent("message_end", "first", 4, 2))}\n`);
    child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
    child.stdout.write(`${JSON.stringify(assistantEvent("message_update", "second partial", 3, 1))}\n`);
    child.emit("close", 1, null);

    const result = await pending;
    expect(result.progress).toMatchObject({ turnCount: 2, turnTokens: 5, tokens: 12 });
    expect(updates).toContainEqual(expect.objectContaining({
      turnCount: 2,
      turnTokens: 5,
      tokens: 12,
    }));
    expect(result.usage).toMatchObject({ input: 7, output: 3, cacheRead: 2, cacheWrite: 0 });
  });

  it("stops after three identical failed tool results and preserves prior state", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const pending = streamEvents(child);

      child.stdout.write(`${JSON.stringify(assistantEvent("message_end", "partial answer", 4, 2))}\n`);
      toolResult(child, "call-1", "/missing");
      toolResult(child, "call-2", "/missing");
      toolResult(child, "call-3", "/missing");
      vi.advanceTimersByTime(250);

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");

      const result = await pending;
      expect(result.exitCode).toBe(2);
      expect(result.finalOutput).toBe("partial answer");
      expect(result.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, cacheWrite: 0 });
      expect(result.termination).toEqual({
        reason: "repeated-error",
        limit: 3,
        observed: 3,
        usageState: "partial",
      });
      expect(result.error).toBe("Subagent stopped: repeated-error");
      expect(result.termination).not.toHaveProperty("fingerprint");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new sequence when failed tool input or result changes", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing-a");
    toolResult(child, "call-2", "/missing-a");
    toolResult(child, "call-3", "/missing-a", true, "EACCES: permission denied");
    toolResult(child, "call-4", "/missing-b");
    toolResult(child, "call-5", "/missing-a");
    toolResult(child, "call-6", "/missing-a");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("treats reordered object keys as the same failed input", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing", true, "ENOENT", {
      path: "/missing",
      encoding: "utf8",
    });
    toolResult(child, "call-2", "/missing", true, "ENOENT", {
      encoding: "utf8",
      path: "/missing",
    });
    toolResult(child, "call-3", "/missing", true, "ENOENT", {
      path: "/missing",
      encoding: "utf8",
    });
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    expect((await pending).termination?.reason).toBe("repeated-error");
  });

  it("does not group failed results whose start arguments are unavailable", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);
    const result = { content: [{ type: "text", text: "ENOENT" }] };
    toolEnd(child, "call-1", "read", true, result);
    toolEnd(child, "call-2", "read", true, result);
    toolEnd(child, "call-3", "read", true, result);
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("does not group malformed start/end pairs without call IDs", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    for (let i = 0; i < 3; i++) {
      toolStart(child, undefined);
      toolEnd(child, undefined, "read", true, { content: [{ type: "text", text: "ENOENT" }] });
    }
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("ignores orphan and malformed end events without resetting a valid streak", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolEnd(child, "orphan", "read", true, { content: [{ type: "text", text: "ENOENT" }] });
    toolStart(child, "malformed");
    toolEnd(child, "malformed", "read", "true");
    toolResult(child, "call-3", "/missing");
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    expect((await pending).termination?.reason).toBe("repeated-error");
  });

  it("ignores ambiguous duplicate tool-call IDs", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing-b");
    toolStart(child, "duplicate", { path: "/missing-a" });
    toolStart(child, "duplicate", { path: "/missing-b" });
    toolEnd(child, "duplicate");
    toolResult(child, "call-3", "/missing-b");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("ignores a mismatched end tool name without consuming its start", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const pending = streamEvents(child);

      toolResult(child, "call-1", "/missing");
      toolResult(child, "call-2", "/missing");
      toolStart(child, "call-3");
      toolEnd(child, "call-3", "write");
      vi.advanceTimersByTime(250);
      expect(child.kill).not.toHaveBeenCalled();

      toolEnd(child, "call-3");
      vi.advanceTimersByTime(250);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("exit", 1, null);
      child.emit("close", 1, null);

      expect((await pending).termination?.reason).toBe("repeated-error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count sequential reuse of a completed tool-call ID", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "reused", "/missing");
    toolResult(child, "reused", "/missing");
    toolResult(child, "reused", "/missing");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("marks a valid pending ID ambiguous when a malformed duplicate start arrives", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolStart(child, "call-3");
    writeEvent(child, { type: "tool_execution_start", toolCallId: "call-3", toolName: "read" });
    toolEnd(child, "call-3");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("ignores failures whose fingerprint input exceeds the depth limit", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = { value: deep };

    toolResult(child, "call-1", "/missing", true, "ENOENT", { path: "/missing", deep });
    toolResult(child, "call-2", "/missing", true, "ENOENT", { path: "/missing", deep });
    toolResult(child, "call-3", "/missing", true, "ENOENT", { path: "/missing", deep });
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("breaks an active streak on unhashable arguments or result data", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = { value: deep };

    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolResult(child, "call-3", "/missing", true, "ENOENT", { path: "/missing", deep });
    toolResult(child, "call-4", "/missing");
    toolResult(child, "call-5", "/missing");
    toolStart(child, "call-6");
    toolEnd(child, "call-6", "read", true, deep);
    toolResult(child, "call-7", "/missing");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("ignores failures whose fingerprint input exceeds the node limit", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);
    const wide = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`key-${index}`, index]),
    );

    toolResult(child, "call-1", "/missing", true, "ENOENT", wide);
    toolResult(child, "call-2", "/missing", true, "ENOENT", wide);
    toolResult(child, "call-3", "/missing", true, "ENOENT", wide);
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("breaks an active streak when arguments exceed the character budget", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolResult(child, "call-3", "/missing", true, "ENOENT", {
      path: "/missing",
      oversized: "X".repeat(256_001),
    });
    toolResult(child, "call-4", "/missing");
    toolResult(child, "call-5", "/missing");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("breaks an active streak when JSON escaping exceeds the serialized budget", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolResult(child, "call-3", "/missing", true, "ENOENT", {
      path: "/missing",
      escaped: "\0".repeat(50_000),
    });
    toolResult(child, "call-4", "/missing");
    toolResult(child, "call-5", "/missing");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("disables correlation after a malformed unique-ID flood", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    for (let i = 0; i <= 1000; i++) {
      writeEvent(child, {
        type: "tool_execution_start",
        toolCallId: `flood-${i}`,
        toolName: "read",
      });
    }
    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolResult(child, "call-3", "/missing");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("resets the sequence after a successful tool result", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    toolResult(child, "call-1", "/missing");
    toolResult(child, "call-2", "/missing");
    toolResult(child, "call-3", "/recovered", false, "contents");
    toolResult(child, "call-4", "/missing");
    toolResult(child, "call-5", "/missing");
    child.emit("close", 0, null);

    expect((await pending).termination).toEqual({ reason: "completed", usageState: "complete" });
  });

  it("does not stop a sibling when one child repeats an error", async () => {
    const failedChild = fakeChild();
    const sibling = fakeChild();
    const failed = streamEvents(failedChild);
    const completed = streamEvents(sibling);

    toolResult(failedChild, "call-1", "/missing");
    toolResult(failedChild, "call-2", "/missing");
    toolResult(failedChild, "call-3", "/missing");
    failedChild.emit("exit", 1, null);
    failedChild.emit("close", 1, null);

    sibling.stdout.write(`${JSON.stringify(assistantEvent("message_end", "sibling complete", 2, 1))}\n`);
    sibling.emit("close", 0, null);

    expect((await failed).termination?.reason).toBe("repeated-error");
    expect(await completed).toMatchObject({
      exitCode: 0,
      finalOutput: "sibling complete",
      termination: { reason: "completed", usageState: "complete" },
    });
  });

  it("keeps ordinary stderr as the process error", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stderr.write("provider failed\n");
    child.emit("close", 1, null);

    const result = await pending;
    expect(result.error).toBe("provider failed");
    expect(result.termination).toMatchObject({ reason: "process-error" });
  });

  it("reports assistant provider errors when Pi JSON mode exits zero", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);
    const event = assistantEvent("message_end", "", 0, 0);
    event.message.stopReason = "error";
    Object.assign(event.message, { content: [], errorMessage: "Provider rejected request" });

    writeEvent(child, event);
    child.emit("close", 0, null);

    const result = await pending;
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("Provider rejected request");
    expect(result.finalOutput).toBeUndefined();
    expect(result.termination).toEqual({ reason: "process-error", usageState: "unknown" });
  });
});

async function finishWith(events: Array<Record<string, unknown>>) {
  const child = fakeChild();
  const result = streamEvents(child);
  for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
  child.emit("close", 0, null);
  return result;
}

describe("streamEvents native v2 session identity", () => {
  it("returns the logical child Pi session ID", async () => {
    const result = await finishWith([{
      type: "session",
      id: "00000000-0000-7000-8000-000000000003",
    }]);

    expect(result.childSessionId).toBe("00000000-0000-7000-8000-000000000003");
  });

  it("omits the child session ID when no valid session event arrives", async () => {
    const result = await finishWith([
      { type: "session" },
      { type: "session", id: 42 },
    ]);

    expect(result.childSessionId).toBeUndefined();
  });
});
