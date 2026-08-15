import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CostAccumulator } from "./cost-accumulator.js";
import { getBus, Events, type CostUpdatePayload } from "@pi-archimedes/core/bus";

// ── globalThis cleanup ──────────────────────────────────────────────────────

const BUS_KEY = Symbol.for("archimedes:bus");
const QUEUE_KEY = Symbol.for("archimedes:busQueue");

function emitCost(payload: Omit<CostUpdatePayload, "source">): void {
  getBus().emit(Events.COST_UPDATE, { source: "test", ...payload });
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BUS_KEY];
  delete (globalThis as Record<symbol, unknown>)[QUEUE_KEY];
});

// ── CostAccumulator ─────────────────────────────────────────────────────────

describe("CostAccumulator", () => {
  let accumulator: CostAccumulator;

  beforeEach(() => {
    accumulator = new CostAccumulator();
    accumulator.subscribe();
  });

  it("accumulates input tokens from cost events", () => {
    emitCost({ inputTokens: 100, outputTokens: 50 });
    expect(accumulator.inputTokens).toBe(100);
    expect(accumulator.outputTokens).toBe(50);
  });

  it("accumulates cache read/write tokens", () => {
    emitCost({ cacheReadTokens: 200, cacheWriteTokens: 100 });
    expect(accumulator.cacheReadTokens).toBe(200);
    expect(accumulator.cacheWriteTokens).toBe(100);
  });

  it("accumulates cost", () => {
    emitCost({ cost: 0.015 });
    expect(accumulator.cost).toBe(0.015);
  });

  it("multiple cost updates accumulate correctly", () => {
    emitCost({ inputTokens: 100, cost: 0.01 });
    emitCost({ inputTokens: 200, cost: 0.02 });
    emitCost({ inputTokens: 300, cost: 0.03 });
    expect(accumulator.inputTokens).toBe(600);
    expect(accumulator.cost).toBe(0.06);
  });

  it("missing fields in payload default to 0", () => {
    emitCost({});
    expect(accumulator.inputTokens).toBe(0);
    expect(accumulator.outputTokens).toBe(0);
    expect(accumulator.cacheReadTokens).toBe(0);
    expect(accumulator.cacheWriteTokens).toBe(0);
    expect(accumulator.cost).toBe(0);
  });

  it("reset zeroes all counters", () => {
    emitCost({ inputTokens: 100, cost: 0.01 });
    accumulator.reset();
    expect(accumulator.inputTokens).toBe(0);
    expect(accumulator.outputTokens).toBe(0);
    expect(accumulator.cacheReadTokens).toBe(0);
    expect(accumulator.cacheWriteTokens).toBe(0);
    expect(accumulator.cost).toBe(0);
  });

  it("dispose unsubscribes — subsequent events not accumulated", () => {
    emitCost({ inputTokens: 100 });
    accumulator.dispose();
    emitCost({ inputTokens: 500 });
    expect(accumulator.inputTokens).toBe(100);
  });

  it("subsequent events not accumulated after dispose", () => {
    emitCost({ cost: 0.01 });
    accumulator.dispose();
    emitCost({ cost: 0.05 });
    expect(accumulator.cost).toBe(0.01);
  });
});
