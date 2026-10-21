import { Type, type Static } from "typebox";
import { MAX_SUBAGENT_DURATION_MS, SUBAGENT_EXECUTION_MODES, SUBAGENT_OUTPUT_CONTRACTS, SUBAGENT_THINKING_LEVELS, SUBAGENT_TERMINATION_REASONS, SUBAGENT_USAGE_STATES } from "./types.js";
import type { SubagentResult, SubagentRunReport } from "./types.js";

// ── JSON Schema for tool parameters (TypeBox) ──────────────────────────────

const SubagentLimitsSchema = Type.Object({
  maxProviderRequests: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum provider requests for this child" })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum tool calls for this child" })),
  maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum input, output, and cache tokens for this child" })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Best-effort provider-native output cap for one-shot children" })),
  maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Observed cost ceiling in USD; may overshoot by one response" })),
  maxDurationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_DURATION_MS, description: "Maximum wall time in milliseconds for this child" })),
  maxIdleMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_DURATION_MS, description: "Maximum milliseconds between valid child activity events" })),
});

const ExecutionModeSchema = Type.Unsafe<(typeof SUBAGENT_EXECUTION_MODES)[number]>({
  type: "string", enum: [...SUBAGENT_EXECUTION_MODES],
  description: "agentic: normal child with tools and ambient context; one-shot: isolated packet with one provider request",
});
const ThinkingLevelSchema = Type.Unsafe<(typeof SUBAGENT_THINKING_LEVELS)[number]>({
  type: "string", enum: [...SUBAGENT_THINKING_LEVELS],
  description: "Child thinking level. Agent frontmatter wins, then task-level, then top-level thinking.",
});
const OutputContractSchema = Type.Unsafe<(typeof SUBAGENT_OUTPUT_CONTRACTS)[number]>({
  type: "string", enum: [...SUBAGENT_OUTPUT_CONTRACTS],
  description: "Caller-supplied result transport label; Archimedes reports but does not evaluate it.",
});

const TaskItem = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent name for this task (optional). If omitted, runs config-less.",
  })),
  task: Type.String(),
  model: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  limits: Type.Optional(SubagentLimitsSchema),
  mode: Type.Optional(ExecutionModeSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
  outputContract: Type.Optional(OutputContractSchema),
});

export const SUBAGENT_PARAMS_SCHEMA = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent name (optional). If omitted, the subagent runs config-less — parent's current model, all tools, no system-prompt override. Call list_agents to see available agents.",
  })),
  task: Type.Optional(Type.String({
    description: "Task description for the subagent. Required when not using 'tasks' array.",
  })),
  tasks: Type.Optional(Type.Array(TaskItem, {
    description: "Multiple tasks for parallel execution. Required when not using 'task'.",
  })),
  model: Type.Optional(Type.String({
    description: "Model override for the subagent",
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the subagent",
  })),
  limits: Type.Optional(SubagentLimitsSchema),
  mode: Type.Optional(ExecutionModeSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
  outputContract: Type.Optional(OutputContractSchema),
});

/**
 * What `execute` is handed, derived from the schema rather than written out —
 * the `ask` / `sudo` precedent (`AskParams`, `SudoExecInput`).
 *
 * #114's two phantoms were only possible because one contract was stated twice,
 * independently: `async` in this schema, `count?: number` in the hand-written
 * `params` type in `index.ts`. Nothing kept the two in step, and only one of them
 * is what the model sees. Stating the contract once removes the second list: the
 * schema is now the only *default* source of a name in `execute`'s declared
 * params type — see the caveat below, which is the whole difference between
 * "only default" and "only".
 *
 * That is a structural fix, not a check. It does not stop anyone reading a
 * declared field, and it does not make a phantom a compile error — `execute` is
 * declared as a method, so bivariant parameters accept a widening `& { … }` at
 * the params position. See the header of `tool-schema.test.ts` for what is
 * enforced where, measured.
 */
export type SubagentParams = Static<typeof SUBAGENT_PARAMS_SCHEMA>;

// ── JSON Schema for `structuredContent` ────────────────────────────────
//
// One report per run: what ran, how it ended, what it cost, what it answered.
// It is `details` minus the live-progress blob — `details.progress[i].output`
// is the child's whole streamed scrollback and `toolCalls` its call history, for
// the row renderer, and a script that wants the answer already has
// `finalOutput`. `usageAccountedElsewhere` is left out too: it is this session's
// bookkeeping flag (ADR 0028), not a fact about the run.
//
// pi hands this to a codemode script instead of the text and validates it
// against nothing, so `index.output-schema.test.ts` runs the handler and checks
// the payload against this declaration.
//
// A single run that reports itself as failed is `isError` and carries none of it
// (see the note in `index.ts`), so a script keeps rejecting with the text it
// rejects with today. A parallel batch is the other case: one failed run inside
// a batch does not make the batch an error — it stays a report of N runs, with
// that run's `error` field set inside `results` (pre-existing shape, unchanged
// by these schemas; see the per-run failure markers in `formatParallelResults`).

const CostBreakdownSchema = Type.Object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(),
  cacheWrite: Type.Number(), total: Type.Number(),
});

const UsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cost: Type.Number(),
  costBreakdown: Type.Optional(CostBreakdownSchema),
  turns: Type.Number(),
});

const ProgressSummarySchema = Type.Object({
  toolCount: Type.Number(),
  tokens: Type.Number(),
  durationMs: Type.Number(),
});

const ExecutionSchema = Type.Object({
  profile: Type.Object({ mode: ExecutionModeSchema, thinking: Type.Optional(Type.String()) }),
  limits: Type.Optional(SubagentLimitsSchema),
  outputLimit: Type.Optional(Type.Object({
    requested: Type.Integer({ minimum: 1 }),
    effective: Type.Optional(Type.Integer({ minimum: 1 })),
    enforcement: Type.Union([Type.Literal("applied"), Type.Literal("unsupported")]),
  })),
});
const TerminationSchema = Type.Object({
  reason: Type.Unsafe<(typeof SUBAGENT_TERMINATION_REASONS)[number]>({ type: "string", enum: [...SUBAGENT_TERMINATION_REASONS] }),
  limit: Type.Optional(Type.Number({ minimum: 0 })),
  observed: Type.Optional(Type.Number({ minimum: 0 })),
  usageState: Type.Unsafe<(typeof SUBAGENT_USAGE_STATES)[number]>({ type: "string", enum: [...SUBAGENT_USAGE_STATES] }),
});

export const RunReportSchema = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  exitCode: Type.Number(),
  childSessionId: Type.Optional(Type.String()),
  childTrace: Type.Optional(Type.Object({ sessionId: Type.String(), traceId: Type.Optional(Type.String()) })),
  provider: Type.Optional(Type.String()),
  execution: Type.Optional(ExecutionSchema),
  termination: Type.Optional(TerminationSchema),
  outputContract: Type.Optional(OutputContractSchema),
  outcome: Type.Optional(
    Type.Union([Type.Literal("completed"), Type.Literal("truncated"), Type.Literal("aborted")]),
  ),
  usage: UsageSchema,
  model: Type.Optional(Type.String()),
  finalOutput: Type.Optional(Type.String({ description: "The run's answer text, when it produced one" })),
  error: Type.Optional(Type.String({ description: "Set when the run failed before or during execution" })),
  progressSummary: Type.Optional(ProgressSummarySchema),
});

export const SUBAGENT_OUTPUT_SCHEMA = Type.Object({
  mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")]),
  results: Type.Array(RunReportSchema),
});

/** The report for one run; `undefined` fields are omitted, not null. */
export function subagentStructuredContent(
  mode: "single" | "parallel",
  results: SubagentResult[],
): { mode: "single" | "parallel"; results: SubagentRunReport[] } {
  return {
    mode,
    results: results.map((result) => ({
      agent: result.agent,
      task: result.task,
      exitCode: result.exitCode,
      ...(result.childSessionId !== undefined && { childSessionId: result.childSessionId }),
      ...(result.childTrace && { childTrace: { ...result.childTrace } }),
      ...(result.provider !== undefined && { provider: result.provider }),
      ...(result.outputContract && { outputContract: result.outputContract }),
      ...(result.termination && { termination: { ...result.termination } }),
      ...(result.execution && { execution: {
        profile: {
          mode: result.execution.profile.mode,
          ...(result.execution.profile.thinking !== undefined && { thinking: result.execution.profile.thinking }),
        },
        ...(result.execution.limits && { limits: { ...result.execution.limits } }),
        ...(result.execution.outputLimit && { outputLimit: { ...result.execution.outputLimit } }),
      } }),
      ...(result.outcome !== undefined && { outcome: result.outcome }),
      usage: {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        cost: result.usage.cost,
        ...(result.usage.costBreakdown && { costBreakdown: { ...result.usage.costBreakdown } }),
        turns: result.usage.turns,
      },
      ...(result.model !== undefined && { model: result.model }),
      ...(result.finalOutput !== undefined && { finalOutput: result.finalOutput }),
      ...(result.error !== undefined && { error: result.error }),
      ...(result.progressSummary !== undefined && { progressSummary: { ...result.progressSummary } }),
    })),
  };
}
