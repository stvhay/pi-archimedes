# @pi-archimedes/subagent

Subagent dispatch with live TUI streaming and cost tracking for the [Pi coding agent](https://github.com/earendil-works/pi).

## Features

- **Single & parallel execution** — dispatch one task or fan out multiple tasks across different agents simultaneously
- **Live TUI streaming** — watch tool calls, cost, and current-turn/cumulative token counts for multi-turn agents in real time
- **Agent discovery** — auto-discovers agents from `.pi/agents/*.md` files at project, user, and global scope
- **Per-agent model override** — each subagent can use its own model, falling back to the parent's selection
- **Cost tracking** — detailed token usage (input, output, cache read/write) and cost per subagent, emitted through the core bus for the footer to consume
- **Execution limits** — optional per-child request, tool, token, cost, and wall-time ceilings with structured stop evidence and preserved partial output
- **One-shot mode** — one cold provider response from a complete packet, without tools or ambient Pi resources
- **`/agents` command** — full CRUD TUI for managing agent definitions with model picker, tool picker, and cross-scope collision warnings (available via the meta package)

## Screenshots

### Main view — parallel execution

Live progress panel showing two parallel subagents with token stats, cost, and recent output:

![subagents main view](../../docs/images/subagents-main-view.png)

### Agent details view

Browse and inspect agent configurations — name, model, tools, system prompt, and more:

![subagents agent view](../../docs/images/subagents-agent-view.png)

### Model selection

Pick from all available models registered in Pi's model registry:

![subagents model selection](../../docs/images/subagents-model-selection.png)

### Tool selection

Toggle which tools are available to an agent from Pi's full toolset:

![subagents tool selection](../../docs/images/subagents-tool-selection.png)

## Installation

```bash
pi install @pi-archimedes/subagent
```

Or install the full [pi-archimedes](../..) meta package for the integrated experience (cost tracking in footer, shared chrome, etc.):

```bash
pi install pi-archimedes
```

## Usage

### As a tool

The `subagent` tool accepts either a single `task` or an array of `tasks` for parallel execution:

```jsonc
{
  "agent": "reviewer",     // optional, defaults to "general"
  "task": "review the PR", // single task
  "model": "openrouter/anthropic/claude-4", // optional override
  "cwd": "/path/to/dir"    // optional working directory
}
```

Parallel mode:

```jsonc
{
  "tasks": [
    { "agent": "researcher", "task": "find all usages of foo" },
    { "agent": "reviewer", "task": "review the implementation plan" }
  ]
}
```

Parallel tool results include the compact status summary followed by labeled child outputs in task order. The combined child-output text is capped at 12,000 characters; complete results remain available in `details.results`.

Bound one child directly:

```jsonc
{
  "task": "review this patch",
  "limits": {
    "maxProviderRequests": 4,
    "maxToolCalls": 20,
    "maxTotalTokens": 100000,
    "maxCostUsd": 0.5,
    "maxDurationMs": 180000
  }
}
```

Top-level limits apply to every parallel child. A task may add stricter `limits`; it cannot raise operator or top-level ceilings. Results include a structured `termination` reason and preserve finalized or in-flight output and usage when a child is stopped.

Request, tool-call, fanout, and wall-time limits are enforced before additional work. `maxDurationMs` cannot exceed `2,147,483,647`, the maximum safe Node.js timer delay. Token and cost limits use reported assistant usage, so they may exceed the configured value by one provider response. Keep Pi's `retry.provider.maxRetries` at `0` for bounded runs, and use a provider-side account or key cap when a hard spend ceiling is required.

### One-shot mode

Use `one-shot` for a complete read-only packet that needs one model response without tool loops or ambient project material:

```jsonc
{
  "task": "Review the embedded patch and return findings as JSON",
  "mode": "one-shot",
  "thinking": "high"
}
```

One-shot mode:

- allows one provider request and otherwise uses the same timeout behavior as agentic mode;
- disables tools, discovered extensions, skills, context files, and session persistence;
- allows explicit `/template arguments` prompt-template macros without injecting templates into ordinary tasks;
- explicitly reloads only Archimedes' child execution guard;
- uses a packet-only system prompt unless a selected agent supplies one;
- preserves the normal result, usage, cancellation, and termination shapes.

`mode` and `thinking` are also accepted on each parallel task. Task values override top-level values; selected agent frontmatter remains authoritative for model, thinking, and system prompt. Agent tool and inherited-resource settings cannot override one-shot isolation flags.

Process environment, provider credentials, and ordinary Pi settings remain inherited. Nonzero `retry.provider.maxRetries` is rejected because it would violate the one-request contract. Provider timeout settings, parent cancellation, and optional `maxDurationMs` limits behave as they do in agentic mode. Headless scripts and durable run-bundle workers remain outside this interactive tool mode.

### Settings

Optional operator defaults live under `archimedes.subagent` in `~/.pi/agent/settings.json` and are also available through `/archimedes` when using the meta package. `0` means unlimited.

```json
{
  "archimedes.subagent": {
    "maxParallel": 2,
    "defaultLimits": {
      "maxProviderRequests": 6,
      "maxToolCalls": 30,
      "maxTotalTokens": 150000,
      "maxCostUsd": 0.75,
      "maxDurationMs": 300000
    }
  }
}
```

Malformed configured limits fail before any child is spawned. The subagent package requires `@earendil-works/pi-coding-agent` 0.74.0 or newer. Spawned children carry `PI_SUBAGENT_SOCKET`, which prevents this package from registering delegation tools recursively without relying on newer Pi CLI flags. Native nested tool-usage accounting is consumed by Pi versions that support it; all supported versions retain usage in `details.results` and Archimedes cost events.

### As a command

Run `/agents` to open the interactive Agents Manager for creating, editing, and deleting agent definitions.

## Agent files

Agents are defined as `.md` files with YAML frontmatter, placed in one of:

- **Project scope:** `<cwd>/.pi/agents/` — available only in this project
- **User scope:** `~/.pi/agents/` — available across all projects
- **Global scope:** installed via packages or extensions

Frontmatter supports: `name`, `model`, `tools`, `thinking`, `inheritProjectContext`, `inheritSkills`, `systemPromptMode`, and `systemPrompt`.

## Integration

When installed via `pi-archimedes` (the meta package), subagent cost events flow through `@pi-archimedes/core/bus` and are consumed by `@pi-archimedes/footer`'s `CostAccumulator`. This merges subagent tokens and cost into the main status bar for a unified view.

The `/agents` command is also only registered by the meta package (not by standalone `@pi-archimedes/subagent`).
