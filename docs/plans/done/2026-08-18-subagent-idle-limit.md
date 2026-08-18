# Progress-Aware Subagent Idle Limit

**Status:** COMPLETED
**Date:** 2026-08-18

## Goal

Add an optional sliding inactivity limit for subagents without changing existing absolute wall-time semantics.

## Design

- Add `maxIdleMs` beside `maxDurationMs` in public execution limits and operator defaults.
- Add `idle-limit` beside `time-limit` in structured termination evidence.
- Keep `maxDurationMs` as an absolute deadline.
- Use one controller that synchronously records the first parent, hard, idle, or worker-stop cause.
- Reset idle time only after minimum runtime validation of a known child JSON event shape.
- Count streaming `message_update` and `tool_execution_update` events as activity.
- Do not count JSON primitives/arrays, unknown or malformed events, the parent renderer's one-second heartbeat, malformed stdout, or stderr as activity.
- Pause idle while a bridged `ask` waits for a human; answer, cancellation, or socket close restarts a fresh lease while hard/parent causes remain active.
- Preserve the existing two-minute no-event startup safeguard as distinct worker-startup behavior.
- Settle synchronously on child close/error and dispose timers/listeners without erasing recorded cause.

## Tasks

1. Add failing tests for public schema/config/limit resolution and meta settings persistence.
2. Add failing fake-timer tests for idle expiry/observed duration, renewal, every first-cause ordering, exact-tick tie, and cleanup.
3. Add failing stream tests for model/tool updates, runtime-invalid JSON values/events, worker-stop recording, and synchronous settlement.
4. Add failing ask-bridge tests for pending/resolved/cancelled/socket-close pause lifecycle.
5. Implement the smallest controller, stream validation/callback, ask bridge, and settings changes.
6. Update package and repository documentation.
7. Run package typecheck, focused tests, recursive typechecks, full tests, and package dry-runs.

## Acceptance

- Active child event streams can exceed one idle window and complete.
- Children that become silent after startup terminate with `idle-limit` and retain partial output/usage; no-event startup failures remain distinct.
- Continuously active children still stop at an explicitly configured `maxDurationMs`.
- Parent, worker, hard, and idle causes retain deterministic first-cause provenance.
- Human ask latency does not consume idle budget.
- Existing result ordering, progress rendering, usage, model resolution, child trace correlation, and one-shot isolation remain unchanged.

## Verification

```bash
corepack pnpm --filter @pi-archimedes/subagent exec vitest run
corepack pnpm --filter @pi-archimedes/subagent exec tsc --noEmit
corepack pnpm -r exec -- tsc --noEmit
corepack pnpm test
corepack pnpm -r pack --dry-run
```
