import type { RunOutcome, SubagentDetails, SubagentProgress, SubagentResult, SubagentToolCall } from "./types.js";
import { formatDuration, buildStatsLine, buildAgentLabel, buildOutcomeLine } from "./format.js";
import { block, row, type RowBlock, type RowSegment } from "./row-block.js";
import { renderToolCallLine } from "@pi-archimedes/core/tool-render";

type Theme = { fg: (token: string, text: string) => string; bold: (text: string) => string };

// The expanded view mixes two kinds of line and says which is which (see
// `row-block.ts`): a **row** (label, activity, the first line of an outcome) stays
// one line and fills the frame; a **block** (the stats line, the task text, the
// tool-call history, the output, the lines of an error after the first) keeps
// wrapping, because the expanded view is where all of it is meant to be readable
// (issue #112; its counterpart — the collapsed view cutting at the first line — is
// pinned in `tool-row.width-audit.test.ts`). The stats line is a block and not a
// row so the view reads on its own, without the reader collapsing back to the row
// to get the numbers back. They do live elsewhere too — `compact.ts` builds the
// identical `buildStatsLine`, `formatParallelResults` puts tools / tokens /
// seconds in the model-facing content, and `usage` reaches pi's `/session` — but
// every row is cut at the frame, so the tail of the stats (tokens, duration,
// cost) is exactly what a narrow terminal would drop from this view.

// ── Helpers ─────────────────────────────────────────────────────────────────

// A completed tool call renders with a status glyph (✓ ok / ✗ error) and its
// name coloured to match. Legacy string-form calls (old persisted sessions)
// carry no status, so they render as a neutral success line.
function formatToolCall(call: SubagentToolCall | string, theme: Theme): string {
  if (typeof call === "string") {
    return renderToolCallLine("success", call, "", theme);
  }
  const status = call.error ? "error" : "success";
  const suffix = call.argsPreview ? ": " + call.argsPreview : "";
  return renderToolCallLine(status, call.name, suffix, theme);
}

// The bottom of an expanded view. The *Run outcome* wins over the done/failed
// pair: a truncated answer is not a failed run, and labelling it "✗ Failed" is
// how a useful answer gets thrown away by whoever reads it.
//
// An error is often stderr or a thrown Error's message — the second kind never
// touched a stream (`dispatch.ts`'s `buildFailedResult` carries `err.message`, and
// `stream.ts` synthesises strings like "subagent failed with exit code N"). Either
// way it arrives with newlines in it, and as one `row` the view could only ever
// show its first line: `truncateRow` treats a newline as a hard boundary (see
// `row-block.ts`), which is right for the collapsed view (the three-rows-per-agent
// shape is pinned in `tool-row.width-audit.test.ts`) and wrong here: the expanded
// view is where everything is meant to be readable (issue #112), and a stack
// trace's last line is usually the informative one. So the first line stays the
// row it was, and the lines after it are handed over as one `block` — this repo's
// existing mechanism for "read this in full".
//
// The raw error is split *before* anything is coloured, and every line is
// coloured on its own. `theme.fg("error", "✗ " + error)` wraps the whole
// multi-line string in one span whose reset lands on the last line only, so
// every earlier line would be drawn — padding included — inside an open span.
// Measured against `wrapTextWithAnsi`: it re-opens the active codes at the start
// of a continuation line but never invents a reset at the end of one.
function outcomeSegments(
  data: { outcome?: RunOutcome | undefined; error: string | undefined },
  theme: Theme,
  // The segment to draw when there is nothing to report, rendered by the caller
  // rather than decided here, because the five call sites do not agree on it — and
  // they disagree per *branch*, not per builder: the finished view's single call
  // says `✗ Failed` (an `outcome` this build cannot name is not a success this
  // build may claim), while each streaming builder passes `✓ Done` from its
  // completed branch and `✗ Failed` from its failed one. So "nothing to report"
  // means something different at each site, and the `✓ Done` ones are why the
  // answer cannot be baked in here: `outcome` is optional on `SubagentProgress`
  // (`types.ts:38`; `SubagentResult` at `:70`, `SubagentRunReport` at `:134`), so a
  // run can report a terminal status with no outcome at all — every session
  // persisted before #103 / 8cf0d12 added the field — and a helper-wide
  // `✗ Failed` there would relabel a finished run a broken one.
  fallback: RowSegment,
): RowSegment[] {
  // Same precedence as `buildOutcomeLine` (`format.ts:101`): `error` is read first,
  // so a run that carries both reports the error and not the outcome. Pinned in
  // `expanded.test.ts` rather than re-decided here. It is also why neither streaming
  // branch may assume it has no error in hand: each opens on a completed *status* or
  // on any reported outcome, and either can arrive together with a multi-line one,
  // so a completed progress's error gets the same head-row-then-block treatment here
  // that the failed branch gives its own (#112).
  if (data.error) {
    // `/\r\n|\r|\n/`, not `"\n"`: `stream.ts` reads stderr as
    // `Buffer.concat(...).toString("utf-8").trim()` with no newline
    // normalisation, so a Windows child's `\r\n` arrives intact. pi-tui's
    // `wrapTextWithAnsi` splits on all three endings but `truncateRow` splits on
    // `"\n"`, so a `\r` left inside a row would be *drawn*, and a terminal that
    // honours a bare CR repaints the row from column 0.
    const [head, ...tail] = data.error.split(/\r\n|\r|\n/);
    const segments: RowSegment[] = [row(theme.fg("error", "✗ " + head))];
    // A tail of nothing but blanks gets no block: a synthesised error, or any
    // producer that does not `trim()` its stderr, can end in a newline, and
    // opening a block for that would add a blank row under every failed run.
    if (tail.some((line) => line.trim() !== "")) {
      segments.push(block(tail.map((line) => (line ? theme.fg("error", line) : "")).join("\n")));
    }
    return segments;
  }
  const line = buildOutcomeLine({ outcome: data.outcome, error: undefined }, theme);
  // The outcome vocabulary stays `buildOutcomeLine`'s and this helper still owns
  // the row decision; only "nothing to report" hands back the segment the caller
  // rendered for itself.
  return [line === undefined ? fallback : row(line)];
}

// ── Expanded completed result ───────────────────────────────────────────────

export function buildExpandedText(
  result: SubagentResult,
  progress: SubagentProgress | undefined,
  theme: Theme,
): RowSegment[] {
  const lines: RowSegment[] = [];

  lines.push(row(buildAgentLabel(result.agent, result.task, theme)));
  lines.push(row(""));

  // Stats line (same as compact view)
  const modelName = progress?.model ?? result.model;
  const modelLabel = modelName ? theme.fg("accent", modelName) : "";
  const statsLine = buildStatsLine({
    turns: result.usage.turns,
    toolCount: result.progressSummary?.toolCount,
    turnTokens: progress?.turnTokens,
    tokens: result.progressSummary?.tokens,
    durationMs: result.progressSummary?.durationMs,
    cost: result.usage.cost,
  }, theme);
  const statsParts = [modelLabel, statsLine].filter(Boolean);
  if (statsParts.length > 0) {
    // A block, not a row: the expanded view has to read on its own, so the
    // numbers cannot depend on the reader collapsing the row to get them back
    // however narrow the frame is.
    lines.push(block(statsParts.join(" ")));
  }

  // Task
  if (result.task) {
    lines.push(row(""));
    lines.push(block(theme.fg("dim", "Task: " + result.task)));
  }

  // Tool calls history
  const toolCalls = progress?.toolCalls;
  if (toolCalls && toolCalls.length > 0) {
    lines.push(row(""));
    for (const call of toolCalls) {
      lines.push(block(formatToolCall(call, theme)));
    }
  }

  // Output - show live streaming output or final output
  const outputText = progress?.output ?? result.finalOutput;
  if (outputText) {
    lines.push(row(""));
    // A block, uncapped: ADR 0020 is the precedent that this package does not cap
    // output where the reader has no other source for it. Read it precisely — ADR
    // 0020 governs the *tool-result content* the model reads, not this view — and
    // the same reasoning carries over: the answer shown here is the child's, and
    // nothing else spells it out for whoever is reading the transcript.
    lines.push(block(outputText));
  }

  // Error / outcome at the bottom
  if (result.error || result.outcome || result.exitCode === 0) {
    lines.push(row(""));
    if (result.outcome || result.error) {
      // The fallback covers exactly one case here: an `outcome` this build cannot
      // name, which leaves `buildOutcomeLine` with nothing to return. It is
      // Failed, because a run whose ending this code cannot read is not a success
      // this code may claim. The never-settled legacy shape — no outcome, no
      // error, a non-zero exit — is not this fallback's: the `else` below prints
      // it. The streaming builders' completed branch passes ✓ Done instead (see
      // `outcomeSegments`' third parameter for why it is not decided here).
      lines.push(
        ...outcomeSegments(
          { outcome: result.outcome, error: result.error },
          theme,
          row(theme.fg("error", "✗ Failed")),
        ),
      );
    } else {
      lines.push(row(theme.fg("success", "✓ Done")));
    }
  } else {
    lines.push(row(""));
    lines.push(row(theme.fg("error", "✗ Failed")));
  }

  return lines;
}

export function renderExpanded(
  rows: RowBlock,
  result: SubagentResult,
  progress: SubagentProgress | undefined,
  theme: Theme,
): RowBlock {
  rows.setSegments(buildExpandedText(result, progress, theme));
  return rows;
}

// ── Expanded streaming progress ─────────────────────────────────────────────

export function renderProgressExpanded(
  rows: RowBlock,
  progress: SubagentProgress,
  theme: Theme,
): RowBlock {
  const lines: RowSegment[] = [];

  lines.push(row(buildAgentLabel(progress.agent, progress.task, theme)));
  lines.push(row(""));

  // Stats line (same as compact view) — a block: see buildExpandedText.
  const modelLabel = progress.model ? theme.fg("accent", progress.model) : "";
  const statsLine = buildStatsLine({
    turns: progress.turnCount,
    toolCount: progress.toolCount,
    turnTokens: progress.turnTokens,
    tokens: progress.tokens,
    durationMs: progress.durationMs,
    cost: progress.cost,
  }, theme);
  const statsParts = [modelLabel, statsLine].filter(Boolean);
  if (statsParts.length > 0) {
    lines.push(block(statsParts.join(" ")));
  }

  // Task
  if (progress.task) {
    lines.push(row(""));
    lines.push(block(theme.fg("dim", "Task: " + progress.task)));
  }

  // Tool calls history
  if (progress.toolCalls && progress.toolCalls.length > 0) {
    lines.push(row(""));
    for (const call of progress.toolCalls) {
      lines.push(block(formatToolCall(call, theme)));
    }
  }

  // Activity (current tool, marked with the running glyph ▸)
  if (progress.currentTool) {
    lines.push(row(""));
    const argsPreview = progress.currentToolArgs ?? "";
    const durationPart = progress.currentToolStartedAt
      ? " | " + formatDuration(Date.now() - progress.currentToolStartedAt)
      : "";
    const suffix = (argsPreview ? ": " + argsPreview : "") + durationPart;
    lines.push(row(renderToolCallLine("running", progress.currentTool, suffix, theme)));
  }

  // Status at bottom. Which fallback each branch hands the helper, and why the
  // helper is not the one to decide it, is written once above `outcomeSegments`.
  if (progress.status === "completed" || progress.outcome) {
    lines.push(row(""));
    // `✓ Done`: this branch's agent reached a terminal state, so a run with nothing
    // to name its outcome by is finished work here — the ✗ below would bury it.
    lines.push(...outcomeSegments(
      { outcome: progress.outcome, error: progress.error },
      theme,
      row(theme.fg("success", "✓ Done")),
    ));
  } else if (progress.status === "failed") {
    lines.push(row(""));
    // The only branch here that may call a run broken, so it passes `✗ Failed`.
    lines.push(...outcomeSegments(
      { outcome: undefined, error: progress.error },
      theme,
      row(theme.fg("error", "✗ Failed")),
    ));
  }

  rows.setSegments(lines);
  return rows;
}

// ── Expanded parallel streaming progress ────────────────────────────────────

export function buildProgressExpandedText(
  progress: SubagentProgress,
  theme: Theme,
): RowSegment[] {
  const lines: RowSegment[] = [];

  lines.push(row(buildAgentLabel(progress.agent, progress.task, theme)));
  lines.push(row(""));

  // Stats line (same as compact view) — a block: see buildExpandedText.
  const modelLabel = progress.model ? theme.fg("accent", progress.model) : "";
  const statsLine = buildStatsLine({
    turns: progress.turnCount,
    toolCount: progress.toolCount,
    turnTokens: progress.turnTokens,
    tokens: progress.tokens,
    durationMs: progress.durationMs,
    cost: progress.cost,
  }, theme);
  const statsParts = [modelLabel, statsLine].filter(Boolean);
  if (statsParts.length > 0) {
    lines.push(block(statsParts.join(" ")));
  }

  // Task
  if (progress.task) {
    lines.push(row(""));
    lines.push(block(theme.fg("dim", "Task: " + progress.task)));
  }

  // Tool calls history
  if (progress.toolCalls && progress.toolCalls.length > 0) {
    lines.push(row(""));
    for (const call of progress.toolCalls) {
      lines.push(block(formatToolCall(call, theme)));
    }
  }

  // Activity
  if (progress.currentTool) {
    const argsPreview = progress.currentToolArgs ?? "";
    const durationPart = progress.currentToolStartedAt
      ? " | " + formatDuration(Date.now() - progress.currentToolStartedAt)
      : "";
    let line = theme.fg("muted", progress.currentTool);
    if (argsPreview) {
      line += theme.fg("dim", ": " + argsPreview);
    }
    if (durationPart) {
      line += theme.fg("dim", durationPart);
    }
    lines.push(row(""));
    lines.push(row(line));
  }

  // Status at bottom — the same pair of branches `renderProgressExpanded` draws for
  // the single running agent, here as one block of the parallel view. What each
  // branch passes, and why the helper cannot decide it, is written once above
  // `outcomeSegments`.
  if (progress.status === "completed" || progress.outcome) {
    lines.push(row(""));
    // `✓ Done`, and never the failed branch's segment: this block claims its agent
    // finished, and a batch read as failed is a batch whose answers get discarded.
    lines.push(...outcomeSegments(
      { outcome: progress.outcome, error: progress.error },
      theme,
      row(theme.fg("success", "✓ Done")),
    ));
  } else if (progress.status === "failed") {
    lines.push(row(""));
    // `✗ Failed`: this branch got a broken run, the only one allowed to say so.
    lines.push(...outcomeSegments(
      { outcome: undefined, error: progress.error },
      theme,
      row(theme.fg("error", "✗ Failed")),
    ));
  }

  return lines;
}
