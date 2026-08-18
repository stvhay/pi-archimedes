import { SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, TUI } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { loadSubagentConfig } from "./config.js";
import { resolveConfiguredLimits, validateDispatchPolicy } from "./dispatch-policy.js";
import { executeSubagent, executeParallel, aggregateUsage } from "./execute.js";
import { resolveChildExecution } from "./execution-profile.js";
import { renderSubagentResult } from "./render.js";
import { discoverAgents, discoverAgentsAll, findAgent, formatAgentList } from "./agents.js";
import { validateModel, firstError } from "./model-validation.js";
import {
  MAX_SUBAGENT_DURATION_MS,
  SUBAGENT_EXECUTION_MODES,
  SUBAGENT_OUTPUT_CONTRACTS,
  SUBAGENT_THINKING_LEVELS,
} from "./types.js";
import type {
  SubagentDetails,
  SubagentOutputContract,
  SubagentProgress,
  SubagentResult,
  SubagentToolResult,
} from "./types.js";

const PARALLEL_OUTPUT_MAX_CHARS = 12_000;

// ── JSON Schema for tool parameters (TypeBox) ──────────────────────────────

const SubagentLimitsSchema = Type.Object({
  maxProviderRequests: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum provider requests for this child" })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum tool calls for this child" })),
  maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum input, output, and cache tokens for this child" })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Best-effort provider-native output cap for one-shot children" })),
  maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Observed cost ceiling in USD; may overshoot by one response" })),
  maxDurationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_DURATION_MS, description: "Maximum wall time in milliseconds for this child" })),
  maxIdleMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_DURATION_MS, description: "Maximum milliseconds between valid child activity events" })),
});

const ExecutionModeSchema = StringEnum(SUBAGENT_EXECUTION_MODES, {
  description: "agentic: normal child with tools and ambient context; one-shot: isolated packet with one provider request",
});
const ThinkingLevelSchema = StringEnum(SUBAGENT_THINKING_LEVELS, {
  description: "Child thinking level. Agent frontmatter wins, then task-level, then top-level thinking.",
});
const OutputContractSchema = StringEnum(SUBAGENT_OUTPUT_CONTRACTS, {
  description: "Caller-supplied result transport label; Archimedes reports but does not evaluate it.",
});

const TaskItem = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent name for this task (optional). If omitted, runs config-less.",
  })),
  task: Type.String(),
  model: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  limits: Type.Optional(SubagentLimitsSchema),
  mode: Type.Optional(ExecutionModeSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
  outputContract: Type.Optional(OutputContractSchema),
});

const SUBAGENT_PARAMS_SCHEMA = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent name (optional). If omitted, the subagent runs config-less — parent's current model, all tools, no system-prompt override. Call list_agents to see available agents.",
  })),
  task: Type.Optional(Type.String({
    description: "Task description for the subagent. Required when not using 'tasks' array.",
  })),
  tasks: Type.Optional(Type.Array(TaskItem, {
    description: "Multiple tasks for parallel execution. Required when not using 'task'.",
  })),
  model: Type.Optional(Type.String({
    description: "Model override for the subagent",
  })),
  async: Type.Optional(Type.Boolean({
    description: "Run asynchronously (fire-and-forget)",
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the subagent",
  })),
  limits: Type.Optional(SubagentLimitsSchema),
  mode: Type.Optional(ExecutionModeSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
  outputContract: Type.Optional(OutputContractSchema),
});

type SubagentParams = Static<typeof SUBAGENT_PARAMS_SCHEMA>;

// ── Theme helper type for render functions ──────────────────────────────────

interface RenderTheme {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerSubagent(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_SOCKET) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to subagents. Provide either 'task' (single) or 'tasks' (parallel). Agent is optional — omit for a config-less run with the parent's model and all tools. Use mode 'one-shot' for one isolated response from a complete packet. Model override is rarely needed; the agent config or parent model is used by default.",
    parameters: SUBAGENT_PARAMS_SCHEMA,

    async execute(
      _id: string,
      params: SubagentParams,
      signal: AbortSignal | undefined,
      onUpdate: ((update: SubagentToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<SubagentToolResult> {
      const agents = discoverAgents(ctx.cwd);
      let config;
      let configuredLimits;
      try {
        config = loadSubagentConfig();
        configuredLimits = resolveConfiguredLimits(config);
      } catch (error) {
        return policyError(params.tasks?.length ? "parallel" : "single", error);
      }

      // Parallel mode
      if (params.tasks && params.tasks.length > 0) {
        let taskPlans;
        try {
          taskPlans = params.tasks.map((task) => {
            const agentConfig = task.agent ? findAgent(agents, task.agent) : undefined;
            return {
              task,
              agentConfig,
              execution: resolveChildExecution({
                operatorLimits: configuredLimits,
                topLevel: params,
                task,
                agentThinking: agentConfig?.thinking,
              }),
            };
          });
          validateDispatchPolicy(config, taskPlans.map(({ task, execution }) => ({
            limits: execution.limits,
            providerMaxRetries: SettingsManager.create(task.cwd ?? process.cwd())
              .getProviderRetrySettings().maxRetries ?? 0,
          })));
        } catch (error) {
          return policyError("parallel", error);
        }

        // Combined pre-spawn checks for parallel mode: unknown agents + invalid
        // models. If ANY task is invalid, abort the whole batch with a single
        // tool result listing all errors (no tasks spawn).
        const errors: string[] = [];
        const unknownAgents = taskPlans
          .filter(({ task, agentConfig }) => task.agent && !agentConfig)
          .map(({ task }) => `"${task.agent}"`);
        if (unknownAgents.length > 0) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          errors.push(`Unknown agent(s): ${unknownAgents.join(", ")}. Available: ${available}. Call list_agents for details.`);
        }
        for (const { task, agentConfig } of taskPlans) {
          // Skip model validation for tasks already caught by unknown-agent check
          if (task.agent && !agentConfig) continue;
          const me = firstError(
            validateModel(task.model, ctx.modelRegistry, { agentName: task.agent }),
            validateModel(agentConfig?.model, ctx.modelRegistry, {
              agentName: task.agent,
              agentFilePath: agentConfig?.filePath,
            }),
          );
          if (me) errors.push(me);
        }
        if (errors.length > 0) {
          return {
            content: [{ type: "text", text: errors.join("\n") }],
            details: {
              mode: "parallel",
              results: [],
              progress: undefined,
            },
            isError: true,
          };
        }
        const results: SubagentResult[] = await executeParallel({
          tasks: taskPlans.map(({ task, agentConfig, execution }) => ({
            agent: task.agent ?? undefined,
            agentConfig,
            task: task.task,
            model: task.model,
            activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            cwd: task.cwd ?? undefined,
            execution,
            outputContract: (task.outputContract ?? params.outputContract) as SubagentOutputContract | undefined,
          })),
          signal: signal ?? undefined,
          onUpdate: (progress: SubagentProgress[]) => {
            onUpdate?.({
              content: [],
              details: {
                mode: "parallel",
                results: [],
                progress,
              },
            });
          },
        });

        return {
          content: [
            { type: "text", text: formatResultsSummary(results) },
            ...formatParallelOutputs(results),
          ],
          details: {
            mode: "parallel",
            results,
            // progress is always defined for each result (executeSubagent synthesizes
            // a failed-progress object in its catch block) so we keep alignment with
            // results by index. Do NOT filter(Boolean) here — that would misalign
            // details.progress[i] with details.results[i] in the renderer.
            progress: results.map(r => r.progress) as SubagentProgress[],
          },
          usage: aggregateUsage(results),
        };
      }

      // Single mode
      if (params.task) {
        let agentConfig = params.agent ? findAgent(agents, params.agent) : undefined;
        if (params.agent && !agentConfig) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          return {
            content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}. Call list_agents for details.` }],
            details: {
              mode: "single",
              results: [],
              progress: undefined,
            },
            isError: true,
          };
        }
        // Pre-spawn model validation (P2): fail fast with a friendly error
        // instead of spawning a child that will crash on a bogus --model.
        const modelError = firstError(
          validateModel(params.model, ctx.modelRegistry, { agentName: params.agent }),
          validateModel(agentConfig?.model, ctx.modelRegistry, {
            agentName: params.agent,
            agentFilePath: agentConfig?.filePath,
          }),
        );
        if (modelError) {
          return {
            content: [{ type: "text", text: modelError }],
            details: { mode: "single", results: [], progress: undefined },
            isError: true,
          };
        }
        let execution;
        try {
          execution = resolveChildExecution({
            operatorLimits: configuredLimits,
            topLevel: params,
            agentThinking: agentConfig?.thinking,
          });
          const retries = SettingsManager.create(params.cwd ?? process.cwd())
            .getProviderRetrySettings().maxRetries ?? 0;
          validateDispatchPolicy(config, [{ limits: execution.limits, providerMaxRetries: retries }]);
        } catch (error) {
          return policyError("single", error);
        }
        const result: SubagentResult = await executeSubagent({
          agent: params.agent ?? undefined,
          agentConfig,
          task: params.task,
          model: params.model,
          activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          cwd: params.cwd ?? undefined,
          signal: signal ?? undefined,
          execution,
          outputContract: params.outputContract as SubagentOutputContract | undefined,
          onUpdate: (progress: SubagentProgress) => {
            onUpdate?.({
              content: [],
              details: {
                mode: "single",
                results: [],
                progress: [progress],
              },
            });
          },
        });

        return {
          content: [{ type: "text", text: resultOutput(result) }],
          details: {
            mode: "single",
            results: [result],
            progress: result.progress ? [result.progress] : undefined,
          },
          isError: result.exitCode !== 0,
          usage: aggregateUsage([result]),
        };
      }

      return {
        content: [{ type: "text", text: "Missing task parameter" }],
        details: {
          mode: "single",
          results: [],
          progress: undefined,
        },
        isError: true,
      };
    },

    renderCall(args: unknown, theme: Theme, ctx: unknown): import("@earendil-works/pi-tui").Component {
      const params = args as Record<string, unknown> | undefined;
      const tasks = params?.tasks as Array<unknown> | undefined;
      const agent = params?.agent as string | undefined;

      const lastComponent = (ctx as { lastComponent?: import("@earendil-works/pi-tui").Component })?.lastComponent;
      const text = (lastComponent instanceof Text ? lastComponent : new Text("", 0, 0)) as Text;
      (ctx as Record<string, unknown>).lastComponent = text;

      if (tasks && tasks.length > 0) {
        const label = theme.fg("toolTitle", theme.bold("subagent")) + " " + tasks.length + " tasks";
        text.setText(label);
      } else if (agent) {
        const label = theme.fg("toolTitle", theme.bold("subagent")) + " " + theme.fg("accent", agent);
        text.setText(label);
      } else {
        text.setText(theme.fg("toolTitle", theme.bold("subagent")));
      }

      return text;
    },

    renderResult(result: unknown, options: unknown, theme: Theme, context: unknown): import("@earendil-works/pi-tui").Component {
      const toolResult = result as unknown as SubagentToolResult;
      const debugText = new Text("", 0, 0);
      const expanded = ((context as Record<string, unknown>)?.expanded ??
        (options as Record<string, unknown>)?.expanded ??
        false) as boolean;

      const renderTheme = theme as unknown as RenderTheme;
      const text = new Text("", 0, 0);
      const renderContext = {
        expanded,
        isError: toolResult.isError ?? false,
        lastComponent: (context as { lastComponent?: Text })?.lastComponent,
        state: (context as Record<string, unknown>)?.state ?? {},
        invalidate: () => {},
      };
      (context as Record<string, unknown>).lastComponent = text;

      try {
        const rendered = renderSubagentResult(text, toolResult, { expanded }, renderTheme, renderContext as any);
        return rendered;
      } catch (e) {
        debugText.setText("render error: " + (e instanceof Error ? e.message : String(e)));
        return debugText;
      }
    },
  });

  registerListAgentsTool(pi);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function policyError(mode: "single" | "parallel", error: unknown): SubagentToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    details: { mode, results: [], progress: undefined },
    isError: true,
  };
}

export function registerListAgentsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_agents",
    label: "Agents",
    description:
      "List available subagent configurations (name, description, source, model/tools overrides). Call before dispatching if unsure which agents exist or which fits the task.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);
      return {
        content: [{ type: "text" as const, text: formatAgentList(agents) }],
        details: { count: agents.length },
      };
    },
  });
}

function formatProgressSummary(progress: SubagentProgress[]): string {
  if (progress.length === 0) return "";
  const lines = progress.map((p) => {
    const tool = p.currentTool ? ` [${p.currentTool}]` : "";
    const stats = [
      p.toolCount > 0 ? p.toolCount + " tools" : "",
      p.tokens > 0 ? Math.round(p.tokens / 1000) + "k tok" : "",
    ].filter(Boolean).join(" · ");
    return p.agent + tool + (stats ? " " + stats : "");
  });
  return lines.join("\n");
}

function resultOutput(result: SubagentResult): string {
  return result.finalOutput ?? result.error ?? "completed";
}

function formatResultsSummary(results: SubagentResult[]): string {
  const lines = results.map((r) => {
    const status = r.exitCode === 0 ? "✓" : "✗";
    const summary = r.progressSummary
      ? `${r.progressSummary.toolCount} tools · ${Math.round(r.progressSummary.tokens / 1000)}k tok · ${Math.round(r.progressSummary.durationMs / 1000)}s`
      : "";
    return `${status} ${r.agent}${summary ? " " + summary : ""}`;
  });
  return lines.join("\n");
}

function formatParallelOutputs(results: SubagentResult[]): Array<{ type: "text"; text: string }> {
  const messageMaxChars = Math.floor(PARALLEL_OUTPUT_MAX_CHARS / Math.max(1, results.length));
  const suffix = "\n[delegated output truncated]";
  if (results.length > 0 && messageMaxChars <= `Child ${results.length} output:\n`.length) {
    const header = "Child 1 output:\n";
    const omitted = results.length - 1;
    let notice = `\n[${omitted} later child outputs omitted; complete results remain in details.results]`;
    const output = resultOutput(results[0]!);
    let outputChars = PARALLEL_OUTPUT_MAX_CHARS - header.length - notice.length;
    if (output.length > outputChars) {
      notice = `\n[delegated output truncated; ${omitted} later child outputs omitted; complete results remain in details.results]`;
      outputChars = PARALLEL_OUTPUT_MAX_CHARS - header.length - notice.length;
    }
    return [{ type: "text", text: `${header}${output.slice(0, Math.max(0, outputChars))}${notice}` }];
  }
  return results.flatMap((result, index) => {
    const header = `Child ${index + 1} output:\n`;
    const available = messageMaxChars - header.length;
    if (available <= 0) return [];
    const output = resultOutput(result);
    if (output.length <= available) return [{ type: "text" as const, text: `${header}${output}` }];
    const outputChars = Math.max(0, available - suffix.length);
    return [{
      type: "text" as const,
      text: `${header}${output.slice(0, outputChars)}${outputChars ? suffix : ""}`,
    }];
  });
}

// ── Command registration ────────────────────────────────────────────────────

export function registerAgentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("agents", {
    description: "Open the Agents Manager",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Lazy-load: 1689-line TUI component only needed when /agents is invoked
      const { createAgentManager } = await import("./agent-manager.js");
      const { global: globalAgents, user, project, globalDir, userDir, projectDir } = discoverAgentsAll(ctx.cwd);

      const availableModels = ctx.modelRegistry.getAvailable().map((m) => ({
        id: m.id,
        provider: m.provider,
        fullId: `${m.provider}/${m.id}`,
      }));

      const availableTools = pi.getAllTools().map((t) => ({
        name: t.name,
        description: t.description ?? "",
      }));

      await ctx.ui.custom<void>(
        (tui: TUI, theme: Theme, _keybindings, done: () => void) => {
          return createAgentManager(globalAgents, user, project, globalDir, userDir, projectDir, tui, theme, done, availableModels, availableTools);
        },
        { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
      );
    },
  });
}

// ── Default export ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  registerSubagent(pi);
}
