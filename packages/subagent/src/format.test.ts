import { describe, it, expect } from "vitest";
import { buildStatsLine, truncLine } from "./format.js";

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

// ── truncLine ───────────────────────────────────────────────────────────────

describe("truncLine", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncLine("hello", 10)).toBe("hello");
  });

  it("truncates with '...' when exceeding limit", () => {
    expect(truncLine("hello world", 8)).toBe("hello...");
  });

  it("stops at newline boundary instead of bleeding into next line", () => {
    expect(truncLine("line one\nline two\nline three", 15)).toBe("line one...");
  });

  it("truncates first line if it itself exceeds limit", () => {
    expect(truncLine("this is a very long first line\nsecond", 12)).toBe("this is a...");
  });

  it("handles multiple consecutive newlines", () => {
    expect(truncLine("a\n\n\nb", 10)).toBe("a...");
  });

  it("handles text starting with newline", () => {
    expect(truncLine("\nhello", 10)).toBe("...");
  });
});
