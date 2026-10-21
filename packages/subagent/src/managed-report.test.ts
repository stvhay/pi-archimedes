import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { SUBAGENT_OUTPUT_SCHEMA, subagentStructuredContent } from "./tool-schema.js";
import type { SubagentResult } from "./types.js";

function child(): SubagentResult {
  return {
    agent: "peer", task: "review", exitCode: 2,
    childSessionId: "session", childTrace: { sessionId: "session", traceId: "trace" },
    provider: "test", model: "model", outputContract: "artifact",
    execution: {
      profile: { mode: "one-shot", thinking: "high" },
      limits: { maxProviderRequests: 1, maxOutputTokens: 100 },
      outputLimit: { requested: 100, effective: 80, enforcement: "applied" },
    },
    termination: { reason: "output-limit", limit: 80, observed: 80, usageState: "complete" },
    finalOutput: "partial", error: "Subagent stopped: output-limit",
    usage: {
      input: 10, output: 80, cacheRead: 2, cacheWrite: 1, cost: 0.1, turns: 1,
      costBreakdown: { input: 0.01, output: 0.09, cacheRead: 0, cacheWrite: 0, total: 0.1 },
    },
  };
}

describe("managed structured reports", () => {
  it("preserves public execution, termination, identity and cost evidence", () => {
    const result = child();
    const report = subagentStructuredContent("parallel", [result]);
    expect(report.results[0]).toMatchObject({
      childTrace: result.childTrace, provider: result.provider, execution: result.execution,
      termination: result.termination, outputContract: "artifact",
      usage: { costBreakdown: result.usage.costBreakdown },
    });
    expect(Value.Check(SUBAGENT_OUTPUT_SCHEMA, report)).toBe(true);
    expect(report.results[0]).not.toHaveProperty("progress");
  });

  it("validates managed evidence instead of treating it as unknown extra properties", () => {
    const report = subagentStructuredContent("parallel", [child()]);
    const invalid = { ...report, results: [{ ...report.results[0], termination: { reason: "invented", usageState: "complete" } }] };
    expect(Value.Check(SUBAGENT_OUTPUT_SCHEMA, invalid)).toBe(false);
  });

  it("copies nested evidence rather than sharing mutable source objects", () => {
    const result = child();
    const report = subagentStructuredContent("parallel", [result]);
    result.execution!.limits!.maxOutputTokens = 999;
    result.execution!.outputLimit!.requested = 999;
    result.childTrace!.sessionId = "changed";
    expect(report.results[0]).toMatchObject({
      childTrace: { sessionId: "session" },
      execution: { limits: { maxOutputTokens: 100 }, outputLimit: { requested: 100 } },
    });
  });
});
