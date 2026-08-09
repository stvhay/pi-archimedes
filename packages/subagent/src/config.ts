import type { SettingItem } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig } from "@pi-archimedes/core/settings-io";
import { normalizeLimits } from "./limits.js";
import type { SubagentLimits } from "./types.js";

type OperatorSubagentLimits = Omit<SubagentLimits, "maxOutputTokens">;

export interface SubagentConfig {
  maxParallel: number;
  defaultLimits: Required<OperatorSubagentLimits>;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  maxParallel: 0,
  defaultLimits: {
    maxProviderRequests: 0,
    maxToolCalls: 0,
    maxTotalTokens: 0,
    maxCostUsd: 0,
    maxDurationMs: 0,
  },
};

const NAMESPACE = "archimedes.subagent";

export function loadSubagentConfig(): SubagentConfig {
  const raw = loadConfig<Partial<SubagentConfig>>(NAMESPACE, DEFAULT_SUBAGENT_CONFIG);
  if (
    raw.defaultLimits !== undefined &&
    (!raw.defaultLimits || typeof raw.defaultLimits !== "object" || Array.isArray(raw.defaultLimits))
  ) {
    throw new Error("archimedes.subagent.defaultLimits must be an object");
  }

  const config: SubagentConfig = {
    maxParallel: raw.maxParallel ?? 0,
    defaultLimits: {
      ...DEFAULT_SUBAGENT_CONFIG.defaultLimits,
      ...(raw.defaultLimits ?? {}),
    },
  };
  validateConfig(config);
  return config;
}

export function loadSubagentConfigOrDefault(): SubagentConfig {
  try {
    return loadSubagentConfig();
  } catch {
    return structuredClone(DEFAULT_SUBAGENT_CONFIG);
  }
}

export function saveSubagentConfig(config: SubagentConfig): void {
  validateConfig(config);
  saveConfig(NAMESPACE, config);
}

export function getSubagentSettingsItems(config = loadSubagentConfig()): SettingItem[] {
  return [
    setting("subagentMaxParallel", "Subagent Max Parallel", "Maximum children per parallel call; 0 is unlimited", config.maxParallel),
    setting("subagentMaxProviderRequests", "Subagent Max Provider Requests", "Per-child provider requests; 0 is unlimited", config.defaultLimits.maxProviderRequests),
    setting("subagentMaxToolCalls", "Subagent Max Tool Calls", "Per-child tool calls; 0 is unlimited", config.defaultLimits.maxToolCalls),
    setting("subagentMaxTotalTokens", "Subagent Max Total Tokens", "Per-child input, output, and cache tokens; 0 is unlimited", config.defaultLimits.maxTotalTokens),
    setting("subagentMaxCostUsd", "Subagent Max Cost USD", "Observed per-child cost in USD; 0 is unlimited", config.defaultLimits.maxCostUsd),
    setting("subagentMaxDurationMs", "Subagent Max Duration", "Per-child wall time in milliseconds; 0 is unlimited", config.defaultLimits.maxDurationMs),
  ];
}

function setting(id: string, label: string, description: string, value: number): SettingItem {
  return { id, label, description, currentValue: String(value) };
}

function validateConfig(config: SubagentConfig): void {
  if (!Number.isInteger(config.maxParallel) || config.maxParallel < 0) {
    throw new Error("maxParallel must be a non-negative integer");
  }
  normalizeLimits(config.defaultLimits, true);
}
