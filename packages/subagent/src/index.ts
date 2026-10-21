import { SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SUBAGENT_PARAMS_SCHEMA, SUBAGENT_OUTPUT_SCHEMA, subagentStructuredContent, type SubagentParams } from "./tool-schema.js";
import { executeSubagent, executeParallel } from "./execute.js";
import { loadSubagentConfig } from "./config.js";
import { resolveConfiguredLimits, validateDispatchPolicy } from "./dispatch-policy.js";
import { resolveChildExecution } from "./execution-profile.js";
import { formatSingleResult } from "./format.js";
// agent-manager.js lazy-loaded below to keep subagent tool registration fast
import { renderSubagentResult } from "./render.js";
import { RowBlock } from "./row-block.js";
import { OVERLAY_CHROME } from "@pi-archimedes/core/overlay";
import { renderToolHeader } from "@pi-archimedes/core/tool-render";
import { reportPiSupport } from "@pi-archimedes/core/pi-support";
import { diag, describeError } from "@pi-archimedes/core/log";
import { discoverAgents, discoverAgentsAll, findAgent, formatAgentList } from "./agents.js";
import { validateModel, firstError } from "./model-validation.js";
import {
  unknownToolEntries,
  formatUnknownToolsWarning,
} from "./tool-validation.js";
import { resolveThinkingLevel } from "./thinking-validation.js";
import { toNativeUsage, sumNativeUsage } from "./usage.js";
import type {
  SubagentDetails,
  SubagentProgress,
  SubagentResult,
  SubagentToolResult,
} from "./types.js";

// ── Theme helper type for render functions ──────────────────────────────────

interface RenderTheme {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerSubagent(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_SOCKET) return;
  // Floor check before anything that can fail (ADR 0026). This package spawns
  // pi with flags and reads event fields that only behave correctly on 1.x
  // (`--tools` semantics, `agent_settled.aborted`, print-mode exit codes), and a
  // peer range cannot say so at install time. Warn and register anyway — the
  // tool must still show up in /plugins. Entry point for both meta and the
  // standalone default export, so `registerAgentsCommand` needs no second call.
  reportPiSupport("subagent", "1.2.0");

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to subagents. Provide either 'task' (single) or 'tasks' (parallel). Agent is optional — omit for a config-less run with the parent's model and all tools. Use mode 'one-shot' for one isolated response from a complete packet. Model override is rarely needed; the agent config or parent model is used by default.",
    parameters: SUBAGENT_PARAMS_SCHEMA,
    outputSchema: SUBAGENT_OUTPUT_SCHEMA,
    // Preserve existing script callers; child recursion is blocked separately.
    exposure: "direct",

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
              task, agentConfig,
              execution: resolveChildExecution({
                operatorLimits: configuredLimits, topLevel: params, task,
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
        const unknownAgents = params.tasks
          .filter((t) => t.agent && !findAgent(agents, t.agent!))
          .map((t) => `"${t.agent}"`);
        if (unknownAgents.length > 0) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          errors.push(`Unknown agent(s): ${unknownAgents.join(", ")}. Available: ${available}. Call list_agents for details.`);
        }
        const unknownAgentSet = new Set(unknownAgents.map((n) => n.replace(/"/g, '')));
        for (const t of params.tasks) {
          // Skip model validation for tasks already caught by unknown-agent check
          if (t.agent && unknownAgentSet.has(t.agent)) continue;
          const taskAgentConfig = t.agent ? findAgent(agents, t.agent) : undefined;
          // A `tools:` list the config read rejected is never applied, so the task
          // cannot run as configured — say so before anything spawns.
          if (taskAgentConfig?.toolsError) errors.push(taskAgentConfig.toolsError);
          const me = firstError(
            validateModel(t.model, ctx.modelRegistry, { agentName: t.agent }),
            validateModel(taskAgentConfig?.model, ctx.modelRegistry, {
              agentName: t.agent,
              agentFilePath: taskAgentConfig?.filePath,
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
        // Membership only becomes knowable here, with the handle in scope — and
        // it is a warning, so the batch still runs (see warnUnavailableTools).
        const warnedTools = new Set<string>();
        const warnedThinking = new Set<string>();
        for (const t of params.tasks) {
          warnUnavailableTools(
            pi,
            ctx,
            warnedTools,
            t.agent ?? "subagent",
            t.agent ? findAgent(agents, t.agent)?.tools : undefined,
          );
          warnUnknownThinkingLevel(ctx, warnedThinking, t.agent ? findAgent(agents, t.agent)?.thinking : undefined);
        }
        const results: SubagentResult[] = await executeParallel({
          tasks: taskPlans.map(({ task: t, agentConfig, execution }) => ({
            agent: t.agent ?? undefined,
            agentConfig,
            execution,
            ...((t.outputContract ?? params.outputContract) ? { outputContract: t.outputContract ?? params.outputContract! } : {}),
            task: t.task,
            model: t.model,
            activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            cwd: t.cwd ?? undefined,
            // All N tasks share the single subagent tool-call's id (the frame
            // carries it for Client correlation).
            toolCallId: _id,
          })),
          signal: signal ?? undefined,
          events: pi.events,
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

        const nativeUsage = sumNativeUsage(results);
        return {
          content: [
            { type: "text", text: formatResultsSummary(results) },
            ...formatParallelOutputs(results),
          ],
          ...(nativeUsage ? { usage: nativeUsage } : {}),
          structuredContent: subagentStructuredContent("parallel", results),
          details: {
            mode: "parallel",
            results,
            // progress is always defined for each result (executeSubagent synthesizes
            // a failed-progress object in its catch block) so we keep alignment with
            // results by index. Do NOT filter(Boolean) here — that would misalign
            // details.progress[i] with details.results[i] in the renderer.
            progress: results.map(r => r.progress) as SubagentProgress[],
          },
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
        // A rejected `tools:` list is a config error, not a runtime one: the child
        // would run with a different tool set than the config asked for, so it
        // does not run at all.
        if (agentConfig?.toolsError) {
          return {
            content: [{ type: "text", text: agentConfig.toolsError }],
            details: { mode: "single", results: [], progress: undefined },
            isError: true,
          };
        }
        warnUnavailableTools(pi, ctx, new Set(), params.agent ?? "subagent", agentConfig?.tools);
        warnUnknownThinkingLevel(ctx, new Set(), agentConfig?.thinking);
        let execution;
        try {
          execution = resolveChildExecution({
            operatorLimits: configuredLimits, topLevel: params,
            agentThinking: agentConfig?.thinking,
          });
          const retries = SettingsManager.create(params.cwd ?? process.cwd())
            .getProviderRetrySettings().maxRetries ?? 0;
          validateDispatchPolicy(config, [{ limits: execution.limits, providerMaxRetries: retries }]);
        } catch (error) {
          return policyError("single", error);
        }
        const result: SubagentResult = await executeSubagent({
          execution,
          ...(params.outputContract ? { outputContract: params.outputContract } : {}),
          agent: params.agent ?? undefined,
          agentConfig,
          task: params.task,
          model: params.model,
          activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          cwd: params.cwd ?? undefined,
          signal: signal ?? undefined,
          events: pi.events,
          toolCallId: _id,
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
          content: [{ type: "text", text: formatSingleResult(result) }],
          // The cost report — but only for a run this session performed. A
          // bridge-dispatched run is a session of the desktop's own and books
          // its usage there; pi folds a tool result's `usage` into THIS
          // session's totals, so publishing it here would count the money twice
          // (the same reason the `COST_UPDATE` route was deleted).
          ...(result.usageAccountedElsewhere ? {} : { usage: toNativeUsage(result.usage) }),
          // Successes only. The predicate is the one two lines below, so a run
          // that reports itself as failed carries no structured content and a
          // codemode script keeps rejecting with the text it rejects with today
          // (see `SUBAGENT_OUTPUT_SCHEMA`).
          ...(result.error === undefined ? { structuredContent: subagentStructuredContent("single", [result]) } : {}),
          details: {
            mode: "single",
            results: [result],
            progress: result.progress ? [result.progress] : undefined,
          },
          // Only a *failed* run is a tool error. A truncated answer and a
          // cancelled one both produced something, and `isError` is how the model
          // and the Client decide to retry or give up (ADR 0028). `error` is the
          // predicate because the exit code is not one — a json child exits 0 for
          // an errored run — and `stream.ts` guarantees a failed run always
          // carries an explanation while a completed/truncated/aborted one never
          // does.
          isError: result.error !== undefined,
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
        text.setText(
          renderToolHeader("subagent", `${tasks.length} tasks`, theme),
        );
      } else if (agent) {
        text.setText(renderToolHeader("subagent", agent, theme));
      } else {
        text.setText(renderToolHeader("subagent", undefined, theme));
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
      // A RowBlock, not a plain Text: the subagent rows are cut at the width pi
      // renders them at, and only the component is ever handed that width.
      const lastComponent = (context as { lastComponent?: unknown })?.lastComponent;
      const rows = lastComponent instanceof RowBlock ? lastComponent : new RowBlock();
      const renderContext = {
        expanded,
        isError: toolResult.isError ?? false,
        lastComponent: rows,
        state: (context as Record<string, unknown>)?.state ?? {},
        invalidate: () => {},
      };
      (context as Record<string, unknown>).lastComponent = rows;

      try {
        const rendered = renderSubagentResult(rows, toolResult, { expanded }, renderTheme, renderContext as any);
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

/**
 * Warn (never fail) about allowlist entries no registered tool satisfies right
 * now, naming each one.
 *
 * Membership cannot be checked any earlier: `pi.getAllTools()` needs this
 * handle, and the config read is pure filesystem. And it must not fail the run:
 * a legitimate name is missing whenever its plugin is toggled off or its MCP
 * server is disconnected, so a hard error would make `tools: web_search` unusable
 * for anyone who disabled `web`. One warning per entry per tool call — a parallel
 * batch of eight agents sharing a list warns once, not eight times.
 *
 * Diagnostics go to `diag()` because a `console.*` write is discarded by a
 * subagent child and smears the fullscreen frame (see `core/log.ts`); the
 * on-screen copy only goes out where there is a UI to receive it.
 */
function warnUnavailableTools(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  alreadyWarned: Set<string>,
  agentName: string,
  tools: string[] | undefined,
): void {
  if (!tools || tools.length === 0) return;
  let unknown: string[];
  try {
    const known = pi.getAllTools().map((t) => t.name);
    unknown = unknownToolEntries(tools, known).filter((entry) => !alreadyWarned.has(entry));
  } catch (e) {
    // A handle that cannot answer is not a reason to lose the dispatch.
    diag("subagent", `tool-membership check skipped for "${agentName}": ${describeError(e)}`);
    return;
  }
  if (unknown.length === 0) return;
  for (const entry of unknown) alreadyWarned.add(entry);
  const message = formatUnknownToolsWarning(agentName, unknown);
  diag("subagent", message);
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // A context too stale to notify must not fail the run it is only warning about.
  }
}

/**
 * Warn (never fail) about a `thinking:` level pi's `--thinking` does not take.
 *
 * `spawnSubagent` withholds the flag in this case, which is what pi would have
 * done anyway — the difference is that the child no longer runs at the default
 * level silently: pi's own notice is a stderr warning, and a successful json
 * child's stderr is never read. One warning per distinct value per tool call.
 */
function warnUnknownThinkingLevel(
  ctx: ExtensionContext,
  alreadyWarned: Set<string>,
  thinking: string | undefined,
): void {
  if (thinking === undefined || alreadyWarned.has(thinking)) return;
  const { warning } = resolveThinkingLevel(thinking);
  if (!warning) return;
  alreadyWarned.add(thinking);
  diag("subagent", warning);
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(warning, "warning");
  } catch {
    // Same rule as the tool-membership warning: a report must not lose a run.
  }
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
        { overlay: true, overlayOptions: OVERLAY_CHROME },
      );
    },
  });
}

// ── Default export ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  registerSubagent(pi);
}

function policyError(mode: "single" | "parallel", error: unknown): SubagentToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    details: { mode, results: [], progress: undefined },
    isError: true,
  };
}

const PARALLEL_OUTPUT_MAX_CHARS = 12_000;

function resultOutput(result: SubagentResult): string {
  return result.finalOutput ?? result.error ?? "completed";
}

function formatResultsSummary(results: SubagentResult[]): string {
  const lines = results.map((r) => {
    const status = r.error || r.exitCode !== 0 ? "✗" : "✓";
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
