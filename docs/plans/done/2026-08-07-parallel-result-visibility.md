# Parallel Result Visibility Implementation Plan

**Issue:** pi-4tg9.18.2 — Expose parallel inline subagent outputs
**Design:** Existing result-content seam; no new public option or schema
**Date:** 2026-08-07
**Branch:** feat/subagent-execution-limits

**Goal:** Make parallel subagent results visible to parent models through existing tool content without changing child execution.

**Architecture:** `executeParallel()` continues to call `executeSubagent()` for every child. Result assembly uses one output extractor for single and parallel responses. Parallel content keeps its compact summary, then adds stable labeled child outputs under one 12,000-character total budget; complete results remain in `details.results`.

**Acceptance Criteria:**
- [x] Default parallel calls expose child output/error text in stable result order.
- [x] Added parallel output content is globally bounded, including labels and truncation markers.
- [x] Extreme fanout exposes the first result plus an explicit omitted-output count instead of silently dropping all output.
- [x] Single behavior, details, usage, termination, TUI rendering, and execution remain unchanged.
- [x] No tool parameter, schema, or exported type was added.

**Verification Commands:**
```bash
corepack pnpm vitest run packages/subagent
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm -r exec tsc --noEmit
corepack pnpm test
```

## Implementation

1. Add failing dispatcher tests for two-child order/error fallback, 200-child global bounds, and 800-child omission evidence.
2. Reuse `resultOutput()` for single and parallel result values.
3. Return summary plus bounded child-output text parts from the existing parallel result branch.
4. Document visible-output bounds in `packages/subagent/README.md`.
5. Run focused, full, compatibility, and independent review gates.

## Results

- Normal lock: 120 subagent tests and 289 monorepo tests pass with package/workspace TypeScript and frozen install.
- Exact Pi 0.74.0-family canary passes the same 120/289 tests and typechecks.
- Subscription-backed Terra review found one extreme-fanout omission defect; the 800-child regression and explicit omission fallback fixed it. Follow-up review returned PASS.
