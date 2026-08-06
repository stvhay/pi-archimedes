import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentLimits, SubagentTermination, SubagentTerminationReason } from "./types.js";

const LIMIT_KEYS = [
  "maxProviderRequests",
  "maxToolCalls",
  "maxTotalTokens",
  "maxCostUsd",
  "maxDurationMs",
] as const satisfies readonly (keyof SubagentLimits)[];

const INTEGER_KEYS = new Set<keyof SubagentLimits>([
  "maxProviderRequests",
  "maxToolCalls",
  "maxTotalTokens",
  "maxDurationMs",
]);

export const SUBAGENT_LIMITS_ENV = "PI_ARCHIMEDES_SUBAGENT_LIMITS";
const STOP_PREFIX = "PI_ARCHIMEDES_LIMIT_STOP ";
const STOP_REASONS = new Set<SubagentTerminationReason>([
  "completed",
  "user-abort",
  "request-limit",
  "tool-limit",
  "token-limit",
  "cost-limit",
  "time-limit",
  "usage-unknown",
  "process-error",
]);

export function normalizeLimits(
  value: Partial<Record<keyof SubagentLimits, unknown>> | undefined,
  zeroMeansUnlimited: boolean,
): SubagentLimits | undefined {
  if (!value) return undefined;

  const normalized: SubagentLimits = {};
  for (const key of LIMIT_KEYS) {
    const raw = value[key];
    if (raw === undefined || (zeroMeansUnlimited && raw === 0)) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new Error(`${key} must be a finite positive number${zeroMeansUnlimited ? " or 0 for unlimited" : ""}`);
    }
    if (INTEGER_KEYS.has(key) && !Number.isInteger(raw)) {
      throw new Error(`${key} must be an integer`);
    }
    normalized[key] = raw;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function resolveLimits(...sources: Array<SubagentLimits | undefined>): SubagentLimits | undefined {
  const resolved: SubagentLimits = {};
  for (const key of LIMIT_KEYS) {
    const values = sources
      .map((source) => source?.[key])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) resolved[key] = Math.min(...values);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

interface AssistantUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | unknown;
}

export class BudgetTracker {
  private providerRequests = 0;
  private toolCalls = 0;
  private totalTokens = 0;
  private totalCost = 0;
  private readonly onStop: (termination: SubagentTermination) => void;

  termination: SubagentTermination | undefined;

  constructor(
    readonly limits: SubagentLimits,
    onStop: (termination: SubagentTermination) => void,
  ) {
    this.onStop = onStop;
  }

  admitProviderRequest(): boolean {
    if (this.termination) return false;
    if (this.limits.maxTotalTokens !== undefined && this.totalTokens >= this.limits.maxTotalTokens) {
      return this.stop("token-limit", this.limits.maxTotalTokens, this.totalTokens);
    }
    if (this.limits.maxCostUsd !== undefined && this.totalCost >= this.limits.maxCostUsd) {
      return this.stop("cost-limit", this.limits.maxCostUsd, this.totalCost);
    }
    if (
      this.limits.maxProviderRequests !== undefined &&
      this.providerRequests >= this.limits.maxProviderRequests
    ) {
      return this.stop("request-limit", this.limits.maxProviderRequests, this.providerRequests);
    }
    this.providerRequests++;
    return true;
  }

  admitToolCall(): boolean {
    if (this.termination) return false;
    if (this.limits.maxToolCalls !== undefined && this.toolCalls >= this.limits.maxToolCalls) {
      return this.stop("tool-limit", this.limits.maxToolCalls, this.toolCalls);
    }
    this.toolCalls++;
    return true;
  }

  observeAssistantUsage(value: AssistantUsage | undefined): void {
    if (this.termination || (this.limits.maxTotalTokens === undefined && this.limits.maxCostUsd === undefined)) {
      return;
    }

    const tokenFields = [value?.input, value?.output, value?.cacheRead, value?.cacheWrite];
    const tokenUsageKnown = tokenFields.every(isNonNegativeFiniteNumber);
    const costTotal = value?.cost && typeof value.cost === "object"
      ? (value.cost as { total?: unknown }).total
      : undefined;
    const costKnown = isNonNegativeFiniteNumber(costTotal);

    if (
      (this.limits.maxTotalTokens !== undefined && !tokenUsageKnown) ||
      (this.limits.maxCostUsd !== undefined && !costKnown)
    ) {
      this.stop("usage-unknown", undefined, undefined, "unknown");
      return;
    }

    if (tokenUsageKnown) {
      this.totalTokens += tokenFields.reduce<number>((sum, item) => sum + (item as number), 0);
    }
    if (costKnown) this.totalCost += costTotal;

    if (this.limits.maxTotalTokens !== undefined && this.totalTokens > this.limits.maxTotalTokens) {
      this.stop("token-limit", this.limits.maxTotalTokens, this.totalTokens);
      return;
    }
    if (this.limits.maxCostUsd !== undefined && this.totalCost > this.limits.maxCostUsd) {
      this.stop("cost-limit", this.limits.maxCostUsd, this.totalCost);
    }
  }

  private stop(
    reason: SubagentTerminationReason,
    limit: number | undefined,
    observed: number | undefined,
    usageState: SubagentTermination["usageState"] = "complete",
  ): false {
    if (!this.termination) {
      this.termination = {
        reason,
        ...(limit !== undefined ? { limit } : {}),
        ...(observed !== undefined ? { observed } : {}),
        usageState,
      };
      this.onStop(this.termination);
    }
    return false;
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function encodeLimitsEnvironment(limits: SubagentLimits): string {
  const normalized = normalizeLimits(limits, false);
  if (!normalized) throw new Error("limits environment must contain at least one limit");
  return JSON.stringify(normalized);
}

export function decodeLimitsEnvironment(value: string): SubagentLimits {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const normalized = normalizeLimits(parsed as Partial<Record<keyof SubagentLimits, unknown>>, false);
    if (!normalized) throw new Error();
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be")) {
      throw new Error(`invalid limits environment: ${error.message}`);
    }
    throw new Error("invalid limits environment");
  }
}

export function registerChildLimitGuard(
  pi: ExtensionAPI,
  limits: SubagentLimits,
  writeStop: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): BudgetTracker {
  let activeContext: ExtensionContext | undefined;
  const tracker = new BudgetTracker(limits, (termination) => {
    writeStop(encodeLimitStop(termination));
    activeContext?.abort();
  });

  pi.on("before_provider_request", (_event, ctx) => {
    activeContext = ctx;
    tracker.admitProviderRequest();
  });
  pi.on("tool_call", (_event, ctx) => {
    activeContext = ctx;
    if (!tracker.admitToolCall()) {
      return { block: true, reason: "Subagent tool-call limit reached" };
    }
    return undefined;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    activeContext = ctx;
    tracker.observeAssistantUsage(event.message.usage);
  });
  pi.on("session_before_compact", () => ({ cancel: true }));

  return tracker;
}

export function encodeLimitStop(termination: SubagentTermination): string {
  return STOP_PREFIX + JSON.stringify(termination);
}

export function decodeLimitStop(line: string): SubagentTermination | undefined {
  if (!line.startsWith(STOP_PREFIX)) return undefined;
  try {
    const value = JSON.parse(line.slice(STOP_PREFIX.length)) as Partial<SubagentTermination>;
    if (
      !value.reason ||
      !STOP_REASONS.has(value.reason) ||
      !value.usageState ||
      !["complete", "partial", "unknown"].includes(value.usageState) ||
      (value.limit !== undefined && !isNonNegativeFiniteNumber(value.limit)) ||
      (value.observed !== undefined && !isNonNegativeFiniteNumber(value.observed))
    ) {
      return undefined;
    }
    return value as SubagentTermination;
  } catch {
    return undefined;
  }
}
