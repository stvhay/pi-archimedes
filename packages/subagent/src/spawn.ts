import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getBus, Events, type AskRequestPayload } from "@pi-archimedes/core/bus";
import type { AgentConfig } from "./agents.js";
import { ONE_SHOT_SYSTEM_PROMPT } from "./execution-profile.js";
import { encodeLimitsEnvironment, SUBAGENT_LIMITS_ENV } from "./limits.js";
import type { ResolvedChildExecution, SubagentLimits } from "./types.js";

export interface IdleWaitCallbacks {
  pauseIdle: () => void;
  resumeIdle: () => void;
}

export interface SpawnOptions {
  task: string;
  model: string | undefined;
  activeModel: string | undefined;
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  agent: AgentConfig | undefined;
  execution: ResolvedChildExecution;
  idleWait?: IdleWaitCallbacks | undefined;
}

export function resolveEffectiveModel(
  options: Pick<SpawnOptions, "agent" | "model" | "activeModel">,
): string | undefined {
  return options.agent?.model ?? options.model ?? options.activeModel;
}

/**
 * Resolve the pi binary path.
 *
 * Walk up from process.argv[1] (the pi CLI entry point) looking for the
 * @earendil-works/pi-coding-agent package root, then resolve its bin.pi field.
 * Falls back to "pi" (PATH lookup) if resolution fails.
 */
function resolvePiBinary(): string {
  try {
    const entry = process.argv[1];
    if (!entry) return "pi";

    let dir = path.dirname(fs.realpathSync(entry));
    const root = path.parse(dir).root;

    while (dir !== root) {
      const pkgPath = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          name?: string;
          bin?: string | Record<string, string>;
        };
        if (pkg.name === "@earendil-works/pi-coding-agent") {
          const binField = pkg.bin;
          const binRelative =
            typeof binField === "string"
              ? binField
              : binField?.pi ?? Object.values(binField ?? {})[0];
          if (binRelative) {
            const resolved = path.resolve(dir, binRelative);
            if (fs.existsSync(resolved)) return resolved;
          }
          break;
        }
      } catch {
        // package.json missing or invalid — keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return "pi";
}

/**
 * Start a Unix socket server that bridges the child's ask tool to the parent bus.
 *
 * The child's ask tool (in packages/ask) connects to PI_SUBAGENT_SOCKET and sends:
 *   { type: "ask_request", requestId, questions } as a JSON line
 * and waits for:
 *   { type: "ask_response", requestId, cancelled, results } as a JSON line
 *
 * We forward the request onto the bus (ASK_REQUEST), the ask package shows the
 * parent TUI dialog, then emits ASK_RESPONSE on the bus, and we write it back
 * to the socket connection.
 *
 * Returns the socket path and a cleanup function.
 */
export function startAskSocketServer(
  agentName: string,
  idleWait?: IdleWaitCallbacks,
): { socketPath: string; cleanup: () => void } {
  // Use named pipes on Windows, Unix domain sockets elsewhere.
  // Linux socket path limit is 108 chars — keep it short.
  const id = randomUUID().slice(0, 8);
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pi-ask-${id}`
      : path.join(os.tmpdir(), `pi-ask-${id}.sock`);

  // Map pending requests to their socket so disconnects release paused idle leases.
  const pending = new Map<string, { socket: net.Socket; send: (response: unknown) => void }>();
  const finishPending = (requestId: string, response?: unknown): void => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    if (response !== undefined) request.send(response);
    idleWait?.resumeIdle();
  };

  // Listen for ASK_RESPONSE from the bus and route back to the waiting socket conn
  const unsubResponse = getBus().on(Events.ASK_RESPONSE, (payload: unknown) => {
    const data = payload as {
      requestId: string;
      cancelled: boolean;
      results: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
    };
    finishPending(data.requestId, {
      type: "ask_response",
      requestId: data.requestId,
      cancelled: data.cancelled,
      results: data.results,
    });
  });

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as {
            type: string;
            requestId: string;
            questions: unknown[];
          };
          if (
            msg.type === "ask_request" &&
            typeof msg.requestId === "string" &&
            msg.requestId.length > 0 &&
            Array.isArray(msg.questions) &&
            msg.questions.length > 0 &&
            msg.questions.every((question) => {
              if (!question || typeof question !== "object" || Array.isArray(question)) return false;
              const item = question as Record<string, unknown>;
              return typeof item.id === "string" && item.id.length > 0 &&
                typeof item.question === "string" && item.question.length > 0 &&
                Array.isArray(item.options) && item.options.length > 0 &&
                item.options.every((option) => {
                  if (!option || typeof option !== "object" || Array.isArray(option)) return false;
                  const label = (option as Record<string, unknown>).label;
                  return typeof label === "string" && label.length > 0;
                });
            })
          ) {
            // A duplicate request ID replaces and releases the prior pending wait.
            finishPending(msg.requestId);
            idleWait?.pauseIdle();
            pending.set(msg.requestId, {
              socket,
              send: (response) => {
                try {
                  socket.write(JSON.stringify(response) + "\n");
                } catch {
                  // socket already closed
                }
              },
            });
            // Forward to bus — ask package will show the TUI dialog
            getBus().emit(Events.ASK_REQUEST, {
              source: `subagent:${agentName}`,
              requestId: msg.requestId,
              questions: msg.questions as AskRequestPayload["questions"],
            });
          }
        } catch {
          // malformed JSON — ignore
        }
      }
    });

    socket.on("close", () => {
      for (const [requestId, request] of pending) {
        if (request.socket === socket) finishPending(requestId);
      }
    });
    socket.on("error", () => { /* connection dropped */ });
  });

  server.listen(socketPath);

  const cleanup = () => {
    unsubResponse();
    for (const requestId of [...pending.keys()]) finishPending(requestId);
    server.close();
    // Named pipes on Windows are cleaned up automatically; only unlink on Unix
    if (process.platform !== "win32") {
      try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    }
  };

  return { socketPath, cleanup };
}

export function buildSubagentArgs(
  options: SpawnOptions,
  childGuardPath = fileURLToPath(new URL("./child-guard.ts", import.meta.url)),
): string[] {
  const args: string[] = ["--mode", "json", "--no-session", "-p"];
  const model = resolveEffectiveModel(options);
  if (model) args.push("--model", model);
  const thinking = options.execution.profile.thinking;
  if (thinking) args.push("--thinking", thinking);

  const mode = options.execution.profile.mode;
  if (mode === "one-shot") {
    args.push("--no-tools", "--no-extensions", "--no-skills", "--no-context-files");
  } else if (options.agent?.tools && options.agent.tools.length > 0) {
    args.push("--tools", options.agent.tools.join(","));
  }

  const systemPrompt = options.agent?.systemPrompt?.trim() ||
    (mode === "one-shot" ? ONE_SHOT_SYSTEM_PROMPT : undefined);
  if (systemPrompt) args.push("--system-prompt", systemPrompt);

  if (options.execution.limits) args.push("--extension", childGuardPath);
  args.push(options.task);
  return args;
}

export function buildSpawnEnvironment(
  socketPath: string,
  limits: SubagentLimits | undefined,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnvironment, PI_SUBAGENT_SOCKET: socketPath };
  delete env[SUBAGENT_LIMITS_ENV];
  if (limits) env[SUBAGENT_LIMITS_ENV] = encodeLimitsEnvironment(limits);
  return env;
}

export function buildSpawnInvocation(
  piBinary: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const useNode = platform === "win32" && piBinary !== "pi";
  return {
    command: useNode ? process.execPath : piBinary,
    args: useNode ? [piBinary, ...args] : args,
  };
}

export function terminateChild(child: ChildProcess, graceMs = 3000): void {
  if (!child.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  forceKill.unref();
  child.once("exit", () => clearTimeout(forceKill));
}

// ponytail: short drain grace preserves final JSON; use explicit child IPC ack if 250ms proves insufficient.
export function scheduleTerminateChild(child: ChildProcess, drainMs = 250): void {
  if (!child.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => terminateChild(child), drainMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

/**
 * Spawn a subagent as a fresh `pi --mode json --no-session -p <task>` process.
 *
 * A Unix socket server is started in the parent to bridge the child's ask tool
 * back to the parent's TUI dialog. The socket path is passed via PI_SUBAGENT_SOCKET.
 */
export function spawnSubagent(options: SpawnOptions): ChildProcess {
  const piBinary = resolvePiBinary();
  const agentName = options.agent?.name ?? "general";
  const { socketPath, cleanup: cleanupSocket } = startAskSocketServer(agentName, options.idleWait);
  const invocation = buildSpawnInvocation(piBinary, buildSubagentArgs(options));

  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd || process.cwd(),
    env: buildSpawnEnvironment(socketPath, options.execution.limits),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.on("exit", cleanupSocket);
  child.on("error", cleanupSocket);

  if (options.signal) {
    const abortHandler = () => terminateChild(child);
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener("abort", abortHandler, { once: true });
    child.on("exit", () => options.signal!.removeEventListener("abort", abortHandler));
  }

  return child;
}
