import { spawnSubagent } from "./spawn.js";
import { streamEvents } from "./stream.js";
import { emitCostUpdate } from "./cost.js";
import { addUsage, fromSubagentUsage } from "./usage.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import type { SubagentLimits, SubagentProgress, SubagentResult, SubagentUsage } from "./types.js";

export interface ExecutionControl {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

export function createExecutionControl(
  parentSignal: AbortSignal | undefined,
  durationMs: number | undefined,
): ExecutionControl {
  const controller = new AbortController();
  let timeoutExpired = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timer = durationMs === undefined ? undefined : setTimeout(() => {
    timeoutExpired = true;
    controller.abort();
  }, durationMs);
  timer?.unref();

  return {
    signal: controller.signal,
    timedOut: () => timeoutExpired,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
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
  limits?: SubagentLimits;
}

export type ParallelTask = Omit<ExecuteOptions, "signal" | "onUpdate">;

export interface ParallelExecuteOptions {
  tasks: ParallelTask[];
  signal: AbortSignal | undefined;
  onUpdate: ((progress: SubagentProgress[]) => void) | undefined;
}

export function applyControlTermination(
  result: SubagentResult,
  options: ExecuteOptions,
  control: ExecutionControl,
  durationMs: number,
): SubagentResult {
  const reason = result.termination?.reason;
  if (reason && reason !== "completed" && reason !== "process-error") return result;
  if (control.timedOut()) {
    const error = "Subagent stopped: time-limit";
    return {
      ...result,
      exitCode: 2,
      error,
      termination: {
        reason: "time-limit",
        ...(options.limits?.maxDurationMs !== undefined
          ? { limit: options.limits.maxDurationMs }
          : {}),
        observed: durationMs,
        usageState: result.finalOutput ? "partial" : "unknown",
      },
      progress: result.progress ? { ...result.progress, status: "failed", error } : result.progress,
    };
  }
  if (options.signal?.aborted) {
    const error = "Subagent cancelled";
    return {
      ...result,
      exitCode: 1,
      error,
      termination: {
        reason: "user-abort",
        usageState: result.finalOutput ? "partial" : "unknown",
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
  const control = createExecutionControl(options.signal, options.limits?.maxDurationMs);

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
      limits: options.limits,
    });

    const result = await streamEvents(child, {
      agent: agentName,
      task: options.task,
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
    const durationMs = Date.now() - startTime;
    return applyControlTermination({
      ...result,
      agent: agentName,
      task: options.task,
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
  } finally {
    control.cleanup();
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
    model: taskDef.model,
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
