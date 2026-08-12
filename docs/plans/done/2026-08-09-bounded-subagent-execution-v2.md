# Bounded Subagent Execution on v2.0.1

**Date:** 2026-08-09
**Branch:** `rebuild/subagent-execution-limits-v2`
**Base:** `v2.0.1` (`bdfeea3ed77392a2d02617fa1e0d4aa5fd8317e3`)
**Status:** COMPLETED

## Goal

Add optional per-child execution limits and truthful partial-state preservation to current pi-archimedes without regressing v2.0.1 model management, child-session correlation, startup behavior, or render contracts.

## Current-base decisions

- Existing callers remain unlimited by default.
- Operator defaults and call limits compose by taking the lower non-zero value.
- Limit only the offending child; preserve sibling completion and stable ordering.
- Provider/tool admission happens before the next action. Completed-response token/cost accounting may overshoot by one response.
- Preserve full or partial output and canonical usage for limit, cancellation, timeout, malformed final-event, and process-error paths.
- Parse legacy cumulative and Pi 0.84 delta-only message streams; cap live reconstructed previews at 12,000 characters while authoritative `message_end` replaces partial output/usage.
- Keep native v2.0.1 `childSessionId`, model validation, agent management, top-level execute import, and TypeBox package.
- Display the effective model in live and completed single and parallel progress. Initial model precedence is agent override, call model, then active parent model.
- Keep compact parallel model-visible output under one 12,000-character global budget while full results remain in structured details.
- Show current-turn versus cumulative tokens only after the second provider turn.
- Support Pi 0.74 by suppressing `subagent`/`list_agents` registration in child context instead of using the newer `--exclude-tools` flag.

## Public limits

- `maxProviderRequests`
- `maxToolCalls`
- `maxTotalTokens`
- `maxCostUsd`
- `maxDurationMs`
- `maxParallel` operator ceiling

All are optional. `0` means unlimited only in operator configuration; call inputs require positive finite values.

## Tasks

### 1. Establish current-base RED tests

Port behavior tests without replacing v2.0.1 production files. Retain native child-session tests and add model-label coverage for single/parallel live/completed render paths.

### 2. Port deep limit and usage modules

Add validated limit normalization/resolution, child guard, dispatch policy, canonical usage helpers, structured termination, and config/settings integration.

### 3. Integrate current execution/spawn seams

Resolve current agent config/model validation first, keep the top-level execute import, pass one resolved child plan through execution, and preserve Windows invocation, ask-socket cleanup, abort provenance, and stable parallel slots.

### 4. Integrate Pi 0.84 stream handling

Assemble indexed text/thinking deltas, retain bounded partial previews, replace them from authoritative final messages, contain malformed events, preserve native child session IDs, and expose effective model early.

### 5. Preserve model-visible parallel output and adaptive progress

Reuse existing result-content and renderer seams. Add no result-mode interface.

### 6. Document and verify

Move this plan to `docs/plans/done/`, mark it completed in the index, update root/package READMEs, and run all package/workspace checks.

## Acceptance

- [x] Unlimited agentic behavior remains the default.
- [x] Every configured limit validates and only tightens operator ceilings.
- [x] Provider retries are rejected for bounded children.
- [x] Time/cancel/request/tool/token/cost/unknown-usage stops preserve available output and usage.
- [x] Pi 0.74 legacy and Pi 0.84 delta streams both pass.
- [x] Native v2.0.1 child session IDs and model validation remain intact.
- [x] Effective model is visible in live/completed single/parallel progress.
- [x] Parallel parent-visible output is bounded; structured results remain complete.
- [x] Adaptive turn tokens preserve one-turn display compatibility.
- [x] Package and workspace gates pass.

## Verification

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @pi-archimedes/subagent exec vitest run
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm -r exec -- tsc --noEmit
corepack pnpm test
git diff --check
```
