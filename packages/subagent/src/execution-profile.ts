import { resolveLimits } from "./limits.js";
import type {
  SubagentExecutionMode,
  SubagentExecutionProfile,
  SubagentLimits,
  SubagentThinkingLevel,
} from "./types.js";

export const ONE_SHOT_LIMITS = {
  maxProviderRequests: 1,
  maxDurationMs: 180_000,
} as const satisfies SubagentLimits;

export const ONE_SHOT_SYSTEM_PROMPT =
  "You are a read-only peer. Treat the task as a complete context packet. You have no tools or ambient project context. Return one final response.";

export interface ExecutionProfileOptions {
  topLevelMode?: SubagentExecutionMode | undefined;
  taskMode?: SubagentExecutionMode | undefined;
  topLevelThinking?: SubagentThinkingLevel | undefined;
  taskThinking?: SubagentThinkingLevel | undefined;
  agentThinking?: string | undefined;
}

export function resolveExecutionProfile(options: ExecutionProfileOptions): SubagentExecutionProfile {
  return {
    mode: options.taskMode ?? options.topLevelMode ?? "agentic",
    thinking: options.agentThinking ?? options.taskThinking ?? options.topLevelThinking,
  };
}

export function resolveProfileLimits(
  profile: SubagentExecutionProfile | undefined,
  limits: SubagentLimits | undefined,
): SubagentLimits | undefined {
  return profile?.mode === "one-shot" ? resolveLimits(limits, ONE_SHOT_LIMITS) : limits;
}

export function resolveChildExecution(options: ExecutionProfileOptions & {
  operatorLimits?: SubagentLimits | undefined;
  topLevelLimits?: SubagentLimits | undefined;
  taskLimits?: SubagentLimits | undefined;
}): { profile: SubagentExecutionProfile; limits: SubagentLimits | undefined } {
  const profile = resolveExecutionProfile(options);
  const limits = resolveLimits(options.operatorLimits, options.topLevelLimits, options.taskLimits);
  return { profile, limits: resolveProfileLimits(profile, limits) };
}
