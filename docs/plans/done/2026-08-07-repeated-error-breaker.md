# Repeated Subagent Error Breaker Implementation Plan

**Issue:** pi-4tg9.19 — Stop subagents after repeated identical unrecovered errors
**Design:** Approved inline 2026-08-07
**Date:** 2026-08-07
**Branch:** fix/subagent-repeated-errors

**Goal:** Stop one agentic child after three consecutive identical failed tool results without retaining raw failure payloads or affecting siblings.

**Architecture:** Keep detection inside each existing `streamEvents` closure. Hash tool name, matching start arguments, and error result with Node SHA-256; retain only the latest hash and count. A successful tool result resets the count, while changed input or result starts a new sequence. On count three, use the existing per-child termination path with structured `repeated-error` evidence and preserved stream state.

**Acceptance Criteria:**
- [x] Three consecutive identical failed tool results stop only that child with `limit: 3`, `observed: 3`, and partial usage state.
- [x] A successful result resets the sequence; changed input or result starts a new sequence.
- [x] Output and usage captured before termination survive.
- [x] Breaker state and structured termination retain no raw arguments, error payload, or fingerprint; existing bounded private progress previews remain unchanged.
- [x] Existing bounded execution and Pi 0.74 compatibility remain intact.

**Verification Commands:**
```bash
corepack pnpm exec vitest run packages/subagent/src/stream.test.ts
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm exec vitest run --project @pi-archimedes/subagent
corepack pnpm exec vitest run
corepack pnpm -r exec tsc --noEmit
git diff --check
```

---

### Task 1: Lock breaker behavior with RED tests

**Files:** `packages/subagent/src/stream.test.ts`

Add deterministic child-stream cases for threshold termination with preserved state, changed-input reset, successful-result reset, and unaffected sibling completion. Run focused tests and confirm failures are caused by absent `repeated-error` behavior.

### Task 2: Add minimum per-stream detector

**Files:** `packages/subagent/src/stream.ts`, `packages/subagent/src/types.ts`

Use `node:crypto` SHA-256 and a fixed private threshold of three. Correlate start arguments by tool-call ID, discard them on result, store only hash/count, and reuse existing child termination/result assembly.

### Task 3: Document and verify

**Files:** `packages/subagent/README.md`, `docs/plans/README.md`

Document fixed consecutive-error behavior and non-persistence. Run focused, package, monorepo, recursive TypeScript, exact Pi 0.74-family compatibility, and diff checks. Move this plan to `docs/plans/done/` only after final verification.

## Verification Outcome

Completed 2026-08-07. Focused TDD covers threshold termination, reset semantics, sibling isolation, stable key ordering, malformed/correlated event handling, digest-only state, and depth/node/ID ceilings. Normal and exact Pi 0.74-family gates each passed package/workspace TypeScript, 146 subagent tests, and 315 monorepo tests. Final subscription-backed Terra patch review returned PASS with no unresolved Critical or Important finding.
