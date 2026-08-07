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
  const limits = resolveLimits(
    options.operatorLimits,
    options.topLevel?.limits,
    options.task?.limits,
    profile.mode === "one-shot" ? ONE_SHOT_LIMITS : undefined,
  );
  return { profile, limits };
}
