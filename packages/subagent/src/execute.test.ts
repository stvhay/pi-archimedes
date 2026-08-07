import { describe, expect, it, vi } from "vitest";

const { spawnSubagentMock, streamEventsMock } = vi.hoisted(() => ({
  spawnSubagentMock: vi.fn(() => ({})),
  streamEventsMock: vi.fn(),
}));

vi.mock("./spawn.js", () => ({ spawnSubagent: spawnSubagentMock }));
vi.mock("./stream.js", () => ({ streamEvents: streamEventsMock }));

import {
  aggregateUsage,
  applyControlTermination,
  createExecutionControl,
  executeParallel,
  executeSubagent,
} from "./execute.js";
import type { ExecuteOptions } from "./execute.js";
import type { SubagentResult } from "./types.js";

const agenticExecution = () => ({
  profile: { mode: "agentic" as const, thinking: undefined },
  limits: undefined,
});

function result(task: string, exitCode: number): SubagentResult {
  return {
    agent: task,
    task,
    exitCode,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.1,
      costBreakdown: { input: 0.02, output: 0.06, cacheRead: 0.01, cacheWrite: 0.01, total: 0.1 },
      turns: 1,
    },
    model: "model",
    finalOutput: task,
    error: exitCode === 0 ? undefined : "limited",
    termination: exitCode === 0
      ? { reason: "completed", usageState: "complete" }
      : { reason: "request-limit", limit: 1, observed: 1, usageState: "complete" },
    progress: undefined,
    progressSummary: { toolCount: 0, tokens: 18, durationMs: 1 },
  };
}

describe("createExecutionControl", () => {
  it("aborts one child at its deadline and records timeout state", async () => {
    const control = createExecutionControl(undefined, 5);

    await new Promise<void>((resolve) => {
      control.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(control.signal.aborted).toBe(true);
    expect(control.timedOut()).toBe(true);
  });

  it("propagates parent cancellation without calling it a timeout", () => {
    const parent = new AbortController();
    const control = createExecutionControl(parent.signal, 1000);

    parent.abort();

    expect(control.signal.aborted).toBe(true);
    expect(control.timedOut()).toBe(false);
  });

  it("keeps parent cancellation provenance after the deadline also expires", async () => {
    const parent = new AbortController();
    const control = createExecutionControl(parent.signal, 5);

    parent.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(control.timedOut()).toBe(false);
  });
});

describe("applyControlTermination", () => {
  it("classifies a clean child exit after deadline as time-limit", () => {
    const controlled = applyControlTermination(
      result("clean", 0),
      { task: "clean", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: { profile: { mode: "agentic", thinking: undefined }, limits: { maxDurationMs: 1000 } } },
      { signal: new AbortController().signal, timedOut: () => true },
      1001,
    );

    expect(controlled.exitCode).toBe(2);
    expect(controlled.termination).toMatchObject({ reason: "time-limit", limit: 1000, observed: 1001 });
  });

  it("classifies a clean child exit after parent abort as user-abort", () => {
    const parent = new AbortController();
    parent.abort();
    const controlled = applyControlTermination(
      result("clean", 0),
      { task: "clean", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: parent.signal, onUpdate: undefined, execution: agenticExecution() },
      { signal: parent.signal, timedOut: () => false },
      10,
    );

    expect(controlled.termination).toMatchObject({ reason: "user-abort" });
  });
});

describe("aggregateUsage", () => {
  it("returns complete nested usage across children", () => {
    expect(aggregateUsage([result("a", 0), result("b", 0)])).toEqual({
      input: 20,
      output: 10,
      cacheRead: 4,
      cacheWrite: 2,
      totalTokens: 36,
      cost: { input: 0.04, output: 0.12, cacheRead: 0.02, cacheWrite: 0.02, total: 0.2 },
    });
  });
});

describe("executeSubagent", () => {
  it("passes one resolved execution plan unchanged to spawn", async () => {
    streamEventsMock.mockResolvedValueOnce(result("one-shot", 0));

    const execution = {
      profile: { mode: "one-shot" as const, thinking: undefined },
      limits: { maxProviderRequests: 1 },
    };
    const executed = await executeSubagent({
      agent: undefined,
      agentConfig: undefined,
      task: "one-shot",
      model: undefined,
      activeModel: undefined,
      cwd: undefined,
      signal: undefined,
      onUpdate: undefined,
      execution,
    });

    expect(spawnSubagentMock).toHaveBeenCalledWith(expect.objectContaining({ execution }));
    expect(executed.execution).toEqual(execution);
  });
});

describe("executeParallel", () => {
  it("keeps task order and lets a sibling complete after one child stops", async () => {
    const tasks: ExecuteOptions[] = [
      { agent: undefined, agentConfig: undefined, task: "limited", model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: agenticExecution() },
      { agent: undefined, agentConfig: undefined, task: "success", model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: agenticExecution() },
    ];
    const runner = vi.fn(async (options: ExecuteOptions) => {
      if (options.task === "limited") return result(options.task, 2);
      await Promise.resolve();
      return result(options.task, 0);
    });

    const results = await executeParallel({ tasks, signal: undefined, onUpdate: undefined }, runner);

    expect(results.map((item) => item.task)).toEqual(["limited", "success"]);
    expect(results[0]?.termination?.reason).toBe("request-limit");
    expect(results[1]?.termination?.reason).toBe("completed");
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
