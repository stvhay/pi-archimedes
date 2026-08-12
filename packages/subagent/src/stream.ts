import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { StreamState, SubagentProgress, SubagentResult } from "./types.js";
import { getBus, Events } from "@pi-archimedes/core/bus";
import { decodeLimitStop } from "./limits.js";
import { scheduleTerminateChild } from "./spawn.js";
import { addUsage, readUsage, toSubagentUsage } from "./usage.js";
import {
  type JsonEvent,
  handleToolStart,
  handleToolEnd,
  handleToolResult,
  handleMessageStart,
  handleMessageUpdate,
  handleMessageEnd,
  handleAgentEnd,
} from "./handlers.js";

export interface StreamCallbacks {
  agent?: string;
  task?: string;
  onProgress?: (progress: SubagentProgress) => void;
}

const REPEATED_ERROR_LIMIT = 3;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_FINGERPRINT_NODES = 10_000;
const MAX_FINGERPRINT_CHARS = 256_000;
// ponytail: cap malformed-stream state; use a bounded LRU if legitimate children exceed 1,000 tools.
const MAX_TRACKED_TOOL_CALL_IDS = 1_000;

function canonicalJsonValue(
  value: unknown,
  depth = 0,
  budget = { nodes: MAX_FINGERPRINT_NODES, chars: MAX_FINGERPRINT_CHARS },
): unknown {
  if (depth > MAX_FINGERPRINT_DEPTH) throw new RangeError("fingerprint input is too deep");
  if (--budget.nodes < 0) throw new RangeError("fingerprint input is too large");
  if (typeof value === "string") {
    budget.chars -= value.length;
    if (budget.chars < 0) throw new RangeError("fingerprint input is too large");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > budget.nodes) throw new RangeError("fingerprint input is too large");
    return value.map((item) => canonicalJsonValue(item, depth + 1, budget));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (keys.length >= budget.nodes) throw new RangeError("fingerprint input is too large");
    budget.chars -= key.length;
    if (budget.chars < 0) throw new RangeError("fingerprint input is too large");
    keys.push(key);
  }
  keys.sort();
  return Object.fromEntries(
    keys.map((key) => [key, canonicalJsonValue(record[key], depth + 1, budget)]),
  );
}

function fingerprint(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(canonicalJsonValue(value));
    if (typeof json !== "string" || json.length > MAX_FINGERPRINT_CHARS) return undefined;
    return createHash("sha256").update(json).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Stream JSON events from a child `pi --mode json` process and build progress/result.
 *
 * The child writes one JSON object per line to stdout. We read each line via
 * readline, parse it, and dispatch to the same handler functions used previously.
 * stderr is drained silently (captured as the error string on non-zero exit).
 */
export function streamEvents(
  child: ChildProcess,
  callbacks: StreamCallbacks = {},
): Promise<SubagentResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    // Startup safeguard: if no JSON event arrives within 2 minutes, kill the child.
    const STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
    let startupTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `subagent timed out: no output within ${STARTUP_TIMEOUT_MS / 60_000} minutes of startup`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    const clearStartupTimer = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
    };

    const state: StreamState = {
      toolCount: 0,
      turnCount: 0,
      usage: readUsage(undefined),
      turnUsage: readUsage(undefined),
      partialUsage: readUsage(undefined),
      currentTool: undefined,
      currentToolArgs: undefined,
      currentToolStartedAt: undefined,
      provider: undefined,
      model: undefined,
      accumulatedOutput: [],
      streamingOutput: undefined,
      streamingParts: new Map(),
      recentOutput: [],
      toolCalls: [],
      finalOutput: undefined,
      error: undefined,
    };

    const stderrLines: string[] = [];
    let error: string | undefined;
    let termination = undefined as SubagentResult["termination"];
    const toolFingerprints = new Map<
      string,
      { toolName: string; call?: string } | null
    >();
    const seenToolCallIds = new Set<string>();
    let repeatedErrorTracking = true;
    let lastErrorFingerprint: string | undefined;
    let repeatedErrorCount = 0;

    const resetRepeatedErrorStreak = (): void => {
      lastErrorFingerprint = undefined;
      repeatedErrorCount = 0;
    };

    const disableRepeatedErrorTracking = (): void => {
      repeatedErrorTracking = false;
      toolFingerprints.clear();
      seenToolCallIds.clear();
      resetRepeatedErrorStreak();
    };

    const observeToolResult = (
      toolFingerprint: string,
      result: unknown,
      isError: boolean,
    ): void => {
      if (termination) return;
      if (!isError) {
        resetRepeatedErrorStreak();
        return;
      }

      const failedResultFingerprint = fingerprint([toolFingerprint, result]);
      if (!failedResultFingerprint) {
        resetRepeatedErrorStreak();
        return;
      }
      repeatedErrorCount = failedResultFingerprint === lastErrorFingerprint ? repeatedErrorCount + 1 : 1;
      lastErrorFingerprint = failedResultFingerprint;
      if (repeatedErrorCount < REPEATED_ERROR_LIMIT) return;

      termination = {
        reason: "repeated-error",
        limit: REPEATED_ERROR_LIMIT,
        observed: repeatedErrorCount,
        usageState: "partial",
      };
      error = "Subagent stopped: repeated-error";
      scheduleTerminateChild(child);
    };

    if (child.stderr) {
      const stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity });
      stderrReader.on("line", (line) => {
        const stop = decodeLimitStop(line);
        if (stop && !termination) {
          termination = stop;
          error = `Subagent stopped: ${stop.reason}`;
          scheduleTerminateChild(child);
        } else if (!stop) {
          stderrLines.push(line);
        }
      });
    }

    const observedUsage = () => addUsage(state.usage, state.partialUsage);

    const observedOutput = (): string | undefined => {
      const parts = [
        ...state.accumulatedOutput,
        ...(state.streamingOutput ? [state.streamingOutput] : []),
      ];
      return parts.length > 0 ? parts.join("\n\n") : undefined;
    };

    const buildProgress = (): SubagentProgress => {
      const usage = observedUsage();
      const turnUsage = state.partialUsage.totalTokens > 0 ? state.partialUsage : state.turnUsage;
      return {
        agent: callbacks.agent ?? "subagent",
        status: "running",
        task: callbacks.task ?? "",
        currentTool: state.currentTool,
        currentToolArgs: state.currentToolArgs,
        currentToolStartedAt: state.currentToolStartedAt,
        toolCount: state.toolCount,
        turnCount: state.turnCount,
        turnTokens: turnUsage.totalTokens,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: usage.cost.total,
        durationMs: Date.now() - startTime,
        error,
        output: observedOutput(),
        recentOutput: state.recentOutput.length > 0 ? state.recentOutput : undefined,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        model: state.model,
      };
    };

    const emitProgress = () => callbacks.onProgress?.(buildProgress());

    // Periodic heartbeat for live duration display
    const heartbeat = setInterval(emitProgress, 1000);

    // Read stdout as newline-delimited JSON
    if (!child.stdout) {
      clearStartupTimer();
      clearInterval(heartbeat);
      reject(new Error("subagent child has no stdout pipe"));
      return;
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event: JsonEvent;
      try {
        event = JSON.parse(trimmed) as JsonEvent;
      } catch {
        // Non-JSON output — ignore (can happen from pi startup messages)
        return;
      }

      // First real event means model has engaged — cancel startup watchdog
      clearStartupTimer();

      switch (event.type) {
        case "session": {
          if (typeof event.id === "string" && event.id) {
            state.childSessionId = event.id;
          }
          break;
        }
        case "tool_execution_start": {
          const toolCallId = typeof event.toolCallId === "string" && event.toolCallId
            ? event.toolCallId
            : undefined;
          const toolCallKey = repeatedErrorTracking && toolCallId
            ? fingerprint(toolCallId)
            : undefined;
          if (toolCallKey) {
            const duplicate = seenToolCallIds.has(toolCallKey);
            if (!duplicate && seenToolCallIds.size >= MAX_TRACKED_TOOL_CALL_IDS) {
              disableRepeatedErrorTracking();
            } else {
              seenToolCallIds.add(toolCallKey);
              if (duplicate) {
                toolFingerprints.set(toolCallKey, null);
              } else if (
                typeof event.toolName === "string" &&
                event.toolName &&
                event.args !== undefined
              ) {
                const toolName = fingerprint(event.toolName);
                const call = fingerprint([event.toolName, event.args]);
                if (toolName) toolFingerprints.set(toolCallKey, { toolName, ...(call ? { call } : {}) });
              }
            }
          }
          handleToolStart(state, event);
          emitProgress();
          // Forward manage_todo_list writes to the parent's todo widget
          if (event.toolName === "manage_todo_list") {
            const args = event.args as Record<string, unknown> | undefined;
            const todoList = args?.todoList as Array<unknown> | undefined;
            if (Array.isArray(todoList)) {
              getBus().emit(Events.TODOS_UPDATE, {
                source: `subagent:${callbacks.agent ?? "general"}`,
                todos: todoList,
              });
            }
          }
          break;
        }
        case "tool_execution_end": {
          const toolCallId = typeof event.toolCallId === "string" && event.toolCallId
            ? event.toolCallId
            : undefined;
          const toolCallKey = repeatedErrorTracking && toolCallId
            ? fingerprint(toolCallId)
            : undefined;
          const pending = toolCallKey ? toolFingerprints.get(toolCallKey) : undefined;
          if (toolCallKey && pending === null) {
            toolFingerprints.delete(toolCallKey);
          } else if (
            toolCallKey &&
            pending &&
            typeof event.toolName === "string" &&
            event.toolName &&
            pending.toolName === fingerprint(event.toolName) &&
            event.result !== undefined &&
            typeof event.isError === "boolean"
          ) {
            toolFingerprints.delete(toolCallKey);
            if (pending.call) observeToolResult(pending.call, event.result, event.isError);
            else resetRepeatedErrorStreak();
          }
          handleToolEnd(state);
          emitProgress();
          handleToolResult(state, event);
          emitProgress();
          break;
        }
        case "turn_start": {
          state.turnCount++;
          state.turnUsage = readUsage(undefined);
          state.partialUsage = readUsage(undefined);
          break;
        }
        case "message_start": {
          handleMessageStart(state, event);
          emitProgress();
          break;
        }
        case "message_update": {
          if (handleMessageUpdate(state, event)) emitProgress();
          break;
        }
        case "message_end": {
          handleMessageEnd(state, event);
          emitProgress();
          break;
        }
        case "agent_end": {
          handleAgentEnd(state, event);
          break;
        }
        // Ignore: agent_start, turn_end, tool_execution_update
      }
    });

    // Handle process exit
    child.on("close", (code) => {
      clearStartupTimer();
      clearInterval(heartbeat);
      const durationMs = Date.now() - startTime;
      const processExitCode = code ?? 1;
      const usage = observedUsage();

      error ??= state.error;
      if (processExitCode !== 0 && !error) {
        const stderr = stderrLines.join("\n").trim();
        if (stderr) error = stderr;
      }
      const exitCode = termination ? 2 : state.error ? 1 : processExitCode;
      termination ??= exitCode === 0
        ? { reason: "completed", usageState: "complete" }
        : {
          reason: "process-error",
          usageState: state.streamingOutput ? "partial" : "unknown",
        };

      const result: SubagentResult = {
        agent: callbacks.agent ?? "subagent",
        task: callbacks.task ?? "",
        ...(state.childSessionId ? { childSessionId: state.childSessionId } : {}),
        exitCode,
        provider: state.provider,
        model: state.model,
        usage: toSubagentUsage(usage, state.turnCount),
        finalOutput: state.finalOutput ?? observedOutput(),
        error,
        termination,
        progress: {
          ...buildProgress(),
          status: exitCode === 0 ? "completed" : "failed",
          durationMs,
        },
        progressSummary: {
          toolCount: state.toolCount,
          tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          durationMs,
        },
      };

      callbacks.onProgress?.(result.progress!);

      // Clear subagent todos from the bus on exit
      getBus().emit(Events.TODOS_CLEAR, {
        source: `subagent:${callbacks.agent ?? "general"}`,
      });

      resolve(result);
    });

    child.on("error", (err) => {
      clearStartupTimer();
      clearInterval(heartbeat);
      reject(err);
    });
  });
}
