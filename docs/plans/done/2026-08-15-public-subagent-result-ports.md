# Public Subagent Result Ports

**Status:** COMPLETED
**Date:** 2026-08-15
**Branch:** `feat/result-ports-210`
**Depends on:** `rebuild/subagent-repeated-errors-210` at `3576ddfd154fb274813a16e07607a15520ce73b7`

## Goal

Expose complete child execution evidence, named-agent model resolution, and typed bus payloads through stable package subpaths without moving caller policy into Archimedes.

## Contract

- `@pi-archimedes/subagent/types` exports output-contract, limit, execution, termination, usage, trace, progress, result, details, and tool-result contracts.
- `@pi-archimedes/subagent/agents` exports `resolveAgentModel(name, cwd)` through normal discovery and local overrides.
- `@pi-archimedes/core/bus` exports `ArchimedesBus`, `ArchimedesEventPayloadMap`, every payload type, `Events`, and `getBus`.
- Caller output contracts are transport labels copied into child results; Archimedes does not persist, score, or accept them.
- `childTrace.sessionId` equals `childSessionId`; no telemetry lookup or trace-ID inference occurs.
- `details.results[]` remains canonical, complete, and request ordered across success and failure. Pi `tool_result` remains the sole result transport.
- Routing, billing, authority, closeout, acceptance, persistence, and quality policy remain out of scope.

## Tasks

1. Add RED public self-import and type-contract tests.
2. Add RED output-contract transport tests for single, parallel, success, and spawn failure.
3. Add RED child session/trace correlation and typed bus tests.
4. Export the three package subpaths and smallest required types/functions.
5. Run package/workspace TypeScript, focused/full tests, package dry-runs, and diff checks.

## Acceptance

- [x] Public self-imports resolve without package-private paths.
- [x] Output contracts remain optional caller labels on every executed result path.
- [x] Child trace correlation is exact and omitted when no session is known.
- [x] Public model resolution preserves local model overrides.
- [x] Bus payloads are typed while listener failures remain isolated.
- [x] Existing limits, termination, usage, partial output, ordering, and aggregate tool usage remain intact.
- [x] No result bus, telemetry query, persistence, routing, billing, authority, or quality policy is added.

## Verification

```bash
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm --filter @pi-archimedes/core exec tsc --noEmit
corepack pnpm --filter @pi-archimedes/subagent exec vitest run
corepack pnpm -r exec -- tsc --noEmit
corepack pnpm test
(cd packages/subagent && npm pack --dry-run)
(cd packages/core && npm pack --dry-run)
git diff --check
```
