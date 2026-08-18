import { describe, expect, it, vi } from "vitest";

const { spawnSubagentMock, streamEventsMock } = vi.hoisted(() => ({
  spawnSubagentMock: vi.fn(() => ({})),
  streamEventsMock: vi.fn(),
}));

vi.mock("./spawn.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./spawn.js")>(),
  spawnSubagent: spawnSubagentMock,
}));
vi.mock("./stream.js", () => ({ streamEvents: streamEventsMock }));

import {
  aggregateUsage,
  applyControlTermination,
  createExecutionControl,
  executeParallel,
  executeSubagent,
} from "./execute.js";
import type { ExecuteOptions, ExecutionControl, ExecutionStopCause } from "./execute.js";
import type { SubagentResult } from "./types.js";

const agenticExecution = () => ({
  profile: { mode: "agentic" as const, thinking: undefined },
  limits: undefined,
});

function stoppedControl(cause: ExecutionStopCause): ExecutionControl {
  return {
    signal: new AbortController().signal,
    noteActivity: vi.fn(),
    pauseIdle: vi.fn(),
    resumeIdle: vi.fn(),
    recordWorkerStop: vi.fn(),
    settle: vi.fn(),
    stopCause: () => cause,
  };
}

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
  it("aborts after one idle window and records time since child activity", () => {
    vi.useFakeTimers();
    try {
      const control = createExecutionControl(undefined, { maxIdleMs: 1000 });

      vi.advanceTimersByTime(1000);
      expect(control.signal.aborted).toBe(false);
      control.noteActivity();
      vi.advanceTimersByTime(1000);

      expect(control.signal.aborted).toBe(true);
      expect(control.stopCause()).toEqual({ reason: "idle-limit", limit: 1000, observed: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the idle window after valid child activity", () => {
    vi.useFakeTimers();
    try {
      const control = createExecutionControl(undefined, { maxIdleMs: 1000 });

      vi.advanceTimersByTime(900);
      control.noteActivity();
      vi.advanceTimersByTime(999);
      expect(control.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);

      expect(control.stopCause()).toEqual({ reason: "idle-limit", limit: 1000, observed: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses idle while waiting for a human and restarts a fresh lease", () => {
    vi.useFakeTimers();
    try {
      const control = createExecutionControl(undefined, { maxIdleMs: 1000 });

      control.noteActivity();
      vi.advanceTimersByTime(900);
      control.pauseIdle();
      vi.advanceTimersByTime(10_000);
      expect(control.signal.aborted).toBe(false);
      control.resumeIdle();
      vi.advanceTimersByTime(1000);

      expect(control.stopCause()).toEqual({ reason: "idle-limit", limit: 1000, observed: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the absolute deadline despite continuous activity", () => {
    vi.useFakeTimers();
    try {
      const control = createExecutionControl(undefined, { maxDurationMs: 2000, maxIdleMs: 1000 });

      vi.advanceTimersByTime(900);
      control.noteActivity();
      vi.advanceTimersByTime(900);
      control.noteActivity();
      vi.advanceTimersByTime(200);

      expect(control.stopCause()).toEqual({ reason: "time-limit", limit: 2000, observed: 2000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses deterministic hard-first precedence when deadlines tie", () => {
    vi.useFakeTimers();
    try {
      const control = createExecutionControl(undefined, { maxDurationMs: 1000, maxIdleMs: 1000 });

      vi.advanceTimersByTime(1000);

      expect(control.stopCause()?.reason).toBe("time-limit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves parent-first and worker-first provenance", () => {
    vi.useFakeTimers();
    try {
      const parentFirst = new AbortController();
      const parentControl = createExecutionControl(parentFirst.signal, { maxDurationMs: 1000, maxIdleMs: 500 });
      parentFirst.abort();
      parentControl.recordWorkerStop({ reason: "request-limit", limit: 1, observed: 1, usageState: "complete" });
      vi.advanceTimersByTime(1000);
      expect(parentControl.stopCause()).toEqual({ reason: "user-abort" });

      const workerFirst = new AbortController();
      const workerControl = createExecutionControl(workerFirst.signal, { maxDurationMs: 1000, maxIdleMs: 500 });
      workerControl.recordWorkerStop({ reason: "request-limit", limit: 1, observed: 1, usageState: "complete" });
      workerFirst.abort();
      vi.advanceTimersByTime(1000);
      expect(workerControl.stopCause()).toMatchObject({
        reason: "worker",
        termination: { reason: "request-limit" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles without a later abort or cause", () => {
    vi.useFakeTimers();
    try {
      const control = createExecutionControl(undefined, { maxDurationMs: 1000, maxIdleMs: 500 });
      control.settle();

      vi.advanceTimersByTime(1000);

      expect(control.signal.aborted).toBe(false);
      expect(control.stopCause()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("applyControlTermination", () => {
  it("classifies a clean child exit after deadline as time-limit", () => {
    const controlled = applyControlTermination(
      result("clean", 0),
      { task: "clean", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: { profile: { mode: "agentic", thinking: undefined }, limits: { maxDurationMs: 1000 } } },
      stoppedControl({ reason: "time-limit", limit: 1000, observed: 1001 }),
      1001,
    );

    expect(controlled.exitCode).toBe(2);
    expect(controlled.termination).toMatchObject({ reason: "time-limit", limit: 1000, observed: 1001 });
  });

  it("classifies a clean child exit after idle expiry as idle-limit", () => {
    const controlled = applyControlTermination(
      result("clean", 0),
      { task: "clean", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: { profile: { mode: "agentic", thinking: undefined }, limits: { maxIdleMs: 1000 } } },
      stoppedControl({ reason: "idle-limit", limit: 1000, observed: 1001 }),
      5000,
    );

    expect(controlled.exitCode).toBe(2);
    expect(controlled.termination).toMatchObject({ reason: "idle-limit", limit: 1000, observed: 1001 });
  });

  it("marks idle usage partial even when no text was emitted", () => {
    const noText = { ...result("usage-only", 0), finalOutput: undefined };
    const controlled = applyControlTermination(
      noText,
      { task: "usage-only", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: { profile: { mode: "agentic", thinking: undefined }, limits: { maxIdleMs: 1000 } } },
      stoppedControl({ reason: "idle-limit", limit: 1000, observed: 1000 }),
      5000,
    );

    expect(controlled.termination).toMatchObject({ reason: "idle-limit", usageState: "partial" });
  });

  it("preserves an earlier worker limit when parent cancellation follows", () => {
    const limited = result("limited", 2);
    const controlled = applyControlTermination(
      limited,
      { task: "limited", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: undefined, onUpdate: undefined, execution: agenticExecution() },
      stoppedControl({ reason: "worker", termination: limited.termination! }),
      10,
    );

    expect(controlled).toBe(limited);
    expect(controlled.termination?.reason).toBe("request-limit");
  });

  it("classifies a clean child exit after parent abort as user-abort", () => {
    const parent = new AbortController();
    parent.abort();
    const controlled = applyControlTermination(
      result("clean", 0),
      { task: "clean", agent: undefined, agentConfig: undefined, model: undefined, activeModel: undefined, cwd: undefined, signal: parent.signal, onUpdate: undefined, execution: agenticExecution() },
      stoppedControl({ reason: "user-abort" }),
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
  it("passes one resolved execution plan unchanged and preserves output-limit evidence", async () => {
    const execution = {
      profile: { mode: "one-shot" as const, thinking: undefined },
      limits: { maxProviderRequests: 1, maxOutputTokens: 16_384 },
    };
    streamEventsMock.mockResolvedValueOnce({
      ...result("one-shot", 0),
      execution: {
        ...execution,
        outputLimit: { requested: 16_384, enforcement: "unsupported" },
      },
    });

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
      outputContract: "artifact",
    });

    expect(spawnSubagentMock).toHaveBeenCalledWith(expect.objectContaining({ execution }));
    expect(streamEventsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ execution }));
    expect(executed.execution).toEqual({
      ...execution,
      outputLimit: { requested: 16_384, enforcement: "unsupported" },
    });
    expect(executed.outputContract).toBe("artifact");
  });

  it("preserves a worker stop when the event stream then rejects", async () => {
    streamEventsMock.mockImplementationOnce(async (_child, callbacks) => {
      callbacks.onTermination({ reason: "request-limit", limit: 4, observed: 4, usageState: "complete" });
      throw new Error("stream failed during shutdown");
    });

    const executed = await executeSubagent({
      agent: undefined,
      agentConfig: undefined,
      task: "worker-first",
      model: undefined,
      activeModel: undefined,
      cwd: undefined,
      signal: undefined,
      onUpdate: undefined,
      execution: { profile: { mode: "agentic", thinking: undefined }, limits: { maxProviderRequests: 4 } },
    });

    expect(executed.exitCode).toBe(2);
    expect(executed.termination).toEqual({
      reason: "request-limit",
      limit: 4,
      observed: 4,
      usageState: "complete",
    });
  });

  it("preserves execution evidence when spawn fails", async () => {
    spawnSubagentMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    const execution = {
      profile: { mode: "one-shot" as const, thinking: "high" },
      limits: { maxProviderRequests: 1, maxOutputTokens: 16_384 },
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
      outputContract: "status-only",
    });

    expect(executed.execution).toEqual(execution);
    expect(executed.outputContract).toBe("status-only");
    expect(executed.termination).toMatchObject({ reason: "process-error" });
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
