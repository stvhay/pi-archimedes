# Bounded Subagent Execution Implementation Plan

**Issue:** None
**Design:** None
**Date:** 2026-08-06
**Branch:** `feat/subagent-execution-limits`

**Goal:** Let callers and operators bound each subagent's provider requests, tool calls, observed tokens, observed cost, wall time, and parallel fanout while preserving partial output and unaffected siblings.

**Architecture:** Add one limits module that owns validation, effective-limit resolution, child-side counters, and structured stop records. Parent processes pass resolved limits through an internal environment variable and explicitly load a dedicated published child-guard extension, apply independent per-child deadlines, parse child stop markers from stderr, and retain finalized plus in-flight output and usage. Existing unlimited behavior remains the default; optional settings provide operator ceilings, and call-specific limits may only tighten them.

**Compatibility:** Public fields are additive. Limit enforcement uses Pi extension hooks available in `@earendil-works/pi-coding-agent` 0.74.0, the earliest public release in the current package scope. Spawned children suppress recursive delegation registration through the existing `PI_SUBAGENT_SOCKET` marker rather than a newer CLI flag. Native nested tool usage is returned for newer Pi versions; older compatible Pi versions still receive the same usage in `details.results` and Archimedes bus events.

**Public contract:** `limits` is optional on the top-level single-task input, the top-level parallel input, and each parallel task. It contains `maxProviderRequests` (count), `maxToolCalls` (count), `maxTotalTokens` (input + output + cache read + cache write), `maxCostUsd` (USD), and `maxDurationMs` (milliseconds). Top-level parallel limits apply to every child; task limits tighten them. Operator `defaultLimits` tighten all calls, and operator `maxParallel` rejects oversized fanout before any spawn.

**Limit semantics:** Request, tool-call, fanout, and wall-time limits are admission controls. Token and USD limits use assistant usage, including the latest in-flight partial usage when a process is terminated, and may exceed the configured value by one provider response. Provider SDK retries are not separately observable; bounded runs use the public `SettingsManager.create(cwd).getProviderRetrySettings()` API to reject configured nonzero `retry.provider.maxRetries`. Auto-compaction is cancelled in bounded child processes so its extra model request cannot bypass request accounting.

**Acceptance Criteria:**
- [ ] Missing limits preserve current single and parallel behavior.
- [ ] Operator defaults apply automatically; call limits can tighten but never raise them.
- [ ] Invalid settings fail closed before spawn.
- [ ] Provider request N+1 and tool call N+1 do not execute.
- [ ] Token, cost, and unknown-usage stops preserve prior output and usage.
- [ ] Wall-time expiry terminates only its child and preserves finalized and in-flight output/usage.
- [ ] One limited parallel child does not cancel siblings; result order remains task order.
- [ ] Results expose structured termination evidence and aggregate nested usage.
- [ ] Existing Windows spawn, ask-socket cleanup, progress, and unlimited behavior remain compatible.

**Verification Commands:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm -r exec -- tsc --noEmit
corepack pnpm test
git diff --check
git status --short
```

---

### Task 1: Define and validate limits [Independent]

**Context:** Establish the smallest public contract and pure logic before touching process execution. Zero-valued operator settings mean unlimited; tool-call values must be positive when supplied through the tool schema.

**Files:**
- Create: `packages/subagent/src/limits.ts`
- Create: `packages/subagent/src/limits.test.ts`
- Modify: `packages/subagent/src/types.ts`
- Modify: `packages/subagent/src/index.ts`

**Steps:**
1. Add failing tests for exact schema fields/units/placement, invalid or non-finite values, operator/top-level/task minimum resolution, request/tool admission, token/cost overshoot, and unknown usage.
2. Run focused tests and confirm failures are caused by missing behavior.
3. Implement limit types, validation, resolution, counters, stop reasons, and marker serialization.
4. Run focused tests and package typecheck.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/limits.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
```

### Task 2: Add operator settings [Depends on: Task 1]

**Context:** Operator ceilings must not depend on the model choosing to include limits. Add `archimedes.subagent` settings with unlimited defaults and expose them through the composed settings UI.

**Files:**
- Create: `packages/subagent/src/config.ts`
- Create: `packages/subagent/src/config.test.ts`
- Modify: `meta/src/config.ts`
- Modify: `meta/src/settings.ts`

The meta package already declares `@pi-archimedes/subagent` in `meta/package.json`; no dependency wiring change is needed.

**Steps:**
1. Add failing config tests for default loading, nested merge, zero-as-unlimited normalization, and malformed-value rejection.
2. Implement load/save/settings-item helpers using Core's existing settings I/O.
3. Compose subagent settings into the meta package.
4. Run focused tests plus subagent and meta typechecks.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/config.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm --filter pi-archimedes exec tsc --noEmit
```

### Task 3: Enforce child-side admission [Depends on: Task 1]

**Context:** The child process owns provider and tool event hooks. Install guards only when the internal limits environment variable is present. Emit one machine-readable stderr marker, abort the current agent, block denied tools, and cancel compaction.

**Files:**
- Create: `packages/subagent/src/child-guard.ts`
- Create: `packages/subagent/src/spawn.test.ts`
- Modify: `packages/subagent/src/limits.ts`
- Modify: `packages/subagent/src/limits.test.ts`
- Modify: `packages/subagent/src/index.ts`
- Modify: `packages/subagent/src/spawn.ts`

**Steps:**
1. Add failing tests using a small fake `ExtensionAPI` for request N+1, tool N+1, usage stops, idempotent stop emission, and compaction cancellation.
2. Implement child hook registration and internal environment serialization in a dedicated extension entry.
3. Pass only resolved non-empty limits to child processes and always add the published child-guard path through Pi's explicit `--extension` flag, proving the guard loads even when parent discovery differs.
4. Extract one reliable terminate helper used by both cancellation and later limit handling; test SIGTERM/SIGKILL fallback and the unchanged Windows `node <resolved-js>` command shape through a pure invocation builder.
5. Assert existing ask-socket cleanup listeners remain attached for exit/error paths.
6. Run focused tests and package typecheck.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/limits.test.ts src/spawn.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
```

### Task 4: Preserve output and stop evidence [Depends on: Task 3]

**Context:** Parent streaming must parse stop markers without leaking them as process errors, terminate the child promptly, and return prior assistant text when `agent_end` never arrives.

**Files:**
- Create: `packages/subagent/src/stream.test.ts`
- Modify: `packages/subagent/src/stream.ts`
- Modify: `packages/subagent/src/handlers.ts`
- Modify: `packages/subagent/src/types.ts`

**Steps:**
1. Add failing synthetic-process tests for marker parsing, stdout/stderr drain ordering, partial-output fallback, structured termination, ordinary stderr, and cancellation distinction.
2. Implement line-oriented stderr parsing and prompt child termination on a valid limit marker.
3. Track `message_update` as replaceable in-flight text/usage; fold finalized `message_end` data without double counting and preserve both when `agent_end` never arrives.
4. Track complete token and cost components needed for native aggregate usage.
5. Run focused tests and package typecheck.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/stream.test.ts src/handlers.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
```

### Task 5: Wire deadlines, fanout, and native usage [Depends on: Tasks 2 and 4]

**Context:** Resolve limits before spawn, reject unsafe provider-retry settings, enforce one independent deadline per child, cap fanout before dispatch, and aggregate child usage on the final tool result.

**Files:**
- Create: `packages/subagent/src/execute.test.ts`
- Modify: `packages/subagent/src/index.ts`
- Modify: `packages/subagent/src/execute.ts`
- Modify: `packages/subagent/src/cost.ts`
- Modify: `packages/subagent/src/types.ts`

**Steps:**
1. Add failing tests for independent deadline state, stopped-child/successful-sibling ordering, fanout rejection, and aggregate usage.
2. Resolve operator, top-level, and task limits once per child; use Pi's public `SettingsManager` to reject nonzero provider retries for bounded runs.
3. Compose parent cancellation with per-child deadlines and classify timeout versus user abort.
4. Return aggregate `usage` and emit cache-token deltas through the existing bus.
5. Run focused tests and package/meta typechecks.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/execute.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm --filter pi-archimedes exec tsc --noEmit
```

### Task 6: Document and complete plan [Depends on: Task 5]

**Context:** Document exact semantics, especially one-response overshoot and provider-side spend caps. Move this plan to done only after final verification.

**Files:**
- Modify: `packages/subagent/README.md`
- Modify: `README.md`
- Modify: `packages/subagent/package.json`
- Modify: `docs/plans/README.md`
- Move after verification: `docs/plans/2026-08-06-bounded-subagent-execution.md` → `docs/plans/done/2026-08-06-bounded-subagent-execution.md`

**Steps:**
1. Document tool fields, settings, stop evidence, compatibility floor, and hard/observed limit distinction.
2. Update peer dependency floor without changing package versions or publishing artifacts.
3. Run focused tests, all workspace typechecks, full tests, and diff checks.
4. Update plan index to completed and move the plan into `done/`; rerun invalidated documentation/diff checks.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm -r exec -- tsc --noEmit
corepack pnpm test
git diff --check
```

## File Conflicts

Tasks 1, 3, and 4 share `limits.ts`/`types.ts`; execute in listed dependency order. Tasks 2 and 5 share meta/tool wiring; Task 5 follows Task 2. No task is safe for parallel write execution.

## Execution Handoff

Plan saved to: `docs/plans/2026-08-06-bounded-subagent-execution.md`.
Recommended next skill: `test-driven-development`; use `verification-before-completion` before commits or PR preparation.
