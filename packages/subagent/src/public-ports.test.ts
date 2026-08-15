import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentModel } from "@pi-archimedes/subagent/agents";
import {
  SUBAGENT_OUTPUT_CONTRACTS,
  type SubagentDetails,
  type SubagentResult,
  type SubagentToolResult,
} from "@pi-archimedes/subagent/types";

describe("public subagent ports", () => {
  it("exports complete result and tool-result contracts", () => {
    const result: SubagentResult = {
      agent: "reviewer",
      task: "Review",
      childSessionId: "child-session",
      childTrace: { sessionId: "child-session" },
      exitCode: 2,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        cost: 0.1,
        turns: 1,
      },
      provider: "test-provider",
      model: "test-model",
      execution: {
        profile: { mode: "one-shot", thinking: "high" },
        limits: { maxProviderRequests: 1, maxOutputTokens: 16_384 },
        outputLimit: { requested: 16_384, enforcement: "unsupported" },
      },
      outputContract: "artifact",
      finalOutput: "usable partial",
      error: "Subagent stopped: output-limit",
      termination: {
        reason: "output-limit",
        observed: 8_192,
        usageState: "complete",
      },
      progress: undefined,
      progressSummary: { toolCount: 0, tokens: 18, durationMs: 1 },
    };
    const details: SubagentDetails = { mode: "single", results: [result] };
    const toolResult: SubagentToolResult = {
      content: [{ type: "text", text: "stopped" }],
      details,
      isError: true,
    };

    expect(SUBAGENT_OUTPUT_CONTRACTS).toEqual([
      "inline",
      "artifact",
      "status-only",
      "pass-no-findings",
    ]);
    expect(toolResult.details.results[0]?.childTrace?.sessionId).toBe("child-session");
    expect(toolResult.details.results[0]?.finalOutput).toBe("usable partial");
  });

  it("resolves the configured model through public agent discovery", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "archimedes-public-agent-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(agentDir, "agents"));
    writeFileSync(join(agentDir, "agents", "reviewer.md"), [
      "---",
      "name: reviewer",
      "description: Review changes",
      "model: frontmatter/model",
      "---",
      "",
      "Review carefully.",
    ].join("\n"));
    writeFileSync(join(agentDir, "agents.local.json"), JSON.stringify({
      reviewer: { model: "local/model" },
    }));

    try {
      expect(resolveAgentModel("reviewer", process.cwd())).toBe("local/model");
      expect(resolveAgentModel("missing", process.cwd())).toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
