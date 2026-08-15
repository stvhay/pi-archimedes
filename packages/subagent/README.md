# @pi-archimedes/subagent

Subagent dispatch with live TUI streaming and cost tracking for the [Pi coding agent](https://github.com/earendil-works/pi).

Dispatch specialized subagents to offload complex tasks with live TUI streaming, parallel execution, cost tracking, and per-agent model overrides. By fanning out work to dedicated subagents, complex workflows can be executed concurrently while maintaining full visibility into progress and token usage.

## What you get

- **Single & parallel execution** — dispatch one task or fan out multiple tasks across different agents simultaneously
- **Live TUI streaming** — watch model, tool calls, cost, and current-turn/cumulative tokens with color-coded status and readable argument previews
- **Agent discovery** — auto-discovers agents from `.pi/agents/*.md` files at project, user, and global scope
- **Per-agent model override** — each subagent can use its own model, falling back to the parent's selection
- **Cost tracking** — detailed token usage (input, output, cache read/write) and cost per subagent, emitted through the core bus for the footer to consume
- **Trace correlation** — results expose the ephemeral child's logical Pi session UUID as optional `childSessionId` when Pi emits a valid session event
- **Execution limits** — optional per-child request, tool, token, cost, and wall-time ceilings with structured stop evidence and preserved partial output
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

## Install

```bash
pi install npm:@pi-archimedes/subagent
```

Or install full meta package:

```bash
pi install npm:pi-archimedes
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

Child output parsing accepts legacy cumulative updates and Pi 0.84 delta-only streams. Live reconstructed previews are capped at 12,000 characters; authoritative final output and usage replace partial state when available. Forced stops still return whatever output and usage the child emitted.

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

- **Project scope:** `<repo root>/.pi/agents/` — available only in this project
- **User scope:** `~/.pi/agent/agents/` — available across all projects
- **Global scope:** `<repo root>/.agents/agents/` or `~/.agents/agents/` — shared or installed subagents

Frontmatter supports: `name`, `description`, `model`, `tools`, and `thinking`. The markdown body becomes the agent's system prompt. Unknown frontmatter fields are preserved on edit but not interpreted.

Per-agent `model` and `thinking` assignments made in the `/agents` TUI are stored in `~/.pi/agent/agents.local.json` (machine-local, not committed) and take precedence over frontmatter values; on save, the TUI also strips these fields from the `.md` frontmatter. Frontmatter `model:` and `thinking:` still work as a fallback for hand-written agent files.

## Integration

When installed via `pi-archimedes` (the meta package), subagent cost events flow through `@pi-archimedes/core/bus` and are consumed by `@pi-archimedes/footer`'s `CostAccumulator`. This merges subagent tokens and cost into the main status bar for a unified view.

The `/agents` command is also only registered by the meta package (not by standalone `@pi-archimedes/subagent`).

← Back to [pi-archimedes](../../README.md)
