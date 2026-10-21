import { getBridge } from "@pi-archimedes/core/bridge";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { spawnSubagent, resolveModel } from "./spawn.js";
import { dispatchViaBridge, buildFailedResult } from "./dispatch.js";
import { streamEvents } from "./stream.js";
import type { AgentConfig } from "./agents.js";
import type { ResolvedChildExecution, SubagentLimits, SubagentOutputContract, SubagentProgress, SubagentResult, SubagentTermination } from "./types.js";
import { readUsage, sumNativeUsage } from "./usage.js";
import type { Usage } from "@earendil-works/pi-ai";

export interface ExecuteOptions {
  agent: string | undefined;
  agentConfig: AgentConfig | undefined;
  task: string;
  model: string | undefined;
  activeModel: string | undefined;
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  onUpdate: ((progress: SubagentProgress) => void) | undefined;
  /** The parent's host handle (`pi.events`) — forwarded to the ask bridge and to
   *  the todo announcements in `streamEvents`. Neither is an extension, so
   *  neither can reach a handle of its own. */
  events: EventBus;
  /** The subagent tool-call id (the tool's `_id`) — rides the dispatch frame
   *  for Client correlation; `undefined` → the frame's `toolCallId` is absent.
   *  In `executeParallel` all N tasks share the single subagent tool-call's id. */
  toolCallId?: string;
  execution?: ResolvedChildExecution;
  outputContract?: SubagentOutputContract;
}

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

export type ParallelTask = Omit<ExecuteOptions, "signal" | "onUpdate" | "events">;

export interface ParallelExecuteOptions {
  events: EventBus;
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
  if (!cause) return result;
  if (cause.reason === "worker" && result.termination === cause.termination &&
      result.outcome === undefined && result.progress?.outcome === undefined) return result;
  result = { ...result };
  delete result.outcome;
  if (result.progress) {
    result.progress = { ...result.progress };
    delete result.progress.outcome;
  }
  if (cause.reason === "worker") {
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

export function aggregateUsage(results: SubagentResult[]): Usage {
  return sumNativeUsage(results) ?? readUsage(undefined);
}

/**
 * Execute a single subagent — waits for completion before resolving.
 */
export async function executeSubagent(options: ExecuteOptions): Promise<SubagentResult> {
  const agentName = options.agent ?? "subagent";
  const startTime = Date.now();

  // Bridge mode: dispatch to the desktop (Client) instead of forking a child
  // pi process. An UNREACHABLE bridge (no response frame — e.g. macOS, where
  // the desktop's listener is not started, or Windows, where it is a no-op
  // stub) falls back to the fork path so subagents keep working everywhere.
  // Bridge wire has no managed profile/limit/result contract. Never delegate
  // contract-bearing work to it until equivalent enforcement exists there.
  if (getBridge().active && !options.execution && !options.outputContract) {
    const model = resolveModel({ model: options.model, activeModel: options.activeModel, agent: options.agentConfig });

    // A signal that is ALREADY aborted before dispatch: short-circuit to a
    // FAILED result (error "cancelled") — a deliberate cancel must never
    // fork, even in the corner where the channel is unreachable (the
    // executor's early return leaves `finish` as a safe no-op, so
    // `handle.cancel()` is a no-op and the rejection would map to
    // { fallback: true } → the fork path for an already-cancelled task).
    // This layer (not dispatchViaBridge) is the home: the execute layer
    // already has the signal; the channel-level function must not know fork
    // semantics. The short-circuit is BEFORE the "dispatched" placeholder —
    // a cancelled task does not claim it was dispatched — but the final
    // failure progress IS emitted (the same emit the catch block below does),
    // so executeParallel's progress slot updates from the pending placeholder
    // to "failed" instead of a stale "Starting...".
    if (options.signal?.aborted) {
      const result = {
        ...buildFailedResult(agentName, options.task, "cancelled", model, Date.now() - startTime),
        // Bridge mode: any usage this run ever had belongs to a desktop session.
        usageAccountedElsewhere: true,
      };
      options.onUpdate?.(result.progress!);
      return result;
    }

    // The TUI has no surface in bridge mode (RPC mode) and the desktop panel
    // is the progress surface — call onUpdate ONCE with a minimal "dispatched"
    // placeholder so the pi-acp tool_call_update frames stay well-formed, then
    // no further updates.
    options.onUpdate?.({
      agent: agentName,
      status: "running",
      task: options.task,
      currentTool: undefined,
      currentToolArgs: undefined,
      currentToolStartedAt: undefined,
      toolCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cost: 0,
      durationMs: 0,
      error: undefined,
      output: undefined,
      recentOutput: undefined,
      toolCalls: undefined,
      model,
    });
    const outcome = await dispatchViaBridge(options, options.signal, options.toolCallId);
    if (!("fallback" in outcome)) {
      // Bridge used (success or a response-carrying error, incl. the terminal
      // "cancelled" frame — the desktop is alive, its outcome is authoritative):
      // return it, with no cost report of its own. The PARENT never reports a
      // child's usage for a run it did not perform: the subagent process emits
      // its OWN usage to its OWN bridge (the core self-usage emitter), which is a
      // different session's total. Every result `dispatchViaBridge` settles
      // carries `usageAccountedElsewhere`, which is how the tool knows to leave
      // it off the tool result — pi folds that `usage` into THIS session's
      // totals, so copying it across would bill the parent twice. The fork path
      // below does report, through the tool result's native `usage`.
      return outcome;
    }
    // { fallback: true } — unreachable bridge: fall through to the fork path.
  }

  const control = createExecutionControl(options.signal, options.execution?.limits);

  // Progress is passed straight through: cost is reported once, on the tool
  // result's native `usage`, so there is no delta bookkeeping left to do here.
  try {
    const child = spawnSubagent({
      task: options.task,
      model: options.model,
      activeModel: options.activeModel,
      cwd: options.cwd,
      signal: control.signal,
      agent: options.agentConfig,
      events: options.events,
      ...(options.execution ? { execution: options.execution } : {}),
      idleWait: { pauseIdle: control.pauseIdle, resumeIdle: control.resumeIdle },
    });

    const result = await streamEvents(child, {
      agent: agentName,
      task: options.task,
      events: options.events,
      ...(options.execution ? { execution: options.execution } : {}),
      onActivity: control.noteActivity,
      onTermination: control.recordWorkerStop,
      onSettled: control.settle,
      onProgress: (progress: SubagentProgress) => {
        options.onUpdate?.(progress);
      },
    });

    control.settle();
    // Enrich result with agent name and duration
    const durationMs = Date.now() - startTime;
    const enriched: SubagentResult = {
      ...result,
      agent: agentName,
      task: options.task,
      ...(options.execution ? { execution: executionEvidence(options.execution, result.execution?.outputLimit) } : {}),
      ...(options.outputContract ? { outputContract: options.outputContract } : {}),
      progress: result.progress
        ? { ...result.progress, agent: agentName, durationMs }
        : // Defensive: streamEvents should always return a progress, but if not,
          // synthesize one so the parallel renderer stays aligned with results.
          {
            agent: agentName,
            status: result.outcome || result.exitCode === 0 ? "completed" : "failed",
            ...(result.outcome ? { outcome: result.outcome } : {}),
            task: options.task,
            currentTool: undefined,
            currentToolArgs: undefined,
            currentToolStartedAt: undefined,
            toolCount: 0,
            inputTokens: 0,
            outputTokens: 0,
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
    };
    return options.execution ? applyControlTermination(enriched, options, control, durationMs) : enriched;
  } catch (err) {
    control.settle();
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    // The shared failed-result synthesis (the same one the bridge error path
    // uses — model is undefined here: the fork never ran, so no model was
    // chosen). Always returns a valid progress object so the parallel
    // renderer's `details.progress[i]` stays aligned with `details.results[i]`
    // (returning undefined would be filtered out and cause index misalignment
    // between results and progress in the parallel view).
    const result: SubagentResult = {
      ...buildFailedResult(agentName, options.task, errorMessage, undefined, durationMs),
      ...(options.execution ? {
        execution: executionEvidence(options.execution),
        termination: { reason: "process-error" as const, usageState: "unknown" as const },
      } : {}),
      ...(options.outputContract ? { outputContract: options.outputContract } : {}),
    };
    // Emit final failure progress so executeParallel's progress slot updates
    // from the pending placeholder to "failed" (prevents stale "Starting..." display).
    options.onUpdate?.(result.progress!);
    return options.execution ? applyControlTermination(result, options, control, durationMs) : result;
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
    tokens: 0,
    cost: 0,
    durationMs: 0,
    error: undefined,
    output: undefined,
    recentOutput: undefined,
    toolCalls: undefined,
    // Match the model executeSubagent will report for this task, so the
    // pending placeholder's model label matches the streaming label exactly.
    model: resolveModel({ agent: taskDef.agentConfig, model: taskDef.model, activeModel: taskDef.activeModel }),
  }));

  const results = await Promise.all(
    options.tasks.map((taskDef, index) =>
      runner({
        ...taskDef,
        signal: options.signal,
        events: options.events,
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
