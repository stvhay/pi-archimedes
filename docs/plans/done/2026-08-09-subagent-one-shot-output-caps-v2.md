# Subagent one-shot mode and output caps on v2.1.0

**Status:** COMPLETED
**Date:** 2026-08-15
**Branch:** `rebuild/subagent-one-shot-mode-210`
**Depends on:** `rebuild/subagent-execution-limits-210` at `23d8fbf7381f2081806165e26d6b0962aef13ef9`

## Goal

Add cold one-shot child execution to the bounded v2.1.0 stack. Keep exactly one provider request, preserve agentic timeout behavior and local thinking overrides, and apply a caller-supplied provider-native output-token cap when the emitted provider payload exposes a supported shape.

## Contract

- `mode?: "agentic" | "one-shot"` and `thinking?` are additive at top level and per parallel task.
- Task mode/thinking overrides top-level values; selected agent thinking remains authoritative.
- One-shot always resolves `maxProviderRequests` to `1` and rejects nonzero provider retries.
- One-shot has no implicit wall-clock deadline. Parent cancellation and explicit `maxDurationMs` remain available.
- One-shot disables tools, discovered extensions, skills, context files, and session persistence. Prompt-template macros remain available. Only the child guard is explicitly loaded.
- `limits.maxOutputTokens` is a positive integer accepted only for one-shot calls. It is not an Archimedes operator setting and does not change agentic behavior.
- One-shot rejects cumulative `maxTotalTokens` and `maxCostUsd`; post-response accounting cannot bound its sole request.
- The guard clamps known provider payload fields without increasing an existing lower cap. Unknown shapes run unchanged and report `unsupported`.
- Applied provider `length` stops become structured `output-limit` termination evidence. All available output and usage remain returned.
- Result execution evidence reports resolved profile, limits, and requested output cap with `applied` or `unsupported` enforcement.
- No billing-class policy belongs upstream. The pi-setup wrapper will inject its metered-model default separately.

## Supported payload shapes

- Root: `max_output_tokens`, `max_completion_tokens`, `max_tokens`, `maxOutputTokens`.
- Google-style nested config: `config.maxOutputTokens` and legacy `generationConfig.maxOutputTokens`.
- Unsupported, primitive, array, malformed, or Pi Codex Responses payloads remain unchanged and produce truthful unsupported evidence; Codex's current adapter exposes no provider output-cap field.

## Tasks

### 1. Define resolved execution profile

- Add shared mode/thinking tuples and `ResolvedChildExecution`.
- Resolve each child once from operator/top-level/task/agent inputs.
- Enforce one request for one-shot and reject incompatible cumulative limits.
- Add RED tests for precedence, sibling independence, immutable request cap, no implicit duration, and invalid mode/limit combinations.

### 2. Isolate one-shot spawning

- Pass the resolved execution object unchanged through dispatch, execution, and spawn.
- Add one-shot CLI flags while retaining prompt-template macros and explicit child guard loading.
- Preserve effective model selection, agent system-prompt precedence, Windows invocation shape, ask socket cleanup, ordering, and agentic arguments.
- Add a no-model subprocess smoke proving explicit guard loading with discovered resources disabled.

### 3. Clamp provider output payloads

- Add bounded pure payload-clamp helpers with root and nested shape tests.
- Emit sideband applied/unsupported evidence without logging provider payloads.
- Convert an applied provider length stop to `output-limit` without discarding final output or usage.
- Preserve unsupported-provider execution and the one-request/no-retry invariant.

### 4. Expose execution evidence

- Attach immutable effective profile and limits to successful, stopped, and process-error results.
- Include output-limit enforcement evidence when requested.
- Keep single/parallel result order and existing output projection unchanged.
- Verify model labels for both modes, including compact parallel rows inherited from PR1.

### 5. Document and verify

- Document isolation, precedence, unsupported enforcement, no implicit deadline, prompt-template behavior, and cumulative-limit rejection.
- Move this plan to `docs/plans/done/` and update plan index.
- Run frozen install, package/workspace TypeScript, focused/full tests, exact Pi 0.74 subagent canary, diff checks, and independent review.

## Acceptance criteria

- [x] Omitted mode preserves current agentic behavior.
- [x] One-shot makes exactly one provider request and rejects provider retries.
- [x] One-shot has no implicit 180-second deadline.
- [x] Explicit prompt-template macros remain available; other ambient resources stay disabled.
- [x] Known payloads receive the requested or stricter existing cap; unknown payloads run with unsupported evidence.
- [x] Provider length stops preserve output/usage and report `output-limit` only when the cap was applied.
- [x] Cumulative token/cost limits cannot masquerade as one-shot spend enforcement.
- [x] Effective profile, limits, and output-limit enforcement are returned on all result paths.
- [x] Agentic and one-shot model labels remain visible without duplicate model-resolution logic.
- [x] Package and workspace gates pass.

## Out of scope

- Billing-class lookup or default cap policy.
- Provider-core API changes or strict support rejection.
- New public result modes, retry behavior, liveness watchdogs, or prompt-template isolation changes.
- Repeated-error detection; that remains a separate PR stacked on PR1.
