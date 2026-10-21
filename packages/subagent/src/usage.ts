import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentResult, SubagentUsage } from "./types.js";

// ── Native cost reporting (ADR 0028) ────────────────────────────────────────
//
// A tool result may carry `usage`, and pi does the accounting from there: the
// field is copied onto the toolResult message it persists
// (`pi-agent-core/dist/agent-loop.js`, `createToolResultMessage` — `usage:
// finalized.result.usage`) and `AgentSession.getSessionStats()` folds every
// toolResult message's usage into the session totals
// (`pi-coding-agent/dist/core/agent-session.js`, the `message.role ===
// "toolResult"` branch). So a subagent that returns `usage` is counted by
// `/session`, by the footer's own session scan, and by anything else that reads
// session stats — with no side channel involved.
//
// That is why the old bus route (`subagent/src/cost.ts` → `COST_UPDATE` →
// `footer/CostAccumulator`) had to go rather than just stop being used: the
// footer already counts toolResult usage, so leaving the accumulator in place
// would add the same money twice.

/**
 * The child's summed usage in pi's own `Usage` shape.
 *
 * The stream preserves native per-kind cost when available. Older producers
 * supply only a total; missing splits stay zero instead of being guessed.
 * `totalTokens` follows pi's own definition — input + output + both cache kinds.
 */
export function toNativeUsage(usage: SubagentUsage): Usage {
  return fromSubagentUsage(usage);
}

/**
 * Sum the usage of several runs into the one `usage` a single tool result can
 * carry — a parallel batch is one tool call, so it has one toolResult message.
 *
 * Runs performed by another runtime (`usageAccountedElsewhere`, i.e. everything
 * the bridge dispatched) are left out: their session reports its own usage, and
 * this sum lands in *this* session's totals. A batch of nothing but such runs
 * reports nothing at all.
 */
export function sumNativeUsage(results: SubagentResult[]): Usage | undefined {
  const counted = results.filter(
    (r) => r.usage !== undefined && r.usageAccountedElsewhere !== true,
  );
  if (counted.length === 0) return undefined;
  const zero: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return counted.reduce<Usage>((total, result) => {
      const next = toNativeUsage(result.usage);
      return {
        input: total.input + next.input,
        output: total.output + next.output,
        cacheRead: total.cacheRead + next.cacheRead,
        cacheWrite: total.cacheWrite + next.cacheWrite,
        totalTokens: total.totalTokens + next.totalTokens,
        cost: {
          input: total.cost.input + next.cost.input,
          output: total.cost.output + next.cost.output,
          cacheRead: total.cost.cacheRead + next.cost.cacheRead,
          cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
          total: total.cost.total + next.cost.total,
        },
      };
    },
    zero,
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function number(value: unknown): number {
  return isNonNegativeFiniteNumber(value) ? value : 0;
}

export function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const cost = source.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return false;
  const costRecord = cost as Record<string, unknown>;
  return [
    source.input,
    source.output,
    source.cacheRead,
    source.cacheWrite,
    source.totalTokens,
    costRecord.input,
    costRecord.output,
    costRecord.cacheRead,
    costRecord.cacheWrite,
    costRecord.total,
  ].every(isNonNegativeFiniteNumber);
}

export function readUsage(value: unknown): Usage {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const cost = source.cost && typeof source.cost === "object"
    ? source.cost as Record<string, unknown>
    : {};
  const input = number(source.input);
  const output = number(source.output);
  const cacheRead = number(source.cacheRead);
  const cacheWrite = number(source.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: number(cost.input),
      output: number(cost.output),
      cacheRead: number(cost.cacheRead),
      cacheWrite: number(cost.cacheWrite),
      total: number(cost.total),
    },
  };
}

export function addUsage(...sources: Usage[]): Usage {
  const usage = readUsage(undefined);
  for (const source of sources) {
    usage.input += source.input;
    usage.output += source.output;
    usage.cacheRead += source.cacheRead;
    usage.cacheWrite += source.cacheWrite;
    usage.cost.input += source.cost.input;
    usage.cost.output += source.cost.output;
    usage.cost.cacheRead += source.cost.cacheRead;
    usage.cost.cacheWrite += source.cost.cacheWrite;
    usage.cost.total += source.cost.total;
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

export function fromSubagentUsage(usage: SubagentUsage): Usage {
  return readUsage({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: { ...usage.costBreakdown, total: usage.cost },
  });
}

export function toSubagentUsage(usage: Usage, turns: number): SubagentUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    costBreakdown: { ...usage.cost },
    turns,
  };
}
