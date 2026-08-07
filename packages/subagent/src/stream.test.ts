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

describe("streamEvents session identity", () => {
  it("returns the logical child Pi session ID", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stdout.write(`${JSON.stringify({
      type: "session",
      id: "00000000-0000-7000-8000-000000000003",
    })}\n`);
    child.emit("close", 0, null);

    expect((await pending).childSessionId).toBe("00000000-0000-7000-8000-000000000003");
  });

  it("omits the child session ID when no valid session event arrives", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stdout.write(`${JSON.stringify({ type: "session" })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "session", id: 42 })}\n`);
    child.emit("close", 0, null);

    expect((await pending).childSessionId).toBeUndefined();
  });
});

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

  it("keeps ordinary stderr as the process error", async () => {
    const child = fakeChild();
    const pending = streamEvents(child);

    child.stderr.write("provider failed\n");
    child.emit("close", 1, null);

    const result = await pending;
    expect(result.error).toBe("provider failed");
    expect(result.termination).toMatchObject({ reason: "process-error" });
  });
});
