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
  handleMessageUpdate,
  handleMessageEnd,
  handleAgentEnd,
} from "./handlers.js";

export interface StreamCallbacks {
  agent?: string;
  task?: string;
  onProgress?: (progress: SubagentProgress) => void;
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
      partialUsage: readUsage(undefined),
      currentTool: undefined,
      currentToolArgs: undefined,
      currentToolStartedAt: undefined,
      model: undefined,
      accumulatedOutput: [],
      streamingOutput: undefined,
      recentOutput: [],
      toolCalls: [],
      finalOutput: undefined,
    };

    const stderrLines: string[] = [];
    let error: string | undefined;
    let termination = undefined as SubagentResult["termination"];
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
      return {
        agent: callbacks.agent ?? "subagent",
        status: "running",
        task: callbacks.task ?? "",
        currentTool: state.currentTool,
        currentToolArgs: state.currentToolArgs,
        currentToolStartedAt: state.currentToolStartedAt,
        toolCount: state.toolCount,
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
        case "tool_execution_start": {
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
          handleToolEnd(state);
          emitProgress();
          handleToolResult(state, event);
          emitProgress();
          break;
        }
        case "turn_start": {
          state.turnCount++;
          break;
        }
        case "message_update": {
          handleMessageUpdate(state, event);
          emitProgress();
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
        // Ignore: session, agent_start, message_start, turn_end, tool_execution_update
      }
    });

    // Handle process exit
    child.on("close", (code) => {
      clearStartupTimer();
      clearInterval(heartbeat);
      const durationMs = Date.now() - startTime;
      const exitCode = termination ? 2 : (code ?? 1);
      const usage = observedUsage();

      if (exitCode !== 0 && !error) {
        const stderr = stderrLines.join("\n").trim();
        if (stderr) error = stderr;
      }
      termination ??= exitCode === 0
        ? { reason: "completed", usageState: "complete" }
        : {
          reason: "process-error",
          usageState: state.streamingOutput ? "partial" : "unknown",
        };

      const result: SubagentResult = {
        agent: callbacks.agent ?? "subagent",
        task: callbacks.task ?? "",
        exitCode,
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
