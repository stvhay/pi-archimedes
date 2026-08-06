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
      topLevelMode: "one-shot",
      taskMode: "agentic",
      topLevelThinking: "low",
      taskThinking: "high",
    })).toEqual({ mode: "agentic", thinking: "high" });
  });

  it("keeps explicit agent thinking authoritative", () => {
    expect(resolveExecutionProfile({
      topLevelThinking: "low",
      taskThinking: "high",
      agentThinking: "xhigh",
    })).toEqual({ mode: "agentic", thinking: "xhigh" });
  });
});

describe("resolveChildExecution", () => {
  it("composes immutable one-shot limits with stricter caller limits", () => {
    expect(resolveChildExecution({
      topLevelMode: "one-shot",
      operatorLimits: { maxDurationMs: 120_000 },
      topLevelLimits: { maxProviderRequests: 4, maxDurationMs: 240_000 },
    })).toEqual({
      profile: { mode: "one-shot", thinking: undefined },
      limits: { maxProviderRequests: 1, maxDurationMs: 120_000 },
    });
  });

  it("keeps sibling task modes independent", () => {
    const oneShot = resolveChildExecution({ topLevelMode: "agentic", taskMode: "one-shot" });
    const agentic = resolveChildExecution({ topLevelMode: "agentic", taskMode: "agentic" });

    expect(oneShot.limits).toEqual(ONE_SHOT_LIMITS);
    expect(agentic.limits).toBeUndefined();
  });

  it("makes one-shot runs reject provider retries", () => {
    const execution = resolveChildExecution({ taskMode: "one-shot" });
    expect(() => validateDispatchPolicy(DEFAULT_SUBAGENT_CONFIG, [{
      limits: execution.limits,
      providerMaxRetries: 1,
    }])).toThrow("retry.provider.maxRetries");
  });
});

describe("one-shot defaults", () => {
  it("enforces one provider request and a 180-second deadline", () => {
    expect(ONE_SHOT_LIMITS).toEqual({ maxProviderRequests: 1, maxDurationMs: 180_000 });
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
