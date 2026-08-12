import { describe, expect, it } from "vitest";
import { addUsage, fromSubagentUsage, isUsage, readUsage, toSubagentUsage } from "./usage.js";

describe("usage normalization", () => {
  it("distinguishes complete canonical usage from malformed input", () => {
    expect(isUsage(readUsage(undefined))).toBe(true);
    expect(isUsage({ ...readUsage(undefined), input: "bad" })).toBe(false);
    expect(isUsage({ input: 0, output: 0 })).toBe(false);
  });

  it("normalizes one untrusted Pi usage object", () => {
    expect(readUsage({
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: -3,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, total: 0.033 },
    })).toEqual({
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 },
    });
  });

  it("combines finalized and in-flight usage", () => {
    expect(addUsage(
      readUsage({ input: 4, output: 2, cost: { total: 0.03 } }),
      readUsage({ input: 1, cacheRead: 3, cost: { cacheRead: 0.01, total: 0.01 } }),
    )).toEqual({
      input: 5,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.04 },
    });
  });

  it("preserves the existing public subagent usage shape", () => {
    const usage = readUsage({
      input: 4,
      output: 2,
      cost: { input: 0.01, output: 0.02, total: 0.03 },
    });
    const publicUsage = toSubagentUsage(usage, 1);

    expect(publicUsage).toEqual({
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.03,
      costBreakdown: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      turns: 1,
    });
    expect(fromSubagentUsage(publicUsage)).toEqual(usage);
  });

  it("keeps malformed public usage finite", () => {
    expect(fromSubagentUsage({
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: Number.NaN,
      turns: 1,
    })).toEqual(readUsage({ input: 4, output: 2 }));
  });
});
