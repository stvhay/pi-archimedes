import { describe, it, expect } from "vitest";
import { buildStatsLine } from "./format.js";

// ── buildStatsLine ─────────────────────────────────────────────────────────

describe("buildStatsLine", () => {
  const theme = { fg: (_token: string, text: string) => text };

  it("shows current-turn and cumulative tokens only after the first turn", () => {
    const oneTurn = buildStatsLine({
      turns: 1,
      toolCount: 0,
      turnTokens: 1_200,
      tokens: 1_200,
      durationMs: 0,
      cost: 0,
    }, theme);
    expect(oneTurn).toContain("1k tok");
    expect(oneTurn).not.toContain("turn /");
    expect(oneTurn).not.toContain("total tok");

    const multiTurn = buildStatsLine({
      turns: 2,
      toolCount: 0,
      turnTokens: 1_200,
      tokens: 8_400,
      durationMs: 0,
      cost: 0,
    }, theme);
    expect(multiTurn).toContain("1k turn / 8k total tok");
    expect(multiTurn).not.toContain("· 8k tok");
  });
});
