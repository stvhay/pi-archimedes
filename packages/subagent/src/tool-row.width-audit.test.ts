/**
 * Row-width audit for the `subagent` **tool rows** (the transcript rows, not the
 * `/agents` overlay — that one is `agent-panel.width-audit.test.ts`).
 *
 * The defect this audits: a `bash` row runs to the right edge of the terminal,
 * because pi truncates at the width it is actually rendering at
 * (`VisualLinePreview` / `truncateToVisualLines`, which take `render(width)`'s
 * width). Our rows ran through a hardcoded character cap — `truncLine(task, 60)`
 * — so on an 200-column terminal the row died at about a third of the frame.
 *
 * The invariant, at every width pi can hand a component:
 *
 *   1. one logical line per row — a long task must not become a wrapped block
 *      (pi-tui's `Text.render(width)` wraps, which is why the rows cannot just
 *      be left uncapped inside a `Text`);
 *   2. a truncated row **fills the frame**: its drawn width is the render width
 *      (± one cell: a wide glyph that would straddle the boundary is dropped by
 *      `sliceByColumn`'s strict mode, so a CJK/emoji row can land one cell short);
 *   3. no rendered row is wider than the frame, whatever the content — ASCII,
 *      CJK-heavy or emoji-heavy;
 *   4. and the row is *not* capped at 60: at a 200-column width the content is
 *      far longer than the old cap.
 *
 * Paths exercised (all reached through the registered tool definition, so the
 * audit walks the real render path rather than a helper it hopes is on it):
 *
 *   renderCall                                   — the call row
 *   handleToolStart → currentToolArgs            — the args a row is drawn from
 *   renderResult → renderSubagentResult
 *     ├─ results[0]                  → compact single      (3 rows)
 *     ├─ progress[0]                 → compact progress    (3 rows, streaming)
 *     ├─ results[0..n]               → compact parallel    (3 rows per agent)
 *     ├─ progress[0..n]              → compact parallel progress
 *     ├─ expanded: results[0]        → expanded single     (rows + wrapped blocks)
 *     ├─ expanded: progress[0]       → expanded progress
 *     └─ expanded: results/progress  → expanded parallel
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { Box, Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { handleToolStart } from "./handlers.js";
import type { StreamState } from "./types.js";
import { readUsage } from "./usage.js";

const discoverAgents = vi.hoisted(() => vi.fn());
const executeSubagent = vi.hoisted(() => vi.fn());
const executeParallel = vi.hoisted(() => vi.fn());

vi.mock("./agents.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  discoverAgents,
}));
vi.mock("./execute.js", () => ({ executeSubagent, executeParallel }));

const { registerSubagent } = await import("./index.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The task from the maintainer's screenshot: long, and ASCII. */
const ASCII_TASK =
  ("Handle the review cycle for PR #107 in /home/daniel/Coding/Javascript/pi-archimedes and report every finding with a file:line reference. ").repeat(2);
/** East-asian text: every glyph is two cells, so a character cap is meaningless. */
const CJK_TASK = "検証サイクルをPR107で実行して結果を報告".repeat(8);
/** Emoji: vary in width and carry joiners, the classic over-flow case. */
const EMOJI_TASK = "🚀 ship 🔥 the ✅ change 🧪 with 📦 care 🎯 now ".repeat(6);

const TASKS: Array<{ label: string; task: string; slack: number }> = [
  // `slack` is how many cells short of the frame a truncated row may legitimately
  // land: 0 for ASCII, 1 when a double-width glyph sits on the boundary.
  { label: "ascii", task: ASCII_TASK, slack: 0 },
  { label: "cjk", task: CJK_TASK, slack: 1 },
  { label: "emoji", task: EMOJI_TASK, slack: 1 },
];

const WIDTHS = [200, 120, 80, 60, 40];

/** A theme that emits real SGR sequences, so measured rows carry ANSI. */
const TOKEN_SGR: Record<string, string> = {
  dim: "\x1b[2m",
  muted: "\x1b[90m",
  error: "\x1b[31m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  accent: "\x1b[36m",
  toolTitle: "\x1b[34m",
};
const theme = {
  fg: (token: string, text: string) => `${TOKEN_SGR[token] ?? "\x1b[37m"}${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

// ── The registered tool, with its real renderers ────────────────────────────

interface ToolDef {
  name: string;
  renderCall: (args: unknown, theme: unknown, ctx: unknown) => RowComponent;
  renderResult: (
    result: unknown,
    options: unknown,
    theme: unknown,
    context: unknown,
  ) => RowComponent;
}

interface RowComponent {
  render(width: number): string[];
  invalidate(): void;
}

function registerTool(): ToolDef {
  const tools: ToolDef[] = [];
  const pi = {
    registerTool: (def: ToolDef) => tools.push(def),
    on: () => {},
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
  };
  registerSubagent(pi as never);
  const def = tools.find((t) => t.name === "subagent");
  if (!def) throw new Error("subagent tool was not registered");
  return def;
}

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    agent: "general",
    task: ASCII_TASK,
    exitCode: 0,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 3 },
    model: "anthropic/claude-opus-4.5",
    finalOutput: undefined,
    error: undefined,
    progress: undefined,
    progressSummary: { toolCount: 5, tokens: 1500, durationMs: 3000 },
    outcome: "completed",
    ...overrides,
  };
}

function makeProgress(overrides: Record<string, unknown> = {}) {
  return {
    agent: "general",
    status: "running",
    task: ASCII_TASK,
    currentTool: "bash",
    currentToolArgs: `git diff HEAD~5 --stat ${"-v".repeat(40)}`,
    currentToolStartedAt: Date.now() - 2000,
    toolCount: 2,
    inputTokens: 50,
    outputTokens: 30,
    tokens: 80,
    cost: 0.005,
    durationMs: 1000,
    error: undefined,
    model: "anthropic/claude-opus-4.5",
    output: undefined,
    recentOutput: undefined,
    toolCalls: [
      { name: "read", argsPreview: `packages/subagent/src/${"agent".repeat(12)}.ts`, error: false },
      { name: "bash", argsPreview: `pnpm -r exec -- tsc --noEmit ${"—".repeat(30)}`, error: true },
    ],
    ...overrides,
  };
}

/** Every way the tool can be asked to draw a row family. */
function rowComponents(task: string): Array<{ path: string; component: () => RowComponent }> {
  const tool = registerTool();
  const result = makeResult({ task });
  const progress = makeProgress({ task });
  const parallel = {
    mode: "parallel",
    results: [makeResult({ task }), makeResult({ agent: "reviewer", task, exitCode: 1, error: `spawn failed: ${"x".repeat(120)}` })],
    progress: undefined,
  };
  const parallelProgress = {
    mode: "parallel",
    results: [],
    progress: [makeProgress({ task }), makeProgress({ agent: "reviewer", task, currentTool: undefined })],
  };
  const streaming = { mode: "single", results: [], progress: [makeProgress({ task })] };
  const ctx = () => ({ state: {}, invalidate: () => {} });

  return [
    {
      path: "renderCall",
      component: () => tool.renderCall({ agent: "general", tasks: undefined }, theme, ctx()),
    },
    {
      path: "compact:single",
      component: () =>
        tool.renderResult(
          { content: [], details: { mode: "single", results: [result], progress: undefined }, isError: false },
          { expanded: false },
          theme,
          ctx(),
        ),
    },
    {
      path: "compact:progress",
      component: () =>
        tool.renderResult(
          { content: [], details: streaming, isError: false },
          { expanded: false },
          theme,
          ctx(),
        ),
    },
    {
      path: "compact:parallel",
      component: () =>
        tool.renderResult(
          { content: [], details: parallel, isError: false },
          { expanded: false },
          theme,
          ctx(),
        ),
    },
    {
      path: "compact:parallel-progress",
      component: () =>
        tool.renderResult(
          { content: [], details: parallelProgress, isError: false },
          { expanded: false },
          theme,
          ctx(),
        ),
    },
    {
      path: "expanded:single",
      component: () =>
        tool.renderResult(
          { content: [], details: { mode: "single", results: [result], progress: [makeProgress({ task })] }, isError: false },
          { expanded: true },
          theme,
          ctx(),
        ),
    },
    {
      path: "expanded:progress",
      component: () =>
        tool.renderResult(
          { content: [], details: streaming, isError: false },
          { expanded: true },
          theme,
          ctx(),
        ),
    },
    {
      path: "expanded:parallel",
      component: () =>
        tool.renderResult(
          { content: [], details: parallel, isError: false },
          { expanded: true },
          theme,
          ctx(),
        ),
    },
  ];
}

// ── Measurement ─────────────────────────────────────────────────────────────

/** The drawn text of a rendered line, with trailing padding removed. */
function content(line: string): string {
  return stripTerminalSequences(line).replace(/\s+$/, "");
}

/**
 * A row is *full width* when the text it draws reaches the right edge — the
 * property the maintainer asked for ("notice how the bash tool goes full
 * width"). Padding spaces do not count: they are removed by `content()`.
 */
function isFullWidth(line: string, width: number, slack: number): boolean {
  const drawn = visibleWidth(content(line));
  return drawn >= width - slack && drawn <= width;
}

interface RowReport {
  path: string;
  task: string;
  width: number;
  index: number;
  line: string;
  drawn: number;
}

function rowsOver(width: number): RowReport[] {
  const over: RowReport[] = [];
  for (const fixture of TASKS) {
    for (const entry of rowComponents(fixture.task)) {
      const lines = entry.component().render(width);
      lines.forEach((line, index) => {
        const drawn = visibleWidth(stripTerminalSequences(line));
        if (drawn > width) over.push({ path: entry.path, task: fixture.label, width, index, line, drawn });
      });
    }
  }
  return over;
}

const summarize = (rows: RowReport[]) =>
  rows
    .slice(0, 4)
    .map((r) => `${r.path}/${r.task}@${r.width}:row${r.index}=${r.drawn} ${JSON.stringify(content(r.line).slice(0, 40))}`)
    .join("\n  ");

// ── The audit ───────────────────────────────────────────────────────────────

describe("subagent tool rows: width audit", () => {
  beforeEach(() => {
    discoverAgents.mockReturnValue([]);
  });

  it("never draws a row wider than the frame, at any width or content", () => {
    const over: RowReport[] = [];
    for (const width of WIDTHS) over.push(...rowsOver(width));
    expect(over, `${over.length} over-frame row(s):\n  ${summarize(over)}`).toEqual([]);
  });

  it("renders the task row as ONE row that fills the frame, at every width", () => {
    const failures: string[] = [];
    for (const width of WIDTHS) {
      for (const fixture of TASKS) {
        const compact = rowComponents(fixture.task).find((e) => e.path === "compact:single")!;
        const lines = compact.component().render(width);
        const label = lines[0] ?? "";
        const drawn = visibleWidth(content(label));
        if (lines.length !== 3) {
          failures.push(`${fixture.label}@${width}: compact block is ${lines.length} rows, expected 3 (one per logical line):\n  ${JSON.stringify(lines.map(content))}`);
        } else if (!isFullWidth(label, width, fixture.slack)) {
          failures.push(
            `${fixture.label}@${width}: task row draws ${drawn} of ${width} columns (slack ${fixture.slack}): ${JSON.stringify(content(label))}`,
          );
        } else if (!content(label).endsWith("...")) {
          failures.push(`${fixture.label}@${width}: truncated task row lost its ellipsis: ${JSON.stringify(content(label))}`);
        }
      }
    }
    expect(failures, failures.join("\n  ")).toEqual([]);
  });

  it("is not capped at 60 characters: a wide frame carries a long task", () => {
    for (const width of WIDTHS) {
      for (const fixture of TASKS) {
        const lines = rowComponents(fixture.task)
          .find((e) => e.path === "compact:single")!
          .component()
          .render(width);
        const drawn = visibleWidth(content(lines[0] ?? ""));
        // A 60-character cap tops out around 69 columns however wide the frame
        // is, so anything at (or near) the frame cannot be the old cap.
        expect(
          drawn,
          `task row capped early at ${width} columns: ${JSON.stringify(content(lines[0] ?? ""))}`,
        ).toBeGreaterThanOrEqual(width - fixture.slack);
      }
    }
  });

  it("fills the frame on the other row family members too (args, error, activity)", () => {
    const longError = `spawn failed: ${"command not found".repeat(20)}`;
    const cases: Array<{ path: string; details: unknown; row: number }> = [
      // Activity row carries the current tool's args while streaming.
      { path: "compact:progress", details: { mode: "single", results: [], progress: [makeProgress({ currentToolArgs: longError })] }, row: 2 },
      // Activity row carries the error for a failed run.
      {
        path: "compact:single",
        details: { mode: "single", results: [makeResult({ outcome: undefined, exitCode: 1, error: longError })], progress: undefined },
        row: 2,
      },
      // Activity row carries the last completed call's args.
      {
        path: "compact:progress",
        details: {
          mode: "single",
          results: [],
          progress: [makeProgress({ currentTool: undefined, currentToolArgs: undefined, toolCalls: ["x".repeat(400)] })],
        },
        row: 2,
      },
      // The expanded view's own label row.
      {
        path: "expanded:single",
        details: { mode: "single", results: [makeResult()], progress: undefined },
        row: 0,
      },
    ];

    for (const width of WIDTHS) {
      for (const c of cases) {
        const component = registerTool().renderResult(
          { content: [], details: c.details, isError: false },
          { expanded: c.path.startsWith("expanded") },
          theme,
          { state: {}, invalidate: () => {} },
        );
        const lines = component.render(width);
        const drawn = visibleWidth(content(lines[c.row] ?? ""));
        expect(
          drawn,
          `${c.path} row ${c.row} @${width} draws ${drawn} of ${width}: ${JSON.stringify(content(lines[c.row] ?? ""))}`,
        ).toBeGreaterThanOrEqual(width - 1);
      }
    }
  });

  // A task is free text and an error is usually stderr, so both arrive carrying
  // newlines. The collapsed view is a fixed three rows per agent; if a newline
  // inside one field became a row of its own, a failed child's stack trace would
  // push the collapsed block open — the old `truncLine` treated a newline as a
  // hard boundary for exactly this reason. `RowBlock.setText` splits every
  // newline, so the compact builders have to hand over one `row` segment per
  // field they mean to be one row.
  it("keeps a multiline task or error to three rows per agent (collapsed)", () => {
    const multilineTask = "Review the change\nRun the full suite\nReport every finding " + "x".repeat(200);
    const multilineError = "spawn failed\ncommand not found: pnpm\nsee the log " + "y".repeat(200);
    const hidden = ["Run the full suite", "command not found: pnpm"];

    const taskProgress = makeProgress({ task: multilineTask });
    const cases: Array<{ label: string; details: unknown; rows: number }> = [
      {
        label: "compact:single/task",
        details: { mode: "single", results: [makeResult({ task: multilineTask })], progress: undefined },
        rows: 3,
      },
      {
        label: "compact:single/error",
        details: {
          mode: "single",
          results: [makeResult({ task: multilineTask, outcome: undefined, exitCode: 1, error: multilineError })],
          progress: undefined,
        },
        rows: 3,
      },
      { label: "compact:progress", details: { mode: "single", results: [], progress: [taskProgress] }, rows: 3 },
      {
        label: "compact:parallel",
        details: {
          mode: "parallel",
          results: [
            makeResult({ task: multilineTask }),
            makeResult({ agent: "reviewer", task: multilineTask, outcome: undefined, exitCode: 1, error: multilineError }),
          ],
          progress: undefined,
        },
        rows: 6,
      },
      {
        label: "compact:parallel-progress",
        details: {
          mode: "parallel",
          results: [],
          progress: [taskProgress, makeProgress({ agent: "reviewer", task: multilineTask })],
        },
        rows: 6,
      },
    ];

    const failures: string[] = [];
    for (const width of WIDTHS) {
      for (const c of cases) {
        const lines = registerTool()
          .renderResult(
            { content: [], details: c.details, isError: false },
            { expanded: false },
            theme,
            { state: {}, invalidate: () => {} },
          )
          .render(width);
        const drawn = lines.map(content);
        if (lines.length !== c.rows) {
          failures.push(`${c.label}@${width}: ${lines.length} rows, expected ${c.rows}:\n  ${JSON.stringify(drawn)}`);
        }
        for (const text of hidden) {
          if (drawn.some((d) => d.includes(text))) {
            failures.push(`${c.label}@${width}: ${JSON.stringify(text)} leaked into a row of its own:\n  ${JSON.stringify(drawn)}`);
          }
        }
        lines.forEach((line, index) => {
          if (visibleWidth(stripTerminalSequences(line)) > width) {
            failures.push(`${c.label}@${width}: row ${index} over the frame`);
          }
        });
        // The row was cut at the newline, and says so.
        if (!(drawn[0] ?? "").endsWith("...")) {
          failures.push(`${c.label}@${width}: label row lost its cut marker: ${JSON.stringify(drawn[0])}`);
        }
      }
    }
    expect(failures, failures.join("\n  ")).toEqual([]);
  });

  // The row layer can only draw what it is handed. `currentToolArgs` is produced
  // by the streaming handler, and a preview cap there is a second, invisible
  // character cap: pi's own bash row passes the command through whole and cuts
  // it at the render width (`formatShellCall`), so anything shorter than the
  // frame has to come from the frame.
  it("fills the frame with args that arrive through handleToolStart", () => {
    const longCommand = `pnpm exec vitest run packages/subagent ${"--reporter=verbose ".repeat(15)}`;
    const state: StreamState = {
      toolCount: 0,
      turnCount: 0,
      usage: readUsage(undefined),
      turnUsage: readUsage(undefined),
      partialUsage: readUsage(undefined),
      provider: undefined,
      streamingOutput: undefined,
      streamingParts: new Map(),
      outputLimit: undefined,
      currentTool: undefined,
      currentToolArgs: undefined,
      currentToolStartedAt: undefined,
      model: undefined,
      accumulatedOutput: [],
      recentOutput: [],
      toolCalls: [],
      finalOutput: undefined,
    };
    handleToolStart(state, { type: "tool_execution_start", toolCallId: "wide-bash", toolName: "bash", args: { command: longCommand } });
    expect(state.currentToolArgs?.length, "handler threw away args the frame could draw")
      .toBeGreaterThanOrEqual(longCommand.length);

    const details = {
      mode: "single",
      results: [],
      progress: [makeProgress({ currentToolArgs: state.currentToolArgs, currentToolStartedAt: undefined })],
    };
    for (const width of WIDTHS) {
      const lines = registerTool()
        .renderResult({ content: [], details, isError: false }, { expanded: false }, theme, {
          state: {},
          invalidate: () => {},
        })
        .render(width);
      const drawn = visibleWidth(content(lines[2] ?? ""));
      expect(
        drawn,
        `args row @${width} draws ${drawn} of ${width}: ${JSON.stringify(content(lines[2] ?? ""))}`,
      ).toBeGreaterThanOrEqual(width - 1);
    }
  });

  // pi keeps the component a tool returned (`ToolExecutionComponent`
  // .resultRendererComponent) and hands it back as `context.lastComponent` on
  // the next frame, then calls `render(width)` whenever it draws. Two frames can
  // therefore differ only in width (a terminal resize) or only in content (a
  // streaming tick at the same width), and the component must not answer either
  // from the frame before.
  it("keeps a reused component honest across a resize and a content change", () => {
    const tool = registerTool();
    const context: Record<string, unknown> = { state: {}, invalidate: () => {} };
    const draw = (task: string, expanded = false) =>
      tool.renderResult(
        { content: [], details: { mode: "single", results: [makeResult({ task })], progress: undefined }, isError: false },
        { expanded },
        theme,
        context,
      );

    // Same instance across frames — otherwise this test proves nothing.
    draw("first task ".repeat(30));
    const first = context.lastComponent;
    draw("first task ".repeat(30));
    expect(context.lastComponent).toBe(first);

    // A resize: pi does not re-run the renderer when the terminal changes width,
    // it just calls `render(newWidth)` on the component it kept. So the frames
    // below come from one draw, and only the cache separates them.
    for (const [wide, narrow] of [[200, 40], [120, 60]] as const) {
      const component = draw("resize probe ".repeat(30));
      const wideLines = component.render(wide);
      const narrowLines = component.render(narrow);
      expect(wideLines.length, `no rows at ${wide}`).toBeGreaterThan(0);
      expect(narrowLines, `a resize served the cached ${wide}-column frame`)
        .not.toEqual(wideLines);
      for (const [width, lines] of [[wide, wideLines], [narrow, narrowLines]] as const) {
        expect(visibleWidth(content(lines[0] ?? "")), `row not cut at ${width}`)
          .toBeGreaterThanOrEqual(width - 1);
      }
      // And the same width again is stable, not re-laid out into something else.
      expect(component.render(wide)).toEqual(wideLines);
    }

    // A streaming tick: new content, same width — the cached frame must go.
    draw("the first run's task text ".repeat(10));
    const before = draw("the first run's task text ".repeat(10)).render(120);
    const after = draw("a second run's task text ".repeat(10)).render(120);
    expect(after).not.toEqual(before);
    expect(stripTerminalSequences(after[0] ?? "")).toContain("second run");

    // invalidate() is part of the component contract (pi calls it on a theme
    // change through `Tui.invalidate()`); it must not serve the old frame.
    const kept = first as { render(width: number): string[]; invalidate(): void };
    kept.invalidate();
    expect(kept.render(120)).toEqual(after);
  });

  // The collapsed view is a summary: one row per line, cut at the frame. The
  // expanded view is where the run is meant to be read in full (ADR 0020), so a
  // line that carries content and no second copy of it — the stats line: turns,
  // tools, tokens, duration, cost — has to keep wrapping there. As a row it is
  // cut at the frame, and below ~64 columns the tail (tokens, duration, cost)
  // disappeared with nothing else showing it, which is content #108 would have
  // made unreachable.
  it("loses no stat in the expanded view, however narrow the frame", () => {
    const stats = { toolCount: 5, tokens: 1500, durationMs: 3200 };
    const details = { mode: "single", results: [makeResult({ progressSummary: stats })], progress: undefined };
    // What the stats line carries. Compared with whitespace removed, because a
    // wrapped row may break a stat across rows.
    const carried = ["⟳3", "5tools", "2ktok", "3s", "$0.01"];
    const failures: string[] = [];

    for (const width of WIDTHS) {
      const lines = registerTool()
        .renderResult({ content: [], details, isError: false }, { expanded: true }, theme, {
          state: {},
          invalidate: () => {},
        })
        .render(width);
      const drawn = lines.map(content).join("").replace(/\s+/g, "");
      for (const stat of carried) {
        if (!drawn.includes(stat)) {
          failures.push(`@${width}: expanded view lost ${stat}:\n  ${JSON.stringify(lines.map(content))}`);
        }
      }
      for (const line of lines) {
        if (visibleWidth(stripTerminalSequences(line)) > width) failures.push(`@${width}: row over the frame`);
      }
    }
    // The collapsed view stays a summary: the same content is cut there, on
    // purpose — this asserts the two views did not converge on the same shape.
    const compact = registerTool()
      .renderResult({ content: [], details, isError: false }, { expanded: false }, theme, {
        state: {},
        invalidate: () => {},
      })
      .render(40);
    expect(compact).toHaveLength(3);
    expect(content(compact[1] ?? "")).toContain("...");

    expect(failures, failures.join("\n  ")).toEqual([]);
  });

  // A loaded runner, not the content, is what costs time here. Across 20 full-suite
  // runs this test measured ~3.5 s idle, but 4.4–12.9 s *uncapped* while the repo's
  // own type-check looped over it (3–5 `tsc` workers on 8 cores), and the five runs
  // vitest cut at its 5 s default recorded 6.1 / 6.7 / 10.0 / 10.8 / 14.9 s — it
  // failed 5 of 5 pre-fix loaded runs, which is issue #131. 30 s clears the worst
  // episode measured (12932 ms) with room to spare while still bounding a hang.
  // `numRuns` is deliberately untouched: shrinking the generator's coverage is a
  // separate decision from giving a slow-but-correct test room to finish.
  it("holds the invariant for arbitrary content (fast-check)", { timeout: 30_000 }, () => {
    const widths = [200, 120, 80, 60, 40];
    // Wide-character and emoji content, plus whatever else the generator likes.
    // Long by construction: a short string is never truncated, so a generator
    // that mostly produces short ones proves nothing about the cut.
    const wideChars = fc.constantFrom(...["\u3040", "\u30ff", "\u4e00", "\u65e5", "\u884c", "\uff5e", "🚀", "🔥", "✅", "🧪", "📦", "a", " ", "z"]);
    const wideTask = fc.array(wideChars, { minLength: 60, maxLength: 200 }).map((parts) => parts.join(""));
    fc.assert(
      fc.property(wideTask, (task) => {
        expect(visibleWidth(task)).toBeGreaterThanOrEqual(60); // long enough to cut
        for (const width of widths) {
          for (const line of rowComponents(task)
            .filter((e) => e.path !== "renderCall")
            .flatMap((e) => e.component().render(width))) {
            if (visibleWidth(stripTerminalSequences(line)) > width) return false;
          }
        }
        return true;
      }),
      { numRuns: 50 },
    );

    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 400 }), (error) => {
        for (const width of widths) {
          const details = {
            mode: "single",
            results: [makeResult({ outcome: undefined, exitCode: 1, error })],
            progress: undefined,
          };
          const component = registerTool().renderResult(
            { content: [], details, isError: true },
            { expanded: false },
            theme,
            { state: {}, invalidate: () => {} },
          );
          for (const line of component.render(width)) {
            if (visibleWidth(stripTerminalSequences(line)) > width) return false;
          }
        }
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it("still fits inside pi's own tool shell (Container → Box padding)", () => {
    for (const width of WIDTHS) {
      const shell = new Container();
      const box = new Box(1, 1, (t) => `\x1b[40m${t}\x1b[0m`);
      box.addChild(rowComponents(ASCII_TASK).find((e) => e.path === "compact:single")!.component());
      shell.addChild(box);
      const lines = shell.render(width);
      const tooWide: RowReport[] = lines
        .map((line, index) => ({
          path: "shell",
          task: "ascii",
          width,
          index,
          line,
          drawn: visibleWidth(stripTerminalSequences(line)),
        }))
        .filter((r) => r.drawn > width);
      expect(
        tooWide,
        `rows overflow pi's shell at ${width}:\n  ${summarize(tooWide)}`,
      ).toEqual([]);
      expect(lines.length).toBeGreaterThan(0);
    }
  });
});
