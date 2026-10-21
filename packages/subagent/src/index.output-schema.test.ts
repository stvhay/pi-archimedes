/**
 * Task 11 item 2 — `subagent` as a programmatic tool.
 *
 * `details` is the renderer's payload: per-run reports plus the live-progress
 * blob (`progress`, with the child's whole streamed output and its tool-call
 * history). A script wants the run reports, not the scrollback, so the
 * structured content is the report set with `progress` left out — see the
 * comment at the declaration in `index.ts`.
 *
 * `subagent` already reports failure as `isError` rather than throwing (ADR
 * 0028), and that shape is unchanged here; what is new is that the failure
 * results carry no structured content, so a script keeps rejecting with the
 * text it rejects with today.
 *
 * `./agents.js` and `./execute.js` are mocked (as `index.test.ts` does) so the
 * assertions are about the result contract rather than a real child process.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "typebox/value";

const discoverAgents = vi.hoisted(() => vi.fn());
const executeSubagent = vi.hoisted(() => vi.fn());
const executeParallel = vi.hoisted(() => vi.fn());

vi.mock("./agents.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  discoverAgents,
}));
vi.mock("./execute.js", () => ({ executeSubagent, executeParallel }));

const { registerSubagent } = await import("./index.js");
const { formatSingleResult } = await import("./format.js");

type RegisteredTool = {
  name: string;
  outputSchema?: unknown;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
};

function subagent(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  registerSubagent({
    registerTool: (t: unknown) => tools.push(t as RegisteredTool),
    on: () => {},
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    events: { emit: () => {}, on: () => () => {} },
  } as never);
  const tool = tools.find((t) => t.name === "subagent");
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { getAll: () => [], getAvailable: () => [] },
    hasUI: true,
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

/** A completed run, with the live-progress blob a real stream would attach. */
const okResult = {
  agent: "reviewer",
  task: "review it",
  childSessionId: "child-uuid",
  exitCode: 0,
  outcome: "completed" as const,
  usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 },
  model: "anthropic/claude-opus-4.5",
  finalOutput: "all good",
  error: undefined,
  progress: {
    agent: "reviewer",
    status: "completed" as const,
    outcome: "completed" as const,
    task: "review it",
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    toolCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    tokens: 15,
    cost: 0.01,
    durationMs: 10,
    error: undefined,
    model: "anthropic/claude-opus-4.5",
    output: "the child's entire scrollback, which a script does not need twice",
    recentOutput: ["x"],
    toolCalls: [{ name: "read", argsPreview: "file", error: false }],
  },
  progressSummary: { toolCount: 1, tokens: 15, durationMs: 10 },
};

function agentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "reviewer",
    description: "d",
    systemPrompt: "p",
    source: "user",
    filePath: "/tmp/agents/reviewer.md",
    ...overrides,
  };
}

function check(tool: RegisteredTool, value: unknown): boolean {
  expect(tool.outputSchema, "subagent declares no outputSchema").toBeDefined();
  return Value.Check(tool.outputSchema as never, value);
}

beforeEach(() => {
  discoverAgents.mockReset();
  executeSubagent.mockReset();
  executeParallel.mockReset();
  discoverAgents.mockReturnValue([agentConfig()]);
  executeSubagent.mockResolvedValue(okResult);
  executeParallel.mockResolvedValue([okResult]);
});

describe("subagent outputSchema", () => {
  it("declares one, describing mode + results", () => {
    const tool = subagent();
    expect(tool.outputSchema).toBeDefined();
    const props = (tool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["mode", "results"]);
  });
});

describe("subagent structuredContent — single mode", () => {
  it("a completed run reports itself structurally, without the live-progress blob", async () => {
    const tool = subagent();
    const result = await tool.execute("c1", { agent: "reviewer", task: "review it" }, undefined, undefined, makeCtx());

    expect(result.content[0]!.text).toBe(formatSingleResult(okResult as never));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      mode: "single",
      results: [
        {
          agent: "reviewer",
          task: "review it",
          childSessionId: "child-uuid",
          exitCode: 0,
          outcome: "completed",
          usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 },
          model: "anthropic/claude-opus-4.5",
          finalOutput: "all good",
          progressSummary: { toolCount: 1, tokens: 15, durationMs: 10 },
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
    // The scrollback stays in `details` for the renderer, out of the structured payload.
    expect(JSON.stringify(result.structuredContent)).not.toContain("scrollback");
  });

  it("a failed run is isError with no structured content, content text unchanged", async () => {
    const failed = { ...okResult, outcome: undefined, error: "child crashed", finalOutput: undefined };
    executeSubagent.mockResolvedValueOnce(failed);

    const tool = subagent();
    const result = await tool.execute("c1", { agent: "reviewer", task: "review it" }, undefined, undefined, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(formatSingleResult(failed as never));
    expect("structuredContent" in result).toBe(false);
  });

  it("an unknown agent stays isError with the same text, and carries no structured content", async () => {
    const tool = subagent();
    const result = await tool.execute("c1", { agent: "ghost", task: "t" }, undefined, undefined, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown agent: "ghost"');
    expect("structuredContent" in result).toBe(false);
  });

  it("a call with no task stays isError with the same text", async () => {
    const tool = subagent();
    const result = await tool.execute("c1", {}, undefined, undefined, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Missing task parameter");
    expect("structuredContent" in result).toBe(false);
  });
});

describe("subagent structuredContent — parallel mode", () => {
  it("reports every run, in task order", async () => {
    // Both agents must exist, or the batch is rejected before anything runs.
    discoverAgents.mockReturnValue([agentConfig(), agentConfig({ name: "explorer" })]);
    const second = { ...okResult, agent: "explorer", task: "look around", finalOutput: "noted" };
    executeParallel.mockResolvedValueOnce([okResult, second]);

    const tool = subagent();
    const result = await tool.execute(
      "c2",
      { tasks: [{ agent: "reviewer", task: "review it" }, { agent: "explorer", task: "look around" }] },
      undefined,
      undefined,
      makeCtx(),
    );

    expect(result.content).toEqual([
      { type: "text", text: "✓ reviewer 1 tools · 0k tok · 0s\n✓ explorer 1 tools · 0k tok · 0s" },
      { type: "text", text: "Child 1 output:\nall good" },
      { type: "text", text: "Child 2 output:\nnoted" },
    ]);
    const structured = result.structuredContent as { mode: string; results: Array<{ agent: string }> };
    expect(structured.mode).toBe("parallel");
    expect(structured.results.map((r) => r.agent)).toEqual(["reviewer", "explorer"]);
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("a rejected batch (unknown agent in one task) is isError, no structured content", async () => {
    const tool = subagent();
    const result = await tool.execute(
      "c2",
      { tasks: [{ agent: "ghost", task: "t" }] },
      undefined,
      undefined,
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown agent(s)");
    expect("structuredContent" in result).toBe(false);
  });
});

// The outcomes above tests never produced. `truncated` and `aborted` are declared
// in `SUBAGENT_OUTPUT_SCHEMA`'s outcome union, and ADR 0028 makes them ordinary
// successes (something was produced, so the run is not `isError`) — so their
// reports reach the structured payload, and the declaration has to hold for them
// too. Nothing here was previously exercised: the suite only ever handed back a
// `completed` run.
describe("subagent structuredContent — the other run outcomes", () => {
  it.each(["truncated", "aborted"] as const)("%s run: not an error, carries a report, validates", async (outcome) => {
    discoverAgents.mockReturnValue([agentConfig()]);
    executeSubagent.mockResolvedValueOnce({ ...okResult, outcome, finalOutput: "a partial answer" });

    const tool = subagent();
    const result = await tool.execute("c3", { agent: "reviewer", task: "review it" }, undefined, undefined, makeCtx());

    expect(result.isError).toBe(false);
    const report = (result.structuredContent as { results: Array<Record<string, unknown>> }).results[0]!;
    expect(report["outcome"]).toBe(outcome);
    expect(report["error"]).toBeUndefined();
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("a run reporting almost nothing (no session id, model, output or summary) validates", async () => {
    discoverAgents.mockReturnValue([]);
    // The bare shape `executeSubagent` produces for a config-less run that had
    // nothing else to report: every optional field absent, not present-and-null.
    executeSubagent.mockResolvedValueOnce({
      agent: "subagent",
      task: "t",
      exitCode: 0,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    });

    const tool = subagent();
    const result = await tool.execute("c4", { task: "t" }, undefined, undefined, makeCtx());

    expect(result.structuredContent).toEqual({
      mode: "single",
      results: [
        {
          agent: "subagent",
          task: "t",
          exitCode: 0,
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("a parallel batch with one failed run reports it per-run, inside a valid payload", async () => {
    discoverAgents.mockReturnValue([agentConfig(), agentConfig({ name: "explorer" })]);
    executeParallel.mockResolvedValueOnce([
      okResult,
      { ...okResult, agent: "explorer", task: "look around", outcome: undefined, finalOutput: undefined, error: "child died" },
    ]);

    const tool = subagent();
    const result = await tool.execute(
      "c5",
      { tasks: [{ agent: "reviewer", task: "review it" }, { agent: "explorer", task: "look around" }] },
      undefined,
      undefined,
      makeCtx(),
    );

    // The batch is not `isError` — it is, and was before these schemas existed:
    // one run failing inside a batch is reported per run, in the text (`✗ explorer`)
    // and in the report (`error`). `error` is declared optional for exactly this.
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("✗ explorer");
    const reports = (result.structuredContent as { results: Array<Record<string, unknown>> }).results;
    expect(reports[1]!["error"]).toBe("child died");
    expect(reports[0]!["error"]).toBeUndefined();
    expect(check(tool, result.structuredContent)).toBe(true);
  });
});
