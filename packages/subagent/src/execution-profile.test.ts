import { describe, expect, it } from "vitest";
import {
  ONE_SHOT_LIMITS,
  ONE_SHOT_SYSTEM_PROMPT,
  resolveChildExecution,
  resolveExecutionProfile,
} from "./execution-profile.js";
import { resolveLimits } from "./limits.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./config.js";
import { validateDispatchPolicy } from "./dispatch-policy.js";

describe("resolveExecutionProfile", () => {
  it("defaults to agentic mode without a thinking override", () => {
    expect(resolveExecutionProfile({})).toEqual({ mode: "agentic", thinking: undefined });
  });

  it("lets a parallel task override top-level mode and thinking", () => {
    expect(resolveExecutionProfile({
      topLevel: { mode: "one-shot", thinking: "low" },
      task: { mode: "agentic", thinking: "high" },
    })).toEqual({ mode: "agentic", thinking: "high" });
  });

  it("keeps explicit agent thinking authoritative", () => {
    expect(resolveExecutionProfile({
      topLevel: { thinking: "low" },
      task: { thinking: "high" },
      agentThinking: "xhigh",
    })).toEqual({ mode: "agentic", thinking: "xhigh" });
  });
});

describe("resolveChildExecution", () => {
  it("composes the one-shot request and output caps with explicit caller limits", () => {
    expect(resolveChildExecution({
      operatorLimits: { maxDurationMs: 300_000 },
      topLevel: {
        mode: "one-shot",
        limits: { maxProviderRequests: 4, maxOutputTokens: 32_768, maxDurationMs: 240_000 },
      },
      task: { limits: { maxOutputTokens: 16_384 } },
    })).toEqual({
      profile: { mode: "one-shot", thinking: undefined },
      limits: { maxProviderRequests: 1, maxOutputTokens: 16_384, maxDurationMs: 240_000 },
    });
  });

  it("rejects one-shot cumulative token and cost limits", () => {
    expect(() => resolveChildExecution({
      topLevel: { mode: "one-shot", limits: { maxTotalTokens: 100 } },
    })).toThrow("maxTotalTokens");
    expect(() => resolveChildExecution({
      operatorLimits: { maxCostUsd: 1 },
      topLevel: { mode: "one-shot" },
    })).toThrow("maxCostUsd");
  });

  it("rejects provider output caps for agentic children", () => {
    expect(() => resolveChildExecution({
      topLevel: { limits: { maxOutputTokens: 16_384 } },
    })).toThrow("one-shot");
  });

  it("keeps sibling task modes independent", () => {
    const oneShot = resolveChildExecution({
      topLevel: { mode: "agentic" },
      task: { mode: "one-shot" },
    });
    const agentic = resolveChildExecution({
      topLevel: { mode: "agentic" },
      task: { mode: "agentic" },
    });

    expect(oneShot.limits).toEqual(ONE_SHOT_LIMITS);
    expect(agentic.limits).toBeUndefined();
  });

  it("makes one-shot runs reject provider retries", () => {
    const execution = resolveChildExecution({ task: { mode: "one-shot" } });
    expect(() => validateDispatchPolicy(DEFAULT_SUBAGENT_CONFIG, [{
      limits: execution.limits,
      providerMaxRetries: 1,
    }])).toThrow("retry.provider.maxRetries");
  });
});

describe("one-shot defaults", () => {
  it("enforces one provider request without adding a wall-time limit", () => {
    expect(ONE_SHOT_LIMITS).toEqual({ maxProviderRequests: 1 });
    expect(resolveLimits(
      { maxDurationMs: 120_000 },
      { maxProviderRequests: 4, maxDurationMs: 240_000 },
      ONE_SHOT_LIMITS,
    )).toEqual({ maxProviderRequests: 1, maxDurationMs: 120_000 });
  });

  it("uses a packet-only default system prompt", () => {
    expect(ONE_SHOT_SYSTEM_PROMPT).toContain("complete context packet");
    expect(ONE_SHOT_SYSTEM_PROMPT).toContain("no tools");
  });
});
