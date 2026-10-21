/**
 * Dispatch-time behaviour of the `subagent` tool: the two halves of tool-name
 * validation as the calling model sees them.
 *
 *   * A `tools:` list the config read rejected (an entry pi cannot read as a
 *     name) refuses the dispatch — the child must never be spawned with a list
 *     whose meaning is up to the host's parser.
 *   * A name that is well formed but not in `pi.getAllTools()` right now is a
 *     **warning** and the dispatch runs anyway. A plugin being toggled off, or an
 *     MCP server being disconnected, must not make `tools: web_search` unusable.
 *
 * `./agents.js` and `./execute.js` are mocked so the assertions are about the
 * gate, not about the filesystem or a real child process.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Events } from "@pi-archimedes/core/events";

const discoverAgents = vi.hoisted(() => vi.fn());
const executeSubagent = vi.hoisted(() => vi.fn());
const executeParallel = vi.hoisted(() => vi.fn());

vi.mock("./agents.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  discoverAgents,
}));
vi.mock("./execute.js", () => ({
  executeSubagent,
  executeParallel,
}));

const { registerSubagent } = await import("./index.js");

interface FakeTool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function register(): FakeTool[] {
  const tools: FakeTool[] = [];
  const pi = {
    registerTool: (def: FakeTool) => tools.push(def),
    on: () => {},
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    // The handle the tool forwards to `executeSubagent`. Recorded so the
    // COST_UPDATE assertions below can say "nothing was published here".
    events: { emit: (channel: string, payload: unknown) => busEmits.push([channel, payload]), on: () => () => {} },
  };
  // `as never` at the seam only: the fake API carries the members the
  // registration path actually touches.
  registerSubagent(pi as never);
  return tools;
}

/** Everything the tool emitted on its handle, in order. */
const busEmits: Array<[string, unknown]> = [];

beforeEach(() => {
  busEmits.length = 0;
});

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

const okResult = {
  agent: "reviewer",
  task: "review it",
  exitCode: 0,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
  model: "anthropic/claude-opus-4.5",
  finalOutput: "all good",
  error: undefined,
  progress: undefined,
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

function subagent(tools: FakeTool[]): FakeTool {
  const tool = tools.find((t) => t.name === "subagent");
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

beforeEach(() => {
  discoverAgents.mockReset();
  executeSubagent.mockReset();
  executeParallel.mockReset();
  executeSubagent.mockResolvedValue(okResult);
  executeParallel.mockResolvedValue([okResult]);
});

describe("dispatch: membership of tools: entries", () => {
  it("a well-formed name pi does not have right now warns, naming the entry", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "web_search"] })]);
    const ctx = makeCtx();
    const result = await subagent(register()).execute(
      "call-1",
      { agent: "reviewer", task: "review it" },
      undefined,
      undefined,
      ctx,
    );

    const warnings = ctx.ui.notify.mock.calls.filter(([, kind]) => kind === "warning");
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]![0])).toContain("web_search");
    expect(result.isError).toBeFalsy();
  });

  it("and the dispatch still runs, returning the child's real result", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "web_search"] })]);
    const ctx = makeCtx();
    const result = await subagent(register()).execute(
      "call-1",
      { agent: "reviewer", task: "review it" },
      undefined,
      undefined,
      ctx,
    );

    // The success path, not just the message: the child ran and its output is
    // what the model gets back.
    expect(executeSubagent).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toBe("all good");
    expect(result.isError).toBeFalsy();
  });

  it("names every unavailable entry in one warning", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "web_search", "fetch_content"] })]);
    const ctx = makeCtx();
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    const message = String(ctx.ui.notify.mock.calls.find(([, kind]) => kind === "warning")?.[0] ?? "");
    expect(message).toContain("web_search");
    expect(message).toContain("fetch_content");
  });

  it("says nothing when every entry is a tool pi has", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "bash"] })]);
    const ctx = makeCtx();
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(executeSubagent).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the agent has no allowlist (nothing to check)", async () => {
    discoverAgents.mockReturnValue([agentConfig()]);
    const ctx = makeCtx();
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("a * entry is a pattern, so it is judged against the tools pi has, not by name", async () => {
    const tools: Array<{ name: string }> = [{ name: "read" }, { name: "bash" }, { name: "mcp__radius__query" }];
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "mcp__radius__*"] })]);
    const ctx = makeCtx();
    const registered: FakeTool[] = [];
    registerSubagent({
      registerTool: (def: FakeTool) => registered.push(def),
      on: () => {},
      getAllTools: () => tools,
    } as never);
    await subagent(registered).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(executeSubagent).toHaveBeenCalledTimes(1);
  });

  it("a pattern that nothing currently satisfies is named in the warning", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "mcp__*"] })]);
    const ctx = makeCtx();
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    const warning = ctx.ui.notify.mock.calls.find(([, kind]) => kind === "warning");
    expect(warning).toBeTruthy();
    expect(String(warning![0])).toContain("mcp__*");
    // Still a warning: the run happens.
    expect(executeSubagent).toHaveBeenCalledTimes(1);
  });

  it("warns per task in parallel mode and still dispatches the batch", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["read", "web_search"] })]);
    const ctx = makeCtx();
    const result = await subagent(register()).execute(
      "c",
      { tasks: [{ agent: "reviewer", task: "a" }, { agent: "reviewer", task: "b" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(executeParallel).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    const warnings = ctx.ui.notify.mock.calls.filter(([, kind]) => kind === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(String(warnings[0]![0])).toContain("web_search");
  });

  it("stays quiet when there is no UI to notify, and still runs", async () => {
    discoverAgents.mockReturnValue([agentConfig({ tools: ["web_search"] })]);
    const ctx = makeCtx({ hasUI: false });
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(executeSubagent).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch: a tools list the config read rejected", () => {
  it("refuses to spawn, naming the entry and the file", async () => {
    discoverAgents.mockReturnValue([
      agentConfig({
        tools: undefined,
        toolsError: 'Agent "reviewer" has a tools entry starting with "+" (in /tmp/agents/reviewer.md): "+web_search".',
      }),
    ]);
    const ctx = makeCtx();
    const result = await subagent(register()).execute(
      "c",
      { agent: "reviewer", task: "t" },
      undefined,
      undefined,
      ctx,
    );
    expect(executeSubagent).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("+web_search");
    expect(result.content[0]!.text).toContain("/tmp/agents/reviewer.md");
  });

  it("refuses the whole parallel batch rather than running the poisoned task", async () => {
    discoverAgents.mockReturnValue([
      agentConfig({ toolsError: 'Agent "reviewer" lists the tool "read" more than once (in /tmp/agents/reviewer.md).' }),
    ]);
    const ctx = makeCtx();
    const result = await subagent(register()).execute(
      "c",
      { tasks: [{ agent: "reviewer", task: "a" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(executeParallel).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("read");
  });
});

describe("dispatch: the result the model reads carries the run outcome", () => {
  it("marks a truncated answer, and does not report it as an error", async () => {
    discoverAgents.mockReturnValue([]);
    executeSubagent.mockResolvedValue({
      ...okResult,
      outcome: "truncated",
      exitCode: 1,
      finalOutput: "here is most of it",
      error: undefined,
    });
    const ctx = makeCtx();
    const result = await subagent(register()).execute("c", { task: "t" }, undefined, undefined, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("here is most of it");
    expect(result.content[0]!.text).toMatch(/truncated/i);
  });

  it("marks a cancelled run", async () => {
    discoverAgents.mockReturnValue([]);
    executeSubagent.mockResolvedValue({
      ...okResult,
      outcome: "aborted",
      exitCode: 143,
      finalOutput: undefined,
    });
    const result = await subagent(register()).execute("c", { task: "t" }, undefined, undefined, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/aborted/i);
  });

  it("keeps reporting a failed run as an error, with no outcome claim", async () => {
    discoverAgents.mockReturnValue([]);
    executeSubagent.mockResolvedValue({
      ...okResult,
      outcome: undefined,
      exitCode: 1,
      finalOutput: undefined,
      error: "boom",
    });
    const result = await subagent(register()).execute("c", { task: "t" }, undefined, undefined, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("boom");
  });

  it("reports a failed run that exited 0 as an error too", async () => {
    // The exit code cannot be the trigger: `--mode json` — what the child runs —
    // never maps `stopReason` onto it (that mapping is print mode's text branch),
    // so a child whose last response errored exits 0. Keying `isError` off the
    // code reported a provider failure to the model as a success.
    discoverAgents.mockReturnValue([]);
    executeSubagent.mockResolvedValue({
      ...okResult,
      outcome: undefined,
      exitCode: 0,
      finalOutput: undefined,
      error: '401 unauthorized',
    });
    const result = await subagent(register()).execute("c", { task: "t" }, undefined, undefined, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("401");
  });

  it("says nothing extra for a completed run", async () => {
    discoverAgents.mockReturnValue([]);
    const result = await subagent(register()).execute("c", { task: "t" }, undefined, undefined, makeCtx());
    expect(result.content[0]!.text).toBe("all good");
    expect(result.isError).toBeFalsy();
  });
});

describe("dispatch: a thinking level pi would drop is said out loud", () => {
  // pi's `--thinking` parser warns and drops an unknown level, and a json
  // child's stderr is invisible on a successful run — so without this the user
  // reads "thinking: ultra" in the config and gets the default. The run still
  // goes ahead (that IS what pi would have done); only the silence changes.
  it("warns, naming the level and what runs instead, and still dispatches", async () => {
    discoverAgents.mockReturnValue([agentConfig({ thinking: "ultra" })]);
    const ctx = makeCtx();
    const result = await subagent(register()).execute(
      "c",
      { agent: "reviewer", task: "t" },
      undefined,
      undefined,
      ctx,
    );
    const warnings = ctx.ui.notify.mock.calls.filter(([, kind]) => kind === "warning");
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]![0])).toContain("ultra");
    expect(String(warnings[0]![0])).toMatch(/default thinking level/i);
    expect(result.isError).toBeFalsy();
    expect(executeSubagent).toHaveBeenCalledTimes(1);
  });

  it("says nothing for a level pi takes", async () => {
    discoverAgents.mockReturnValue([agentConfig({ thinking: "medium" })]);
    const ctx = makeCtx();
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("says nothing when the config sets no thinking level", async () => {
    discoverAgents.mockReturnValue([agentConfig()]);
    const ctx = makeCtx();
    await subagent(register()).execute("c", { agent: "reviewer", task: "t" }, undefined, undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("reports it in parallel mode too, once per distinct level", async () => {
    discoverAgents.mockReturnValue([agentConfig({ thinking: "turbo" })]);
    const ctx = makeCtx();
    await subagent(register()).execute(
      "c",
      { tasks: [{ agent: "reviewer", task: "a" }, { agent: "reviewer", task: "b" }] },
      undefined,
      undefined,
      ctx,
    );
    const warnings = ctx.ui.notify.mock.calls.filter(([, kind]) => kind === "warning");
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]![0])).toContain("turbo");
    expect(executeParallel).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch: cost is reported natively, not on the bus", () => {
  it("the tool result carries usage in pi's shape, so /session folds it in", async () => {
    discoverAgents.mockReturnValue([]);
    const result = (await subagent(register()).execute(
      "c",
      { task: "t" },
      undefined,
      undefined,
      makeCtx(),
    )) as unknown as {
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: { total: number };
      };
    };
    expect(result.usage?.input).toBe(10);
    expect(result.usage?.output).toBe(5);
    expect(result.usage?.totalTokens).toBe(15);
    expect(result.usage?.cost.total).toBeCloseTo(0.01);
  });

  it("a parallel batch carries the summed usage of its runs", async () => {
    discoverAgents.mockReturnValue([]);
    executeParallel.mockResolvedValue([okResult, okResult]);
    const result = (await subagent(register()).execute(
      "c",
      { tasks: [{ task: "a" }, { task: "b" }] },
      undefined,
      undefined,
      makeCtx(),
    )) as unknown as { usage?: { input: number; cost: { total: number } } };
    expect(result.usage?.input).toBe(20);
    expect(result.usage?.cost.total).toBeCloseTo(0.02);
  });

  it("does not republish the usage of a run the desktop performed (bridge mode)", async () => {
    // A bridge-dispatched child is a session of the desktop's own and books its
    // usage there. pi folds a tool result's `usage` into THIS session's totals,
    // so copying it across would bill the parent for a run it did not perform —
    // the same double-count that deleted the COST_UPDATE route. `executeSubagent`
    // marks the result; the tool has to honour the mark.
    discoverAgents.mockReturnValue([]);
    executeSubagent.mockResolvedValue({ ...okResult, usageAccountedElsewhere: true });
    const result = (await subagent(register()).execute(
      "c",
      { task: "t" },
      undefined,
      undefined,
      makeCtx(),
    )) as unknown as { usage?: unknown; content: Array<{ text: string }> };
    expect(result.usage).toBeUndefined();
    // Only the cost report is withheld — the run's output is untouched.
    expect(result.content[0]!.text).toBe("all good");
  });

  it("reports the fork path's usage even when a sibling run was done elsewhere", async () => {
    discoverAgents.mockReturnValue([]);
    executeParallel.mockResolvedValue([
      okResult,
      { ...okResult, usageAccountedElsewhere: true },
    ]);
    const result = (await subagent(register()).execute(
      "c",
      { tasks: [{ task: "a" }, { task: "b" }] },
      undefined,
      undefined,
      makeCtx(),
    )) as unknown as { usage?: { input: number; cost: { total: number } } };
    expect(result.usage?.input).toBe(10);
    expect(result.usage?.cost.total).toBeCloseTo(0.01);
  });

  it("publishes nothing on COST_UPDATE while a run reports its cost", async () => {
    discoverAgents.mockReturnValue([]);
    await subagent(register()).execute("c", { task: "t" }, undefined, undefined, makeCtx());
    expect(busEmits.filter(([channel]) => channel === Events.COST_UPDATE)).toEqual([]);
  });

  it("publishes nothing on COST_UPDATE for a parallel batch either", async () => {
    executeParallel.mockResolvedValue([okResult, okResult]);
    discoverAgents.mockReturnValue([]);
    await subagent(register()).execute(
      "c",
      { tasks: [{ task: "a" }, { task: "b" }] },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(busEmits.filter(([channel]) => channel === Events.COST_UPDATE)).toEqual([]);
  });
});

// The shape handed to the executor, pinned as data.
//
// `index.ts` maps each incoming task into the object `executeParallel` receives
// (and builds the single equivalent for `executeSubagent`). That map is the only
// place a per-task `cwd` or `model` reaches the child, and it had no guard: the
// tests above drive both branches through the mocked executors and assert the
// outcome, never the argument, so deleting a forwarded key stayed green
// everywhere. This is the behavioural replacement for the source-text scanner
// deleted in the same branch: it pins what is actually handed over by running the
// tool, instead of parsing `index.ts` and risking a red run on an unrelated edit.
// It is a narrower claim than the scanner's — it says nothing about whether the
// executor later reads a key it is given — see the header of
// `tool-schema.test.ts`, which states the residue that leaves uncovered.
describe("dispatch: the object forwarded to the executor", () => {
  it("forwards the full per-task shape to executeParallel", async () => {
    discoverAgents.mockReturnValue([agentConfig()]);
    await subagent(register()).execute(
      "c",
      { tasks: [{ agent: "reviewer", task: "a", model: "anthropic/claude-opus-4.5", cwd: "/tmp/work" }] },
      undefined,
      undefined,
      makeCtx(),
    );

    expect(executeParallel).toHaveBeenCalledTimes(1);
    const calls = executeParallel.mock.calls as unknown as Array<[{ tasks: Array<Record<string, unknown>> }]>;
    const forwarded = calls[0]![0].tasks[0]!;
    // Exact and sorted, so it fails in both directions: dropping a forward
    // (`cwd`, `model`, …) silently loses a documented per-task option, and
    // adding one changes the executor's input contract.
    expect(Object.keys(forwarded).sort()).toEqual([
      "activeModel",
      "agent",
      "agentConfig",
      "cwd",
      "execution",
      "model",
      "task",
      "toolCallId",
    ]);
    // The key set alone would still pass with the values swapped or dropped to
    // undefined, so the two the #114 discussion cares about are pinned by value.
    expect(forwarded.cwd).toBe("/tmp/work");
    expect(forwarded.model).toBe("anthropic/claude-opus-4.5");
    expect(forwarded.task).toBe("a");
    expect(forwarded.toolCallId).toBe("c");
  });

  it("forwards the same per-task shape to executeSubagent on the single-run path", async () => {
    discoverAgents.mockReturnValue([agentConfig()]);
    await subagent(register()).execute(
      "c",
      { agent: "reviewer", task: "t", model: "anthropic/claude-opus-4.5", cwd: "/tmp/work" },
      undefined,
      undefined,
      makeCtx(),
    );

    expect(executeSubagent).toHaveBeenCalledTimes(1);
    const calls = executeSubagent.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const forwarded = calls[0]![0];
    // The single path takes its arguments flat rather than nested under `tasks`,
    // so its key set differs from the parallel item's by exactly that: no
    // nesting, and `signal` / `events` / `onUpdate` carried per run.
    expect(Object.keys(forwarded).sort()).toEqual([
      "activeModel",
      "agent",
      "agentConfig",
      "cwd",
      "events",
      "execution",
      "model",
      "onUpdate",
      "signal",
      "task",
      "toolCallId",
    ]);
    expect(forwarded.cwd).toBe("/tmp/work");
    expect(forwarded.model).toBe("anthropic/claude-opus-4.5");
  });
});
