import type { RunOutcome, SubagentDetails, SubagentProgress, SubagentResult, SubagentToolCall, SubagentToolResult } from "./types.js";
import { formatDuration, buildStatsLine, buildAgentLabel, buildOutcomeLine } from "./format.js";
import { row, type RowSegment, type RowSink } from "./row-block.js";
import { renderToolCallLine } from "@pi-archimedes/core/tool-render";

type Theme = { fg: (token: string, text: string) => string; bold: (text: string) => string };
type RenderContext = { state: Record<string, unknown>; invalidate: () => void };

// Re-exported so callers and tests describe the sink the same way the builders do.
export type { RowSink };

// ── Activity line builder ───────────────────────────────────────────────────

// The builders below hand back whole content, never a fixed-length preview: the
// row each line lands on is cut at the width pi renders at (`RowBlock`,
// `row-block.ts`), so a long task or error fills the frame instead of stopping at
// 60 or 80 characters.
interface ActivityData {
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentToolStartedAt: number | undefined;
  finalOutput: string | undefined;
  status: "running" | "completed" | "failed" | undefined;
  /** The *Run outcome*, when the run reached one — shown instead of Done/Failed. */
  outcome?: RunOutcome | undefined;
  error: string | undefined;
  toolCalls?: (SubagentToolCall | string)[] | undefined;
}

export function buildActivityLine(
  data: ActivityData,
  theme: Theme,
): string {
  if (data.error) {
    return theme.fg("error", "✗ " + data.error);
  }

  // A finished run reports its outcome: Done / Truncated / Aborted. Truncated and
  // Aborted are not the old "Failed" — the answer may be perfectly good, just
  // partial, and a cancelled run was cancelled on purpose.
  if (data.outcome) {
    const line = buildOutcomeLine({ outcome: data.outcome, error: undefined }, theme);
    if (line) return line;
  }

  // Finished subagents always show their final status — never a stale
  // tool call from history. This keeps compact view consistent with
  // expanded view ("✓ Done" / "✗ Failed" at the bottom).
  if (data.status === "completed") {
    return theme.fg("success", "✓ Done");
  }
  if (data.status === "failed") {
    return theme.fg("error", "✗ Failed");
  }

  // Running: show the current tool with the running glyph ▸ + live duration.
  if (data.currentTool) {
    const argsPreview = data.currentToolArgs ?? "";
    const durationPart = data.currentToolStartedAt
      ? " | " + formatDuration(Date.now() - data.currentToolStartedAt)
      : "";
    const suffix = (argsPreview ? ": " + argsPreview : "") + durationPart;
    return renderToolCallLine("running", data.currentTool, suffix, theme);
  }

  // Running, no active tool: show the most recently completed tool call with
  // its status glyph (✓ ok / ✗ error) and matching name colour.
  if (data.toolCalls && data.toolCalls.length > 0) {
    const lastCall = data.toolCalls[data.toolCalls.length - 1];
    if (lastCall) {
      if (typeof lastCall === "string") {
        return renderToolCallLine("success", lastCall, "", theme);
      }
      const status = lastCall.error ? "error" : "success";
      const suffix = lastCall.argsPreview ? ": " + lastCall.argsPreview : "";
      return renderToolCallLine(status, lastCall.name, suffix, theme);
    }
  }

  // Running, no tool history: show first line of streamed output (▸, muted).
  if (data.finalOutput) {
    const firstLine = data.finalOutput.split("\n")[0] ?? "";
    return renderToolCallLine("running", firstLine, "", theme);
  }

  // Running, no info yet
  if (data.status === "running") {
    return renderToolCallLine("running", "Starting...", "", theme);
  }

  return "";
}

// ── Status glyph ────────────────────────────────────────────────────────────


// ── Compact single agent ────────────────────────────────────────────────────

type AgentBlockData = {
  agentName: string;
  task: string | undefined;
  model: string | undefined;
  statsData: Parameters<typeof buildStatsLine>[0];
  activity: ActivityData;
};

// Shared 3-line agent block used by both the single and parallel compact
// views so they render identically:
//   <agent>: <task>
//   <model> · <stats>
//   <activity>          (status lives here — "✓ Done" / "✗ Failed" / ▸ tool)
// Each field is handed over as its own `row` segment, so it stays one row of the
// rendered frame however wide the frame is. Handing the three over as one string
// would not do that: a task is free text and an error is usually stderr, so both
// carry newlines, and `setText` reads every newline as the start of a new row —
// which would push a failed child's stack trace open across the collapsed block.
// `truncateRow` cuts the row at the first newline and marks it with the ellipsis,
// which is the boundary the old character-based `truncLine` enforced.
function buildAgentBlock(data: AgentBlockData, theme: Theme): RowSegment[] {
  const statsLine = buildStatsLine(data.statsData, theme);
  const modelLabel = data.model ? theme.fg("accent", data.model) : "";
  const activityLine = buildActivityLine(data.activity, theme);
  const label = buildAgentLabel(data.agentName, data.task, theme);

  return [
    row(label),
    row([modelLabel, statsLine].filter(Boolean).join(" ")),
    row(activityLine),
  ];
}

export function renderCompactSingle(
  text: RowSink,
  result: SubagentResult,
  progress: SubagentProgress | undefined,
  theme: Theme,
  context: RenderContext,
): RowSink {
  // agentName sourced from result; defaults to "subagent"
  const agentName = result.agent ?? "subagent";
  const summary = result.progressSummary ?? { toolCount: 0, tokens: 0, durationMs: 0 };
  const isRunning = progress?.status === "running";
  const status = isRunning ? "running" : (result.exitCode === 0 ? "completed" : "failed");
  // Track start time for live duration
  const timeKey = "_subagentStartTime_" + agentName;
  if (isRunning && context.state[timeKey] === undefined) {
    // Estimate start time from current duration
    const currentDuration = summary.durationMs || (progress?.durationMs ?? 0);
    context.state[timeKey] = Date.now() - currentDuration;
  }
  const liveDuration = isRunning && context.state[timeKey]
    ? Date.now() - (context.state[timeKey] as number)
    : summary.durationMs;

  const block = buildAgentBlock(
    {
      agentName,
      task: result.task,
      model: progress?.model ?? result.model,
      statsData: {
        turns: result.usage.turns ?? 0,
        toolCount: summary.toolCount,
        turnTokens: progress?.turnTokens,
        tokens: summary.tokens,
        durationMs: liveDuration,
        cost: result.usage.cost ?? 0,
      },
      activity: {
        currentTool: progress?.currentTool,
        currentToolArgs: progress?.currentToolArgs,
        currentToolStartedAt: progress?.currentToolStartedAt,
        finalOutput: result.finalOutput,
        status: isRunning ? "running" : status,
        outcome: isRunning ? undefined : result.outcome,
        error: result.error,
        toolCalls: progress?.toolCalls,
      },
    },
    theme,
  );

  text.setSegments(block);
  return text;
}

// ── Compact parallel agents ─────────────────────────────────────────────────

export function renderCompactParallel(
  text: RowSink,
  details: SubagentDetails,
  theme: Theme,
  context: RenderContext,
): RowSink {
  const blocks = details.results.map((result, i) => {
    const progress = details.progress?.[i];
    const agentName = result.agent ?? "subagent";
    const summary = result.progressSummary ?? { toolCount: 0, tokens: 0, durationMs: 0 };
    const isRunning = progress?.status === "running";
    // Prefer result.exitCode as the source of truth for completion status
    // (matches expanded view). Only fall back to progress.status when the
    // subagent is still actively running. This prevents stale or misaligned
    // progress from showing the wrong status for a finished subagent.
    const status: "running" | "completed" | "failed" = isRunning
      ? "running"
      : result.exitCode === 0 ? "completed" : "failed";

    return buildAgentBlock(
      {
        agentName,
        task: result.task,
        model: progress?.model ?? result.model,
        statsData: {
          turns: result.usage.turns ?? 0,
          toolCount: summary.toolCount,
          turnTokens: progress?.turnTokens,
          tokens: summary.tokens,
          durationMs: summary.durationMs,
          cost: result.usage.cost ?? 0,
        },
        activity: {
          currentTool: progress?.currentTool,
          currentToolArgs: progress?.currentToolArgs,
          currentToolStartedAt: progress?.currentToolStartedAt,
          finalOutput: result.finalOutput,
          status,
          outcome: result.outcome,
          error: result.error,
          toolCalls: progress?.toolCalls,
        },
      },
      theme,
    );
  });

  text.setSegments(blocks.flat());
  return text;
}

// ── Compact streaming progress ──────────────────────────────────────────────

export function renderCompactProgress(
  text: RowSink,
  progress: SubagentProgress,
  theme: Theme,
  context: RenderContext,
): RowSink {
  // agentName sourced from progress; defaults to "subagent"
  const agentName = progress.agent ?? "subagent";
  const status = progress.status;
  const isRunning = status === "running";

  // Track start time for live duration
  const timeKey = "_subagentStartTime_" + agentName;
  if (isRunning && context.state[timeKey] === undefined) {
    context.state[timeKey] = Date.now() - (progress.durationMs ?? 0);
  }
  const liveDuration = isRunning && context.state[timeKey] !== undefined
    ? Date.now() - (context.state[timeKey] as number)
    : progress.durationMs;

  const block = buildAgentBlock(
    {
      agentName,
      task: progress.task,
      model: progress.model,
      statsData: {
        turns: progress.turnCount ?? 0,
        toolCount: progress.toolCount,
        turnTokens: progress.turnTokens,
        tokens: progress.tokens,
        durationMs: liveDuration,
        cost: progress.cost,
      },
      activity: {
        currentTool: progress.currentTool,
        currentToolArgs: progress.currentToolArgs,
        currentToolStartedAt: progress.currentToolStartedAt,
        finalOutput: undefined,
        status,
        outcome: status === "running" ? undefined : progress.outcome,
        error: progress.error,
        toolCalls: progress.toolCalls,
      },
    },
    theme,
  );

  text.setSegments(block);
  return text;
}

// ── Compact parallel streaming progress ─────────────────────────────────────

export function renderCompactParallelProgress(
  text: RowSink,
  details: SubagentDetails,
  theme: Theme,
  context: RenderContext,
): RowSink {
  const blocks = (details.progress ?? []).map((progress) => {
    const agentName = progress.agent ?? "subagent";
    const status = progress.status;

    return buildAgentBlock(
      {
        agentName,
        task: progress.task,
        model: progress.model,
        statsData: {
          turns: progress.turnCount ?? 0,
          toolCount: progress.toolCount,
          turnTokens: progress.turnTokens,
          tokens: progress.tokens,
          durationMs: progress.durationMs,
          cost: progress.cost,
        },
        activity: {
          currentTool: progress.currentTool,
          currentToolArgs: progress.currentToolArgs,
          currentToolStartedAt: progress.currentToolStartedAt,
          finalOutput: undefined,
          status,
          error: progress.error,
          toolCalls: progress.toolCalls,
        },
      },
      theme,
    );
  });

  text.setSegments(blocks.flat());
  return text;
}
