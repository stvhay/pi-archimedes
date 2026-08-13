import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  loadFooterConfig: () => ({ splitThreshold: 150 }),
}));
vi.mock("./utils/git.js", () => ({
  getGitStatus: () => ({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 }),
  getWorktreeBranch: () => undefined,
}));
vi.mock("./utils/stats.js", () => ({
  getTokenUsageStats: () => ({
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
  }),
  getContextWindowInfo: () => ({ percent: "0%", percentValue: 0, windowSize: 1000 }),
}));

import { registerFooter } from "./index.js";

describe("registerFooter", () => {
  it("renders extension statuses using Pi's single-line footer contract", () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
    const pi = {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
      getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI;
    let footerFactory: any;
    const ctx = {
      model: { id: "test-model" },
      ui: { setFooter: (factory: unknown) => { footerFactory = factory; } },
    } as unknown as ExtensionContext;

    registerFooter(pi);
    handlers.get("session_start")!({}, ctx);

    const theme = { fg: (_token: string, text: string) => text };
    const component = footerFactory(
      { requestRender() {} },
      theme,
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([
          ["z-status", "Second\nline"],
          ["a-status", "First"],
        ]),
        onBranchChange: () => () => {},
      },
    );

    expect(component.render(200).at(-1)).toBe("First Second line");
    expect(visibleWidth(component.render(12).at(-1))).toBeLessThanOrEqual(12);
  });
});
