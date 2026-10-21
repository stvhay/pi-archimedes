import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, saveConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  saveConfigMock: vi.fn(),
}));

vi.mock("@pi-archimedes/core/settings-io", () => ({
  loadConfig: loadConfigMock,
  saveConfig: saveConfigMock,
}));

import {
  DEFAULT_SUBAGENT_CONFIG,
  getSubagentSettingsItems,
  loadSubagentConfig,
  loadSubagentConfigOrDefault,
  saveSubagentConfig,
} from "./config.js";

describe("subagent config", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    saveConfigMock.mockReset();
  });

  it("loads unlimited defaults", () => {
    loadConfigMock.mockReturnValue(DEFAULT_SUBAGENT_CONFIG);

    expect(loadSubagentConfig()).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  it("merges a partial nested defaultLimits object", () => {
    loadConfigMock.mockReturnValue({
      maxParallel: 2,
      defaultLimits: { maxProviderRequests: 3 },
    });

    expect(loadSubagentConfig()).toEqual({
      maxParallel: 2,
      defaultLimits: {
        maxProviderRequests: 3,
        maxToolCalls: 0,
        maxTotalTokens: 0,
        maxCostUsd: 0,
        maxDurationMs: 0,
        maxIdleMs: 0,
      },
    });
  });

  it("fails closed on malformed settings", () => {
    loadConfigMock.mockReturnValue({
      maxParallel: 1.5,
      defaultLimits: { maxCostUsd: "lots" },
    });
    expect(() => loadSubagentConfig()).toThrow("maxParallel");

    loadConfigMock.mockReturnValue({ maxParallel: 0, defaultLimits: [] });
    expect(() => loadSubagentConfig()).toThrow("defaultLimits");
  });

  it("falls back to a fresh default object for settings repair", () => {
    loadConfigMock.mockReturnValue({ maxParallel: -1 });

    const config = loadSubagentConfigOrDefault();
    expect(config).toEqual(DEFAULT_SUBAGENT_CONFIG);
    expect(config).not.toBe(DEFAULT_SUBAGENT_CONFIG);
    expect(config.defaultLimits).not.toBe(DEFAULT_SUBAGENT_CONFIG.defaultLimits);
  });

  it("saves under the subagent namespace", () => {
    saveSubagentConfig(DEFAULT_SUBAGENT_CONFIG);

    expect(saveConfigMock).toHaveBeenCalledWith("archimedes.subagent", DEFAULT_SUBAGENT_CONFIG);
  });

  it("exposes every operator ceiling to the composed settings UI", () => {
    const items = getSubagentSettingsItems(DEFAULT_SUBAGENT_CONFIG);

    expect(items.map((item) => item.id)).toEqual([
      "subagentMaxParallel",
      "subagentMaxProviderRequests",
      "subagentMaxToolCalls",
      "subagentMaxTotalTokens",
      "subagentMaxCostUsd",
      "subagentMaxDurationMs",
      "subagentMaxIdleMs",
    ]);
    expect(items.every((item) => item.currentValue === "0")).toBe(true);
  });
});
