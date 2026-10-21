import type { Usage } from "@earendil-works/pi-ai";

export const MAX_SUBAGENT_DURATION_MS = 2_147_483_647;

export const SUBAGENT_OUTPUT_CONTRACTS = [
  "inline",
  "artifact",
  "status-only",
  "pass-no-findings",
] as const;
export type SubagentOutputContract = (typeof SUBAGENT_OUTPUT_CONTRACTS)[number];

export const SUBAGENT_EXECUTION_MODES = ["agentic", "one-shot"] as const;
export type SubagentExecutionMode = (typeof SUBAGENT_EXECUTION_MODES)[number];

export const SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export interface SubagentLimits {
  maxProviderRequests?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  /** Provider-native output cap accepted only for one-shot children. */
  maxOutputTokens?: number;
  maxCostUsd?: number;
  /** Absolute child wall-time ceiling. */
  maxDurationMs?: number;
  /** Sliding ceiling between valid child activity events. */
  maxIdleMs?: number;
}

export interface SubagentExecutionProfile {
  mode: SubagentExecutionMode;
  thinking?: string | undefined;
}

export interface OutputLimitEvidence {
  requested: number;
  /** Exact provider payload ceiling after clamping; absent when enforcement is unsupported. */
  effective?: number;
  enforcement: "applied" | "unsupported";
}

export interface ResolvedChildExecution {
  profile: SubagentExecutionProfile;
  limits?: SubagentLimits | undefined;
  outputLimit?: OutputLimitEvidence;
}

export const SUBAGENT_TERMINATION_REASONS = [
  "completed",
  "user-abort",
  "request-limit",
  "tool-limit",
  "token-limit",
  "output-limit",
  "cost-limit",
  "time-limit",
  "idle-limit",
  "usage-unknown",
  "repeated-error",
  "process-error",
] as const;
export type SubagentTerminationReason = (typeof SUBAGENT_TERMINATION_REASONS)[number];

export const SUBAGENT_USAGE_STATES = ["complete", "partial", "unknown"] as const;
export type SubagentUsageState = (typeof SUBAGENT_USAGE_STATES)[number];

export interface SubagentTermination {
  reason: SubagentTerminationReason;
  limit?: number;
  observed?: number;
  usageState: SubagentUsageState;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costBreakdown?: Usage["cost"];
  turns: number;
}

export interface SubagentToolCall {
  name: string;
  argsPreview: string;
  error: boolean;
}

/**
 * The terminal state of a finished run — the suite's fixed vocabulary for it
 * (`CONTEXT.md`: *Run outcome*).
 *
 * `completed` finished within limits; `truncated` finished but hit the output
 * token limit, so the answer is partial; `aborted` was cancelled. None of them
 * is a *failed* run — a pre/during-run error carries `error` and **no** outcome.
 */
export type RunOutcome = "completed" | "truncated" | "aborted";

export interface SubagentProgress {
  agent: string;
  /**
   * The coarse view axis (still running / finished / broke). The three-valued
   * *Run outcome* lives in `outcome`, which is what the renderers show when a
   * run has finished — a truncated run is not `failed`, and an aborted one is
   * not `completed`, whatever the row's status has to say for layout.
   */
  status: "running" | "completed" | "failed";
  /** Set once the run reaches a terminal state; absent for a failed run. */
  outcome?: RunOutcome;
  task: string;
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentToolStartedAt: number | undefined;
  toolCount: number;
  turnCount?: number;
  turnTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  durationMs: number;
  error: string | undefined;
  /** Model used by the subagent */
  model: string | undefined;
  /** Accumulated assistant text output during streaming */
  output: string | undefined;
  /** Last N lines of assistant text for live display */
  recentOutput: string[] | undefined;
  /** History of tool calls with status tracking */
  toolCalls: SubagentToolCall[] | undefined;
}

export interface SubagentChildTraceRef {
  sessionId: string;
  traceId?: string;
}

export interface SubagentProgressSummary {
  toolCount: number;
  tokens: number;
  durationMs: number;
}

export interface SubagentResult {
  agent: string;
  task: string;
  /** Logical Pi session UUID for this spawned subagent process. */
  childSessionId?: string;
  childTrace?: SubagentChildTraceRef;
  provider?: string | undefined;
  execution?: ResolvedChildExecution;
  outputContract?: SubagentOutputContract;
  termination?: SubagentTermination;
  exitCode: number;
  /**
   * How the run ended, when it ended. Absent when the run **failed** (an error
   * before or during the run), which is the case `error` and `isError` describe.
   */
  outcome?: RunOutcome;
  usage: SubagentUsage;
  /**
   * The run happened somewhere that already books its usage, so **this** session
   * must not also report it on the tool result.
   *
   * Set for a bridge-dispatched run: the desktop runs it as a session of its own
   * on its worker runtime, and that session's total is the number its Client
   * shows. `usage` still carries the metrics for display in `details`, but
   * `toNativeUsage`/`sumNativeUsage` leave it out, because pi folds a tool
   * result's `usage` into *this* session's totals — publishing it here would add
   * the same money to the parent's view of a run the parent did not perform
   * (ADR 0028: cost is counted once, which is why the `COST_UPDATE` bus route was
   * deleted rather than left alone).
   *
   * Absent on the fork path, where the child is a bare `pi --mode json` process
   * that reports nothing to anyone: the tool result is the only cost report.
   */
  usageAccountedElsewhere?: boolean;
  model?: string | undefined;
  finalOutput?: string | undefined;
  error?: string | undefined;
  progress?: SubagentProgress | undefined;
  progressSummary?: SubagentProgressSummary | undefined;
}

export interface SubagentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  /**
   * The machine-readable result for programmatic callers, matching
   * `SUBAGENT_OUTPUT_SCHEMA`. Success results only: a failed run reports
   * `isError` and carries none, so a codemode script keeps rejecting with the
   * text it rejects with today.
   *
   * A type alias, not an interface: `AgentToolResult.structuredContent` is
   * `JsonValue`, and TypeScript will not match an interface against its index
   * signature.
   */
  structuredContent?: {
    mode: "single" | "parallel";
    results: SubagentRunReport[];
  };
  /**
   * The runs' summed usage, in pi's own shape (see `usage.ts`).
   *
   * This is the cost report: pi persists it onto the toolResult message and
   * folds it into `/session`, which is why the `COST_UPDATE` bus route to the
   * footer was deleted instead of merely abandoned — the footer reads the same
   * entries and would have counted the money twice.
   */
  usage?: Usage;
  isError?: boolean;
}

/**
 * The machine-readable report for one run — `SubagentResult` without the live
 * progress blob (see `subagentStructuredContent()` in `tool-schema.ts`).
 */
// Derive the JSON report from its schema so public types and script values agree.
export type SubagentRunReport = import("typebox").Static<typeof import("./tool-schema.js").RunReportSchema>;

export interface SubagentDetails {
  mode: "single" | "parallel";
  results: SubagentResult[];
  progress?: SubagentProgress[] | undefined;
}

/** Mutable state during streaming — shared between stream.ts and handlers.ts */
export interface StreamState {
  childSessionId?: string;
  lastStopReason?: string;
  settledAborted?: boolean;
  toolCount: number;
  turnCount: number;
  usage: Usage;
  turnUsage: Usage;
  partialUsage: Usage;
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentToolStartedAt: number | undefined;
  provider: string | undefined;
  model: string | undefined;
  accumulatedOutput: string[];
  streamingOutput: string | undefined;
  streamingParts: Map<number, { type: "text" | "thinking"; content: string }>;
  outputLimit: OutputLimitEvidence | undefined;
  recentOutput: string[];
  toolCalls: SubagentToolCall[];
  finalOutput: string | undefined;
  error?: string | undefined;
}
