import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSpawnEnvironment,
  buildSpawnInvocation,
  buildSubagentArgs,
  scheduleTerminateChild,
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

describe("bounded spawn", () => {
  afterEach(() => vi.useRealTimers());

  it("loads the dedicated child guard and preserves existing isolation args", () => {
    const args = buildSubagentArgs(options(), "/package/src/child-guard.ts");

    expect(args).toEqual([
      "--mode", "json", "--no-session", "-p",
      "--model", "openai/gpt-5",
      "--extension", "/package/src/child-guard.ts",
      "review this",
    ]);
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

  it("loads the real guard in one-shot mode with discovery disabled", () => {
    const temp = mkdtempSync(join(tmpdir(), "archimedes-one-shot-"));
    const agentDir = join(temp, "agent");
    const extension = join(temp, "marker.ts");
    mkdirSync(agentDir);
    writeFileSync(extension, `export default function (pi) {
      process.stderr.write("EXPLICIT_EXTENSION_LOADED\\n");
      pi.on("input", () => ({ action: "handled" }));
    }`);
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const codingAgentPackage = realpathSync(join(
      packageRoot,
      "node_modules/@earendil-works/pi-coding-agent",
    ));
    const cli = join(codingAgentPackage, "dist/cli.js");
    const childGuard = join(packageRoot, "src/child-guard.ts");
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
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        env: buildSpawnEnvironment("unused.sock", spawnOptions.execution.limits, {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        }),
      });

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
