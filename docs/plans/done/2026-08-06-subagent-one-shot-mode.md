# Subagent One-Shot Mode Implementation Plan

**Issue:** None
**Design:** None
**Date:** 2026-08-06
**Branch:** `feat/subagent-one-shot-mode`
**Depends on:** `feat/subagent-execution-limits` at `a8685f5`

**Goal:** Add a cold, bounded subagent mode that treats the task as a complete packet and can replace interactive uses of `agnt invoke --one-shot`.

**Architecture:** Extend single and parallel task inputs with additive `mode` and `thinking` fields. Resolve each child's execution profile before dispatch. `one-shot` forces one provider request through the limits contract, launches Pi without tools, discovered extensions, skills, or project context, and reloads only the dedicated child guard. Explicit `/template arguments` prompt-template macros remain available; ordinary tasks receive no template expansion. Timeout behavior remains identical to `agentic` mode unless caller/operator limits tighten it. Existing `agentic` behavior remains the default. Pi 0.74.0's CLI flags and explicit-extension exception were verified with a no-model-call subprocess smoke before implementation.

**Public Contract:**
- `mode?: "agentic" | "one-shot"` is accepted at the top level and per parallel task; task mode overrides top-level mode.
- `thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` is accepted at the top level and per parallel task; task thinking overrides top-level thinking, while explicit agent frontmatter remains authoritative.
- `one-shot` uses a minimal packet-only system prompt unless a selected agent supplies an explicit system prompt.
- The one-request limit is immutable. Caller/operator `maxDurationMs` limits remain optional and compose exactly as they do for agentic children.
- One-shot rejects nonzero `retry.provider.maxRetries` through the existing bounded-run policy.
- Isolation covers discovered Pi resources and tools, not inherited process environment, provider credentials, or ordinary Pi settings. Selected agent frontmatter may supply model, thinking, and system prompt, but its tool/context/skill inheritance fields cannot override one-shot CLI flags.

**Acceptance Criteria:**
- [ ] Omitted mode preserves current agentic spawn arguments and behavior.
- [ ] One-shot children receive `--no-tools`, `--no-extensions`, `--no-skills`, and `--no-context-files`, while explicit prompt-template macros remain available and the dedicated child guard remains explicitly loaded.
- [ ] One-shot permits at most one provider request and otherwise retains agentic timeout behavior.
- [ ] Explicit thinking reaches the child with documented precedence.
- [ ] Single and parallel inputs expose identical mode/thinking fields; task overrides do not reorder results.
- [ ] Output, usage, cancellation, structured termination, Windows invocation shape, and agentic children remain compatible.

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

### Task 1: Define execution profiles [Independent]

**Context:** Keep mode resolution pure and small. One-shot safety derives from immutable built-in limits plus existing minimum-limit composition.

**Files:**
- Create: `packages/subagent/src/execution-profile.ts`
- Create: `packages/subagent/src/execution-profile.test.ts`
- Modify: `packages/subagent/src/types.ts`
- Modify: `packages/subagent/src/index.test.ts`
- Modify: `packages/subagent/src/index.ts`

**Steps:**
1. Add failing tests for schema placement, task-over-top-level precedence, agent thinking precedence, and one-shot built-in limits.
2. Implement profile types, resolution, and the minimal one-shot system prompt.
3. Add schema fields with exact enum values and descriptions.
4. Run focused tests and package typecheck.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/execution-profile.test.ts src/index.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
```

### Task 2: Build isolated spawn arguments [Depends on: Task 1]

**Context:** One-shot process isolation belongs in the existing spawn argument builder. The dedicated child guard is an explicit CLI extension and must survive `--no-extensions`.

**Files:**
- Modify: `packages/subagent/src/spawn.test.ts`
- Modify: `packages/subagent/src/spawn.ts`
- Modify: `packages/subagent/src/execute.ts`

**Steps:**
1. Add failing exact-argv tests for agentic compatibility, one-shot isolation flags, explicit prompt-template opt-in, explicit guard loading, thinking precedence, and agent system-prompt precedence. Add a subprocess compatibility test proving Pi 0.74.0 loads an explicit extension while discovery and other resources are disabled.
2. Pass the resolved profile through execute options.
3. Build one-shot arguments without honoring agent tool allowlists; retain model selection and Windows command construction.
4. Run focused tests and package typecheck.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run src/spawn.test.ts src/execute.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
```

### Task 3: Wire single and parallel policy [Depends on: Tasks 1 and 2]

**Context:** Resolve mode, thinking, and the built-in one-shot request limit per child before provider-retry validation and spawn. Preserve task ordering and existing progress contracts.

**Files:**
- Modify: `packages/subagent/src/index.ts`
- Modify: `packages/subagent/src/index.test.ts`
- Modify: `packages/subagent/src/execute.test.ts`

**Steps:**
1. Add failing tests proving one-shot limits compose with operator/top-level/task limits, reject nonzero provider retries, and keep sibling modes independent. Reuse the bounded guard's request-N+1, deadline, structured-termination, and partial-output tests as enforcement evidence.
2. Resolve profiles and limits for single and parallel calls before bounded provider-retry validation.
3. Pass mode/thinking to each child and return unchanged usage/termination details.
4. Run all subagent tests and package/meta typechecks.

**Focused verification:**
```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm --filter pi-archimedes exec tsc --noEmit
```

### Task 4: Document and complete plan [Depends on: Task 3]

**Context:** Document exact isolation and precedence without claiming that this mode replaces headless run-bundle workers.

**Files:**
- Modify: `packages/subagent/README.md`
- Modify: `README.md`
- Modify: `docs/plans/README.md`
- Move before final gate: `docs/plans/2026-08-06-subagent-one-shot-mode.md` → `docs/plans/done/2026-08-06-subagent-one-shot-mode.md`

**Steps:**
1. Document single/parallel examples, defaults, precedence, and isolation behavior.
2. State that one-shot is for complete read-only packets; headless automation remains outside this tool contract.
3. Move plan to done and update counts.
4. Run Node 24 frozen install, focused/full tests, workspace typechecks, and diff checks.

## File Conflicts

Tasks share `index.ts` and profile plumbing, so execute serially. This branch is intentionally stacked on the bounded-execution candidate because one-shot request enforcement and optional caller/operator deadlines reuse that public contract.

## Execution Handoff

Plan saved to: `docs/plans/2026-08-06-subagent-one-shot-mode.md`.
Recommended next skill: `test-driven-development`; use `verification-before-completion` before PR preparation.
