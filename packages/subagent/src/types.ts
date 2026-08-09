import type { Usage } from "@earendil-works/pi-ai";

export const MAX_SUBAGENT_DURATION_MS = 2_147_483_647;

export interface SubagentLimits {
  maxProviderRequests?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export const SUBAGENT_TERMINATION_REASONS = [
  "completed",
  "user-abort",
  "request-limit",
  "tool-limit",
  "token-limit",
  "cost-limit",
  "time-limit",
  "usage-unknown",
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

export interface SubagentProgress {
  agent: string;
  status: "running" | "completed" | "failed";
  task: string;
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentToolStartedAt: number | undefined;
  toolCount: number;
  /** Current provider turn number. Optional for external progress producers. */
  turnCount?: number;
  /** Tokens observed in the current provider turn. */
  turnTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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

export interface SubagentResult {
  agent: string;
  task: string;
  /** Logical Pi session UUID for this spawned subagent process. */
  childSessionId?: string;
  exitCode: number;
  usage: SubagentUsage;
  provider?: string | undefined;
  model: string | undefined;
  finalOutput: string | undefined;
  error: string | undefined;
  termination?: SubagentTermination;
  progress: SubagentProgress | undefined;
  progressSummary: { toolCount: number; tokens: number; durationMs: number } | undefined;
}

export interface SubagentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
  /** Nested child-model usage for Pi versions that support tool-result accounting. */
  usage?: Usage;
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  results: SubagentResult[];
  progress: SubagentProgress[] | undefined;
}

/** Mutable state during streaming — shared between stream.ts and handlers.ts */
export interface StreamState {
  childSessionId?: string;
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
  recentOutput: string[];
  toolCalls: SubagentToolCall[];
  finalOutput: string | undefined;
}

