import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_CONFIG } from "./config.js";
import { resolveConfiguredLimits, validateDispatchPolicy } from "./dispatch-policy.js";

describe("subagent dispatch policy", () => {
  it("resolves zero-valued operator defaults as unlimited", () => {
    expect(resolveConfiguredLimits(DEFAULT_SUBAGENT_CONFIG)).toBeUndefined();
    expect(resolveConfiguredLimits({
      ...DEFAULT_SUBAGENT_CONFIG,
      defaultLimits: { ...DEFAULT_SUBAGENT_CONFIG.defaultLimits, maxProviderRequests: 3 },
    })).toEqual({ maxProviderRequests: 3 });
  });

  it("rejects fanout above the operator ceiling before spawn", () => {
    expect(() => validateDispatchPolicy(
      { ...DEFAULT_SUBAGENT_CONFIG, maxParallel: 2 },
      [
        { limits: undefined, providerMaxRetries: 0 },
        { limits: undefined, providerMaxRetries: 0 },
        { limits: undefined, providerMaxRetries: 0 },
      ],
    )).toThrow("maxParallel");
  });

  it("rejects provider retries only for bounded runs", () => {
    expect(() => validateDispatchPolicy(DEFAULT_SUBAGENT_CONFIG, [
      { limits: { maxProviderRequests: 2 }, providerMaxRetries: 1 },
    ])).toThrow("retry.provider.maxRetries");
    expect(() => validateDispatchPolicy(DEFAULT_SUBAGENT_CONFIG, [
      { limits: undefined, providerMaxRetries: 1 },
    ])).not.toThrow();
  });
});
