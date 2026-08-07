import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentUsage } from "./types.js";

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
