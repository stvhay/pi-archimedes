# Repeated subagent error breaker on v2.0.1

**Status:** IN PROGRESS
**Date:** 2026-08-09
**Branch:** `rebuild/subagent-repeated-errors-v2`
**Depends on:** `rebuild/subagent-execution-limits-v2` at `4365aba`

## Goal

Stop only one child after three consecutive identical failed tool results while preserving partial output, usage, native v2 session/model behavior, and sibling execution.

## Contract

- Detection remains private inside each child `streamEvents` closure.
- A failure identity covers exact tool name, start arguments, and error result after deterministic object-key ordering.
- Raw tool-call IDs, arguments, results, and fingerprints are never retained in final results or structured termination.
- Only bounded SHA-256 fingerprints and the current consecutive count survive between events.
- Three consecutive identical valid failures produce `repeated-error`, `limit: 3`, `observed: 3`, and partial usage state.
- A valid success resets the streak. Changed valid failure evidence starts a new streak.
- Valid but unhashable arguments or results reset the streak as opaque changed evidence.
- Orphan, malformed, mismatched, duplicate-ID, and reused-ID events cannot manufacture a match.
- Correlation state is bounded by fixed depth, node, and tool-call-ID ceilings; overflow disables further detection for that child instead of retaining more data.
- Existing limit termination wins if already present. Breaker termination uses the existing per-child drain/kill path and does not affect siblings.
- No setting, public input, always-loaded extension, or configurable threshold is added.
- This PR is independent of one-shot mode and stacks directly on bounded PR1. PR1 children are agentic; one-shot children in the separate PR2 have no tools to produce these events.

## Tasks

### 1. Establish RED stream cases

Add focused child-stream tests for threshold stop, success and changed-evidence resets, key ordering, unhashable evidence, malformed correlation, bounded state, sibling isolation, and preserved output/usage.

### 2. Add bounded private detector

Use Node SHA-256 with deterministic bounded canonicalization. Hash tool-call IDs before correlation, discard paired call state after completion, and retain only the latest failed fingerprint/count.

### 3. Integrate termination

On the third identical failure, set structured `repeated-error` evidence and reuse the existing 250 ms output-drain termination path. Preserve whichever termination reason arrived first.

### 4. Document and verify

Document fixed behavior and privacy boundaries. Move this plan to `docs/plans/done/`, update the index, and run frozen install, package/workspace TypeScript, focused/full tests, exact Pi 0.74 package canary, diff checks, and independent review.

## Acceptance criteria

- [ ] Exactly three consecutive identical failed tool results stop one child.
- [ ] Success, changed evidence, and valid unhashable evidence reset the streak.
- [ ] Malformed, orphan, duplicate, reused, or mismatched events cannot trigger a false match.
- [ ] Depth, node, and correlation-ID state are bounded without raw retention.
- [ ] Partial output, usage, childSessionId, model, and structured termination survive.
- [ ] Siblings complete independently.
- [ ] Existing bounded and Pi 0.84 delta-stream behavior remains unchanged.
- [ ] Package and workspace gates pass.

## Out of scope

- Configurable thresholds, retry policy, semantic error similarity, cross-child correlation, durable fingerprints, output-token caps, or one-shot execution changes.
