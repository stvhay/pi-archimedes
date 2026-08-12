import type { SubagentConfig } from "./config.js";
import { normalizeLimits } from "./limits.js";
import type { SubagentLimits } from "./types.js";

export interface ChildDispatchPolicy {
  limits: SubagentLimits | undefined;
  providerMaxRetries: number;
}

export function resolveConfiguredLimits(config: SubagentConfig): SubagentLimits | undefined {
  return normalizeLimits(config.defaultLimits, true);
}

export function validateDispatchPolicy(
  config: SubagentConfig,
  children: readonly ChildDispatchPolicy[],
): void {
  if (config.maxParallel > 0 && children.length > config.maxParallel) {
    throw new Error(`Parallel task count ${children.length} exceeds archimedes.subagent.maxParallel (${config.maxParallel})`);
  }
  if (children.some((child) => child.limits && child.providerMaxRetries > 0)) {
    throw new Error("Bounded subagents require retry.provider.maxRetries to be 0");
  }
}
