import { describe, expect, it, vi } from "vitest";
import {
  BudgetTracker,
  decodeLimitStop,
  decodeLimitsEnvironment,
  encodeLimitStop,
  encodeLimitsEnvironment,
  normalizeLimits,
  registerChildLimitGuard,
  resolveLimits,
} from "./limits.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentLimits } from "./types.js";

const usage = (overrides: Record<string, unknown> = {}) => ({
  input: 4,
  output: 3,
  cacheRead: 2,
  cacheWrite: 1,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
  ...overrides,
});

describe("normalizeLimits", () => {
  it("treats zero-valued operator settings as unlimited", () => {
    expect(normalizeLimits({
      maxProviderRequests: 0,
      maxToolCalls: 0,
      maxTotalTokens: 0,
      maxCostUsd: 0,
      maxDurationMs: 0,
    }, true)).toBeUndefined();
  });

  it("rejects invalid and non-finite values", () => {
    expect(() => normalizeLimits({ maxProviderRequests: -1 }, true)).toThrow("maxProviderRequests");
    expect(() => normalizeLimits({ maxProviderRequests: 1.5 }, false)).toThrow("maxProviderRequests");
    expect(() => normalizeLimits({ maxCostUsd: Number.POSITIVE_INFINITY }, false)).toThrow("maxCostUsd");
    expect(() => normalizeLimits({ maxDurationMs: 2_147_483_648 }, false)).toThrow("maxDurationMs");
  });

  it("preserves valid field units", () => {
    expect(normalizeLimits({
      maxProviderRequests: 3,
      maxToolCalls: 4,
      maxTotalTokens: 5000,
      maxCostUsd: 0.75,
      maxDurationMs: 30_000,
    }, false)).toEqual({
      maxProviderRequests: 3,
      maxToolCalls: 4,
      maxTotalTokens: 5000,
      maxCostUsd: 0.75,
      maxDurationMs: 30_000,
    });
  });
});

describe("resolveLimits", () => {
  it("uses the strictest operator, top-level, and task value", () => {
    const operator: SubagentLimits = { maxProviderRequests: 8, maxCostUsd: 2, maxDurationMs: 60_000 };
    const topLevel: SubagentLimits = { maxProviderRequests: 6, maxCostUsd: 1.5 };
    const task: SubagentLimits = { maxProviderRequests: 7, maxCostUsd: 1, maxToolCalls: 12 };

    expect(resolveLimits(operator, topLevel, task)).toEqual({
      maxProviderRequests: 6,
      maxToolCalls: 12,
      maxCostUsd: 1,
      maxDurationMs: 60_000,
    });
  });

  it("returns undefined when every source is unlimited", () => {
    expect(resolveLimits(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("BudgetTracker", () => {
  it("denies provider request N+1 before dispatch", () => {
    const onStop = vi.fn();
    const tracker = new BudgetTracker({ maxProviderRequests: 2 }, onStop);

    expect(tracker.admitProviderRequest()).toBe(true);
    expect(tracker.admitProviderRequest()).toBe(true);
    expect(tracker.admitProviderRequest()).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(tracker.termination).toMatchObject({
      reason: "request-limit",
      limit: 2,
      observed: 2,
      usageState: "complete",
    });
  });

  it("denies tool call N+1 before execution", () => {
    const tracker = new BudgetTracker({ maxToolCalls: 1 }, vi.fn());

    expect(tracker.admitToolCall()).toBe(true);
    expect(tracker.admitToolCall()).toBe(false);
    expect(tracker.termination).toMatchObject({ reason: "tool-limit", limit: 1, observed: 1 });
  });

  it("stops after one-response token overshoot", () => {
    const tracker = new BudgetTracker({ maxTotalTokens: 9 }, vi.fn());

    tracker.observeAssistantUsage(usage());

    expect(tracker.termination).toMatchObject({ reason: "token-limit", limit: 9, observed: 10 });
  });

  it("stops before another request when tokens exactly reach the limit", () => {
    const tracker = new BudgetTracker({ maxTotalTokens: 10 }, vi.fn());

    tracker.observeAssistantUsage(usage());
    expect(tracker.termination).toBeUndefined();
    expect(tracker.admitProviderRequest()).toBe(false);
    expect(tracker.termination).toMatchObject({ reason: "token-limit", observed: 10 });
  });

  it("stops after one-response cost overshoot", () => {
    const tracker = new BudgetTracker({ maxCostUsd: 0.03 }, vi.fn());

    tracker.observeAssistantUsage(usage());

    expect(tracker.termination).toMatchObject({ reason: "cost-limit", limit: 0.03, observed: 0.037 });
  });

  it("fails closed when guarded usage is missing", () => {
    const tracker = new BudgetTracker({ maxTotalTokens: 100 }, vi.fn());

    tracker.observeAssistantUsage(undefined);

    expect(tracker.termination).toMatchObject({ reason: "usage-unknown", usageState: "unknown" });
  });

  it("emits only the first stop", () => {
    const onStop = vi.fn();
    const tracker = new BudgetTracker({ maxProviderRequests: 1, maxToolCalls: 1 }, onStop);

    tracker.admitProviderRequest();
    tracker.admitProviderRequest();
    tracker.admitToolCall();
    tracker.admitToolCall();

    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("limits environment", () => {
  it("round-trips a validated non-empty limit object", () => {
    const limits = { maxProviderRequests: 2, maxDurationMs: 1000 };
    expect(decodeLimitsEnvironment(encodeLimitsEnvironment(limits))).toEqual(limits);
  });

  it("rejects malformed or empty environment values", () => {
    expect(() => decodeLimitsEnvironment("not-json")).toThrow("limits environment");
    expect(() => decodeLimitsEnvironment("{}")) .toThrow("limits environment");
  });
});

describe("registerChildLimitGuard", () => {
  function fakePi() {
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
    const pi = {
      on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  }

  const context = (abort = vi.fn()) => ({ abort }) as unknown as ExtensionContext;

  it("aborts request N+1 before provider dispatch", () => {
    const { pi, handlers } = fakePi();
    const writeStop = vi.fn();
    const abort = vi.fn();
    registerChildLimitGuard(pi, { maxProviderRequests: 1 }, writeStop);

    handlers.get("before_provider_request")?.({}, context(abort));
    handlers.get("before_provider_request")?.({}, context(abort));

    expect(writeStop).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(decodeLimitStop(writeStop.mock.calls[0]![0])).toMatchObject({ reason: "request-limit" });
  });

  it("blocks and aborts tool call N+1", () => {
    const { pi, handlers } = fakePi();
    const abort = vi.fn();
    registerChildLimitGuard(pi, { maxToolCalls: 1 }, vi.fn());

    expect(handlers.get("tool_call")?.({}, context(abort))).toBeUndefined();
    expect(handlers.get("tool_call")?.({}, context(abort))).toEqual({
      block: true,
      reason: "Subagent tool-call limit reached",
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("observes assistant usage and cancels compaction", () => {
    const { pi, handlers } = fakePi();
    const abort = vi.fn();
    registerChildLimitGuard(pi, { maxTotalTokens: 9 }, vi.fn());

    handlers.get("message_end")?.({ message: { role: "assistant", usage: usage() } }, context(abort));

    expect(abort).toHaveBeenCalledTimes(1);
    expect(handlers.get("session_before_compact")?.({}, context())).toEqual({ cancel: true });
  });
});

describe("limit stop marker", () => {
  it("round-trips structured termination evidence", () => {
    const marker = encodeLimitStop({
      reason: "time-limit",
      limit: 1000,
      observed: 1001,
      usageState: "partial",
    });

    expect(decodeLimitStop(marker)).toEqual({
      reason: "time-limit",
      limit: 1000,
      observed: 1001,
      usageState: "partial",
    });
  });

  it("ignores ordinary or malformed stderr", () => {
    expect(decodeLimitStop("ordinary stderr")).toBeUndefined();
    expect(decodeLimitStop("PI_ARCHIMEDES_LIMIT_STOP not-json")).toBeUndefined();
  });
});
