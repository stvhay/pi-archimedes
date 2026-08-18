import { resolveEffectiveModel, spawnSubagent } from "./spawn.js";
import { streamEvents } from "./stream.js";
import { emitCostUpdate } from "./cost.js";
import { addUsage, fromSubagentUsage } from "./usage.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import type {
  ResolvedChildExecution,
  SubagentLimits,
  SubagentOutputContract,
  SubagentProgress,
  SubagentResult,
  SubagentTermination,
  SubagentUsage,
} from "./types.js";

export type ExecutionStopCause =
  | { reason: "time-limit" | "idle-limit"; limit: number; observed: number }
  | { reason: "user-abort" }
  | { reason: "worker"; termination: SubagentTermination };

export interface ExecutionControl {
  signal: AbortSignal;
  noteActivity: () => void;
  pauseIdle: () => void;
  resumeIdle: () => void;
  recordWorkerStop: (termination: SubagentTermination) => void;
  settle: () => void;
  stopCause: () => ExecutionStopCause | undefined;
}

export function createExecutionControl(
  parentSignal: AbortSignal | undefined,
  limits: Pick<SubagentLimits, "maxDurationMs" | "maxIdleMs"> | undefined,
): ExecutionControl {
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastActivityAt: number | undefined;
  let idlePauseDepth = 0;
  let settled = false;
  let cause: ExecutionStopCause | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearTimer = (timer: NodeJS.Timeout | undefined): void => {
    if (timer) clearTimeout(timer);
  };
  const abort = (next: ExecutionStopCause): void => {
    cause ??= next;
    if (!controller.signal.aborted) controller.abort(cause);
  };
  const armIdle = (): void => {
    clearTimer(idleTimer);
    idleTimer = undefined;
    const limit = limits?.maxIdleMs;
    const activityAt = lastActivityAt;
    if (settled || cause || idlePauseDepth > 0 || limit === undefined || activityAt === undefined) return;
    const delay = Math.max(0, activityAt + limit - Date.now());
    idleTimer = setTimeout(() => {
      abort({ reason: "idle-limit", limit, observed: Date.now() - activityAt });
    }, delay);
    idleTimer.unref?.();
  };
  const onParentAbort = (): void => abort({ reason: "user-abort" });

  // Arm the hard timer first so equal deadlines deterministically report the hard ceiling.
  if (limits?.maxDurationMs !== undefined) {
    const limit = limits.maxDurationMs;
    hardTimer = setTimeout(() => {
      abort({ reason: "time-limit", limit, observed: Date.now() - startedAt });
    }, limit);
    hardTimer.unref?.();
  }

  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    noteActivity: () => {
      if (settled || cause) return;
      lastActivityAt = Date.now();
      armIdle();
    },
    pauseIdle: () => {
      if (settled || cause) return;
      idlePauseDepth++;
      clearTimer(idleTimer);
      idleTimer = undefined;
    },
    resumeIdle: () => {
      if (settled || cause || idlePauseDepth === 0) return;
      idlePauseDepth--;
      if (idlePauseDepth === 0 && lastActivityAt !== undefined) {
        lastActivityAt = Date.now();
        armIdle();
      }
    },
    recordWorkerStop: (termination) => {
      cause ??= { reason: "worker", termination };
    },
    settle: () => {
      if (settled) return;
      settled = true;
      clearTimer(hardTimer);
      clearTimer(idleTimer);
      hardTimer = undefined;
      idleTimer = undefined;
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
    stopCause: () => cause,
  };
}

export function aggregateUsage(results: SubagentResult[]): Usage {
  return addUsage(...results.map((result) => fromSubagentUsage(result.usage)));
}

export interface ExecuteOptions {
  agent: string | undefined;
  agentConfig: AgentConfig | undefined;
  task: string;
  model: string | undefined;
  activeModel: string | undefined;
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  onUpdate: ((progress: SubagentProgress) => void) | undefined;
  execution: ResolvedChildExecution;
  outputContract?: SubagentOutputContract | undefined;
}

function executionEvidence(
  execution: ResolvedChildExecution,
  outputLimit?: ResolvedChildExecution["outputLimit"],
): ResolvedChildExecution {
  return {
    profile: { ...execution.profile },
    limits: execution.limits ? { ...execution.limits } : undefined,
    ...(outputLimit ? { outputLimit: { ...outputLimit } } : {}),
  };
}

export type ParallelTask = Omit<ExecuteOptions, "signal" | "onUpdate">;

export interface ParallelExecuteOptions {
  tasks: ParallelTask[];
  signal: AbortSignal | undefined;
  onUpdate: ((progress: SubagentProgress[]) => void) | undefined;
}

function interruptedUsageState(result: SubagentResult): "partial" | "unknown" {
  return result.finalOutput || Object.values(result.usage).some((value) => typeof value === "number" && value > 0)
    ? "partial"
    : "unknown";
}

export function applyControlTermination(
  result: SubagentResult,
  options: ExecuteOptions,
  control: ExecutionControl,
  durationMs: number,
): SubagentResult {
  const cause = control.stopCause();
  if (cause?.reason === "worker") {
    if (result.termination === cause.termination) return result;
    const error = `Subagent stopped: ${cause.termination.reason}`;
    return {
      ...result,
      exitCode: 2,
      error,
      termination: cause.termination,
      progress: result.progress ? { ...result.progress, status: "failed", error } : result.progress,
    };
  }
  if (cause?.reason === "time-limit" || cause?.reason === "idle-limit") {
    const error = `Subagent stopped: ${cause.reason}`;
    return {
      ...result,
      exitCode: 2,
      error,
      termination: {
        reason: cause.reason,
        limit: cause.limit,
        observed: cause.observed,
        usageState: interruptedUsageState(result),
      },
      progress: result.progress ? { ...result.progress, status: "failed", error } : result.progress,
    };
  }
  if (cause?.reason === "user-abort") {
    const error = "Subagent cancelled";
    return {
      ...result,
      exitCode: 1,
      error,
      termination: {
        reason: "user-abort",
        usageState: interruptedUsageState(result),
      },
      progress: result.progress ? { ...result.progress, status: "failed", error } : result.progress,
    };
  }
  return result;
}

/**
 * Execute a single subagent — waits for completion before resolving.
 */
export async function executeSubagent(options: ExecuteOptions): Promise<SubagentResult> {
  const agentName = options.agent ?? "subagent";
  const startTime = Date.now();
  const control = createExecutionControl(options.signal, options.execution.limits);

  // Track previously emitted values to only emit deltas
  let lastEmittedInput = 0;
  let lastEmittedOutput = 0;
  let lastEmittedCacheRead = 0;
  let lastEmittedCacheWrite = 0;
  let lastEmittedCost = 0;

  try {
    const child = spawnSubagent({
      task: options.task,
      model: options.model,
      activeModel: options.activeModel,
      cwd: options.cwd,
      signal: control.signal,
      agent: options.agentConfig,
      execution: options.execution,
      idleWait: { pauseIdle: control.pauseIdle, resumeIdle: control.resumeIdle },
    });

    const result = await streamEvents(child, {
      agent: agentName,
      task: options.task,
      execution: options.execution,
      onActivity: control.noteActivity,
      onTermination: control.recordWorkerStop,
      onSettled: control.settle,
      onProgress: (progress: SubagentProgress) => {
        // Emit only deltas to avoid double-counting in CostAccumulator
        const deltaInput = progress.inputTokens - lastEmittedInput;
        const deltaOutput = progress.outputTokens - lastEmittedOutput;
        const cacheReadTokens = progress.cacheReadTokens ?? 0;
        const cacheWriteTokens = progress.cacheWriteTokens ?? 0;
        const deltaCacheRead = cacheReadTokens - lastEmittedCacheRead;
        const deltaCacheWrite = cacheWriteTokens - lastEmittedCacheWrite;
        const deltaCost = progress.cost - lastEmittedCost;
        if (deltaInput > 0 || deltaOutput > 0 || deltaCacheRead > 0 || deltaCacheWrite > 0 || deltaCost > 0) {
          emitCostUpdate(agentName, {
            inputTokens: deltaInput,
            outputTokens: deltaOutput,
            cacheReadTokens: deltaCacheRead,
            cacheWriteTokens: deltaCacheWrite,
            cost: deltaCost,
          });
          lastEmittedInput = progress.inputTokens;
          lastEmittedOutput = progress.outputTokens;
          lastEmittedCacheRead = cacheReadTokens;
          lastEmittedCacheWrite = cacheWriteTokens;
          lastEmittedCost = progress.cost;
        }
        options.onUpdate?.(progress);
      },
    });

    // Enrich result with agent name and duration
    control.settle();
    const durationMs = Date.now() - startTime;
    return applyControlTermination({
      ...result,
      agent: agentName,
      task: options.task,
      execution: executionEvidence(options.execution, result.execution?.outputLimit),
      ...(options.outputContract ? { outputContract: options.outputContract } : {}),
      progress: result.progress
        ? { ...result.progress, agent: agentName, durationMs }
        : // Defensive: streamEvents should always return a progress, but if not,
          // synthesize one so the parallel renderer stays aligned with results.
          {
            agent: agentName,
            status: result.exitCode === 0 ? "completed" : "failed",
            task: options.task,
            currentTool: undefined,
            currentToolArgs: undefined,
            currentToolStartedAt: undefined,
            toolCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            tokens: 0,
            cost: 0,
            durationMs,
            error: undefined,
            output: undefined,
            recentOutput: undefined,
            toolCalls: undefined,
            model: result.model,
          },
      progressSummary: result.progressSummary
        ? { ...result.progressSummary, durationMs }
        : { toolCount: 0, tokens: 0, durationMs },
    }, options, control, durationMs);
  } catch (err) {
    control.settle();
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    const result: SubagentResult = {
      agent: agentName,
      task: options.task,
      exitCode: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      } as SubagentUsage,
      model: undefined,
      execution: executionEvidence(options.execution),
      ...(options.outputContract ? { outputContract: options.outputContract } : {}),
      finalOutput: undefined,
      error: errorMessage,
      termination: { reason: "process-error", usageState: "unknown" },
      // Always return a valid progress object so the parallel renderer's
      // `details.progress[i]` stays aligned with `details.results[i]`.
      // Returning undefined here would be filtered out and cause index
      // misalignment between results and progress in the parallel view.
      progress: {
        agent: agentName,
        status: "failed",
        task: options.task,
        currentTool: undefined,
        currentToolArgs: undefined,
        currentToolStartedAt: undefined,
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokens: 0,
        cost: 0,
        durationMs,
        error: errorMessage,
        output: undefined,
        recentOutput: undefined,
        toolCalls: undefined,
        model: undefined,
      },
      progressSummary: { toolCount: 0, tokens: 0, durationMs },
    };
    // Emit final failure progress so executeParallel's progress slot updates
    // from the pending placeholder to "failed" (prevents stale "Starting..." display).
    options.onUpdate?.(result.progress!);
    return applyControlTermination(result, options, control, durationMs);
  }
}

/**
 * Execute multiple subagents in parallel.
 */
export async function executeParallel(
  options: ParallelExecuteOptions,
  runner: (options: ExecuteOptions) => Promise<SubagentResult> = executeSubagent,
): Promise<SubagentResult[]> {
  // Pre-fill one pending slot per task, keyed by task index (NOT agent name).
  // This keeps all N lines stacked from t=0 in stable task order, with no
  // collisions when multiple subagents share an agent name (e.g. 8 x "general").
  const latestProgress: SubagentProgress[] = options.tasks.map((taskDef) => ({
    agent: taskDef.agent ?? "subagent",
    status: "running" as const,
    task: taskDef.task,
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens: 0,
    cost: 0,
    durationMs: 0,
    error: undefined,
    output: undefined,
    recentOutput: undefined,
    toolCalls: undefined,
    // Match the model executeSubagent will report for this task, so the
    // pending placeholder's model label matches the streaming label exactly.
    model: resolveEffectiveModel({
      agent: taskDef.agentConfig,
      model: taskDef.model,
      activeModel: taskDef.activeModel,
    }),
  }));

  const results = await Promise.all(
    options.tasks.map((taskDef, index) =>
      runner({
        ...taskDef,
        signal: options.signal,
        onUpdate: (progress: SubagentProgress) => {
          // Store latest progress in this task's stable slot (by index).
          latestProgress[index] = progress;
          // Emit all N entries in stable task order.
          options.onUpdate?.([...latestProgress]);
        },
      }),
    ),
  );
  return results;
}
