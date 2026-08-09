import { resolveLimits } from "./limits.js";
import type {
  ResolvedChildExecution,
  SubagentExecutionMode,
  SubagentExecutionProfile,
  SubagentLimits,
  SubagentThinkingLevel,
} from "./types.js";

export const ONE_SHOT_LIMITS = {
  maxProviderRequests: 1,
} as const satisfies SubagentLimits;

export const ONE_SHOT_SYSTEM_PROMPT =
  "You are a read-only peer. Treat the task as a complete context packet. You have no tools or ambient project context. Return one final response.";

export interface ExecutionOverrides {
  limits?: SubagentLimits | undefined;
  mode?: SubagentExecutionMode | undefined;
  thinking?: SubagentThinkingLevel | undefined;
}

export interface ExecutionProfileOptions {
  topLevel?: ExecutionOverrides | undefined;
  task?: ExecutionOverrides | undefined;
  agentThinking?: string | undefined;
}

export function resolveExecutionProfile(options: ExecutionProfileOptions): SubagentExecutionProfile {
  return {
    mode: options.task?.mode ?? options.topLevel?.mode ?? "agentic",
    thinking: options.agentThinking ?? options.task?.thinking ?? options.topLevel?.thinking,
  };
}

export function resolveChildExecution(options: ExecutionProfileOptions & {
  operatorLimits?: SubagentLimits | undefined;
}): ResolvedChildExecution {
  const profile = resolveExecutionProfile(options);
  const sources = [options.operatorLimits, options.topLevel?.limits, options.task?.limits];
  const requested = resolveLimits(...sources);

  if (profile.mode === "one-shot") {
    const incompatible = ["maxTotalTokens", "maxCostUsd"] as const;
    for (const key of incompatible) {
      if (requested?.[key] !== undefined) {
        throw new Error(`${key} cannot enforce spend on a one-shot provider request; use maxOutputTokens`);
      }
    }
    return { profile, limits: resolveLimits(requested, ONE_SHOT_LIMITS) };
  }

  if (requested?.maxOutputTokens !== undefined) {
    throw new Error("maxOutputTokens is supported only for one-shot children");
  }
  return { profile, limits: requested };
}
