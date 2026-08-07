import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentResult } from "./types.js";

const { configState, executeParallelMock, executeSubagentMock } = vi.hoisted(() => ({
  configState: {
    maxParallel: 2,
    limits: { maxProviderRequests: 2 } as { maxProviderRequests: number } | undefined,
    loadError: undefined as Error | undefined,
  },
  executeParallelMock: vi.fn(),
  executeSubagentMock: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    loadSubagentConfig: () => {
      if (configState.loadError) throw configState.loadError;
      return {
        maxParallel: configState.maxParallel,
        defaultLimits: {
          maxProviderRequests: configState.limits?.maxProviderRequests ?? 0,
          maxToolCalls: 0,
          maxTotalTokens: 0,
          maxCostUsd: 0,
          maxDurationMs: 0,
        },
      };
    },
    resolveConfiguredLimits: () => configState.limits,
  };
});

vi.mock("./execute.js", () => ({
  aggregateUsage: () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }),
  executeParallel: executeParallelMock,
  executeSubagent: executeSubagentMock,
}));

import { registerSubagent } from "./index.js";

function completedResult(task: string): SubagentResult {
  return {
    agent: "subagent",
    task,
    exitCode: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    model: "model",
    finalOutput: "ok",
    error: undefined,
    termination: { reason: "completed", usageState: "complete" },
    progress: undefined,
    progressSummary: { toolCount: 0, tokens: 0, durationMs: 1 },
  };
}

function registeredSubagentTool() {
  const previousSocket = process.env.PI_SUBAGENT_SOCKET;
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
  delete process.env.PI_SUBAGENT_SOCKET;
  try {
    registerSubagent({ registerTool: (tool: any) => tools.push(tool) } as unknown as ExtensionAPI);
  } finally {
    if (previousSocket === undefined) delete process.env.PI_SUBAGENT_SOCKET;
    else process.env.PI_SUBAGENT_SOCKET = previousSocket;
  }
  return tools.find((tool) => tool.name === "subagent")!;
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    model: undefined,
    modelRegistry: { getAll: () => [] },
  } as unknown as ExtensionContext;
}

describe("subagent dispatch policy integration", () => {
  beforeEach(() => {
    configState.maxParallel = 2;
    configState.limits = { maxProviderRequests: 2 };
    configState.loadError = undefined;
    executeParallelMock.mockReset();
    executeSubagentMock.mockReset();
  });

  it("rejects oversized fanout before spawning any child", async () => {
    configState.maxParallel = 1;
    const result = await registeredSubagentTool().execute(
      "id",
      { tasks: [{ task: "one" }, { task: "two" }] },
      undefined,
      undefined,
      context(process.cwd()),
    );

    expect(result.content[0]?.text).toContain("maxParallel");
    expect(executeParallelMock).not.toHaveBeenCalled();
  });

  it("passes operator default limits into a single child", async () => {
    executeSubagentMock.mockResolvedValue(completedResult("one"));

    await registeredSubagentTool().execute(
      "id",
      { task: "one" },
      undefined,
      undefined,
      context(process.cwd()),
    );

    expect(executeSubagentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: undefined,
      execution: {
        profile: { mode: "agentic", thinking: undefined },
        limits: { maxProviderRequests: 2 },
      },
    }));
  });

  it("passes one resolved execution plan per parallel child", async () => {
    executeParallelMock.mockResolvedValue([
      completedResult("one-shot"),
      completedResult("agentic"),
    ]);

    await registeredSubagentTool().execute(
      "id",
      {
        tasks: [
          { task: "one-shot", mode: "one-shot" },
          { task: "agentic", mode: "agentic" },
        ],
      },
      undefined,
      undefined,
      context(process.cwd()),
    );

    const tasks = executeParallelMock.mock.calls[0]?.[0].tasks;
    expect(tasks[0].execution).toEqual({
      profile: { mode: "one-shot", thinking: undefined },
      limits: { maxProviderRequests: 1 },
    });
    expect(tasks[1].execution).toEqual({
      profile: { mode: "agentic", thinking: undefined },
      limits: { maxProviderRequests: 2 },
    });
  });

  it("returns malformed operator config as a structured tool error", async () => {
    configState.loadError = new Error("maxParallel must be a non-negative integer");

    const result = await registeredSubagentTool().execute(
      "id",
      { task: "one" },
      undefined,
      undefined,
      context(process.cwd()),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("maxParallel");
    expect(executeSubagentMock).not.toHaveBeenCalled();
  });

  it("rejects one-shot work with provider retries even without operator limits", async () => {
    configState.limits = undefined;
    const cwd = mkdtempSync(join(tmpdir(), "archimedes-one-shot-retry-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      retry: { provider: { maxRetries: 1 } },
    }));

    try {
      const result = await registeredSubagentTool().execute(
        "id",
        { task: "one", mode: "one-shot", cwd },
        undefined,
        undefined,
        context(cwd),
      );

      expect(result.content[0]?.text).toContain("retry.provider.maxRetries");
      expect(executeSubagentMock).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects bounded work when project provider retries are nonzero", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archimedes-retry-policy-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      retry: { provider: { maxRetries: 1 } },
    }));

    try {
      const result = await registeredSubagentTool().execute(
        "id",
        { task: "one", cwd },
        undefined,
        undefined,
        context(cwd),
      );

      expect(result.content[0]?.text).toContain("retry.provider.maxRetries");
      expect(executeSubagentMock).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
