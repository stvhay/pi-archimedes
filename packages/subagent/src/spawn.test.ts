import { EventEmitter, once } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Events, getBus } from "@pi-archimedes/core/bus";
import {
  buildSpawnEnvironment,
  buildSpawnInvocation,
  buildSubagentArgs,
  resolveEffectiveModel,
  scheduleTerminateChild,
  startAskSocketServer,
  terminateChild,
} from "./spawn.js";

function options() {
  return {
    task: "review this",
    model: "openai/gpt-5",
    activeModel: undefined,
    cwd: "/work",
    signal: undefined,
    agent: undefined,
    execution: {
      profile: { mode: "agentic" as const, thinking: undefined },
      limits: { maxProviderRequests: 2 },
    },
  };
}

function runOffline(args: string[], limits: { maxProviderRequests: number }, agentDir: string) {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const codingAgentPackage = realpathSync(join(
    packageRoot,
    "node_modules/@earendil-works/pi-coding-agent",
  ));
  return spawnSync(process.execPath, [join(codingAgentPackage, "dist/cli.js"), ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: buildSpawnEnvironment("unused.sock", limits, {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    }),
  });
}

describe("ask idle lifecycle", () => {
  async function connect(socketPath: string) {
    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(true));
    const socket = createConnection(socketPath);
    await once(socket, "connect");
    return socket;
  }

  it("pauses idle for a pending human response and resumes after the answer", async () => {
    const pauseIdle = vi.fn();
    const resumeIdle = vi.fn();
    const unsubscribeRequest = getBus().on(Events.ASK_REQUEST, () => undefined);
    const server = startAskSocketServer("reviewer", { pauseIdle, resumeIdle });
    const socket = await connect(server.socketPath);

    try {
      socket.write(`${JSON.stringify({
        type: "ask_request",
        requestId: "request-answer",
        questions: [{ id: "question", question: "Continue?", options: [{ label: "Yes" }] }],
      })}\n`);
      await vi.waitFor(() => expect(pauseIdle).toHaveBeenCalledTimes(1));

      getBus().emit(Events.ASK_RESPONSE, {
        requestId: "request-answer",
        cancelled: false,
        results: [],
      });
      await vi.waitFor(() => expect(resumeIdle).toHaveBeenCalledTimes(1));
    } finally {
      socket.destroy();
      server.cleanup();
      unsubscribeRequest();
    }
  });

  it("does not pause idle for an invalid empty question packet", async () => {
    const pauseIdle = vi.fn();
    const resumeIdle = vi.fn();
    const unsubscribeRequest = getBus().on(Events.ASK_REQUEST, () => undefined);
    const server = startAskSocketServer("reviewer", { pauseIdle, resumeIdle });
    const socket = await connect(server.socketPath);

    try {
      socket.write([
        JSON.stringify({ type: "ask_request", requestId: "request-invalid", questions: [] }),
        JSON.stringify({ type: "ask_request", requestId: "request-invalid-shape", questions: [{ id: "question" }] }),
        JSON.stringify({ type: "ask_request", requestId: "request-valid", questions: [{ id: "question", question: "Continue?", options: [{ label: "Yes" }] }] }),
        "",
      ].join("\n"));
      await vi.waitFor(() => expect(pauseIdle).toHaveBeenCalledTimes(1));
      expect(resumeIdle).not.toHaveBeenCalled();
      getBus().emit(Events.ASK_RESPONSE, {
        requestId: "request-valid",
        cancelled: true,
        results: [],
      });
      await vi.waitFor(() => expect(resumeIdle).toHaveBeenCalledTimes(1));
    } finally {
      socket.destroy();
      server.cleanup();
      unsubscribeRequest();
    }
  });

  it("resumes idle when a pending ask socket disconnects", async () => {
    const pauseIdle = vi.fn();
    const resumeIdle = vi.fn();
    const unsubscribeRequest = getBus().on(Events.ASK_REQUEST, () => undefined);
    const server = startAskSocketServer("reviewer", { pauseIdle, resumeIdle });
    const socket = await connect(server.socketPath);

    try {
      socket.write(`${JSON.stringify({
        type: "ask_request",
        requestId: "request-disconnect",
        questions: [{ id: "question", question: "Continue?", options: [{ label: "Yes" }] }],
      })}\n`);
      await vi.waitFor(() => expect(pauseIdle).toHaveBeenCalledTimes(1));
      socket.destroy();
      await once(socket, "close");
      await vi.waitFor(() => expect(resumeIdle).toHaveBeenCalledTimes(1));
    } finally {
      server.cleanup();
      unsubscribeRequest();
    }
  });
});

describe("bounded spawn", () => {
  afterEach(() => vi.useRealTimers());

  it("loads the dedicated child guard and preserves existing agentic args", () => {
    expect(buildSubagentArgs(options(), "/package/src/child-guard.ts")).toEqual([
      "--mode", "json", "--no-session", "-p",
      "--model", "openai/gpt-5",
      "--extension", "/package/src/child-guard.ts",
      "review this",
    ]);
  });

  it("resolves the displayed model from agent, call, then active parent", () => {
    expect(resolveEffectiveModel({ ...options(), agent: { model: "agent/model" } } as any)).toBe("agent/model");
    expect(resolveEffectiveModel(options())).toBe("openai/gpt-5");
    expect(resolveEffectiveModel({ ...options(), model: undefined, activeModel: "parent/model" })).toBe("parent/model");
  });

  it("isolates one-shot children while explicitly loading only the guard", () => {
    const args = buildSubagentArgs({
      ...options(),
      agent: {
        name: "reviewer",
        description: "review",
        source: "user",
        filePath: "/agents/reviewer.md",
        model: "openai/gpt-5",
        thinking: "high",
        tools: ["read", "bash"],
        systemPrompt: "Agent review prompt",
      },
      execution: {
        profile: { mode: "one-shot", thinking: "high" },
        limits: { maxProviderRequests: 1 },
      },
    }, "/package/src/child-guard.ts");

    expect(args).toEqual([
      "--mode", "json", "--no-session", "-p",
      "--model", "openai/gpt-5",
      "--thinking", "high",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--system-prompt", "Agent review prompt",
      "--extension", "/package/src/child-guard.ts",
      "review this",
    ]);
    expect(args).not.toContain("--no-prompt-templates");
    expect(args).not.toContain("--tools");
  });

  it("uses the packet-only prompt and explicit thinking without an agent", () => {
    const args = buildSubagentArgs({
      ...options(),
      execution: {
        profile: { mode: "one-shot", thinking: "low" },
        limits: { maxProviderRequests: 1 },
      },
    }, "/package/src/child-guard.ts");

    expect(args).toContain("low");
    expect(args).toContain("You are a read-only peer. Treat the task as a complete context packet. You have no tools or ambient project context. Return one final response.");
  });

  it("loads the real child guard for bounded agentic execution", () => {
    const temp = mkdtempSync(join(tmpdir(), "archimedes-child-guard-"));
    const agentDir = join(temp, "agent");
    const markerExtension = join(temp, "marker.ts");
    mkdirSync(agentDir);
    writeFileSync(markerExtension, `export default function (pi) {
      process.stderr.write("EXPLICIT_EXTENSION_LOADED\\n");
      pi.on("input", () => ({ action: "handled" }));
    }`);
    const childGuard = join(dirname(fileURLToPath(import.meta.url)), "child-guard.ts");
    const spawnOptions = { ...options(), model: undefined };
    const args = buildSubagentArgs(spawnOptions, childGuard);
    args.splice(-1, 0, "--extension", markerExtension);

    try {
      const result = runOffline(args, spawnOptions.execution.limits, agentDir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("EXPLICIT_EXTENSION_LOADED");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("loads explicit extensions in one-shot mode with discovery disabled", () => {
    const temp = mkdtempSync(join(tmpdir(), "archimedes-one-shot-"));
    const agentDir = join(temp, "agent");
    const extension = join(temp, "marker.ts");
    mkdirSync(agentDir);
    writeFileSync(extension, `export default function (pi) {
      process.stderr.write("EXPLICIT_EXTENSION_LOADED\\n");
      pi.on("input", () => ({ action: "handled" }));
    }`);
    const childGuard = join(dirname(fileURLToPath(import.meta.url)), "child-guard.ts");
    const spawnOptions = {
      ...options(),
      model: undefined,
      execution: {
        profile: { mode: "one-shot" as const, thinking: "low" },
        limits: { maxProviderRequests: 1 },
      },
    };
    const args = buildSubagentArgs(spawnOptions, childGuard);
    args.splice(-1, 0, "--extension", extension);

    try {
      const result = runOffline(args, spawnOptions.execution.limits, agentDir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("EXPLICIT_EXTENSION_LOADED");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("does not load the guard for an unlimited agentic child", () => {
    const args = buildSubagentArgs({
      ...options(),
      execution: {
        profile: { mode: "agentic", thinking: undefined },
        limits: undefined,
      },
    }, "/missing/child-guard.ts");

    expect(args).not.toContain("--extension");
    expect(args).not.toContain("/missing/child-guard.ts");
  });

  it("passes validated limits without dropping inherited environment", () => {
    const env = buildSpawnEnvironment("/tmp/ask.sock", { maxProviderRequests: 2 }, { PATH: "/bin" });

    expect(env).toMatchObject({
      PATH: "/bin",
      PI_SUBAGENT_SOCKET: "/tmp/ask.sock",
      PI_ARCHIMEDES_SUBAGENT_LIMITS: '{"maxProviderRequests":2}',
    });
  });

  it("keeps the Windows node-plus-script invocation shape", () => {
    expect(buildSpawnInvocation("C:\\pi\\dist\\cli.js", ["--mode", "json"], "win32")).toEqual({
      command: process.execPath,
      args: ["C:\\pi\\dist\\cli.js", "--mode", "json"],
    });
    expect(buildSpawnInvocation("/usr/bin/pi", ["--mode", "json"], "linux")).toEqual({
      command: "/usr/bin/pi",
      args: ["--mode", "json"],
    });
  });

  it("falls back from SIGTERM to SIGKILL while the process is still alive", () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });

    terminateChild(child, 3000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("gives stdout a drain window before terminating a limited child", () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });

    scheduleTerminateChild(child, 250);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cancels the force-kill timer after exit", () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });

    terminateChild(child, 3000);
    child.emit("exit", 0, null);
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
