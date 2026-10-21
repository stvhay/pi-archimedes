/**
 * Issue #114 — the parameter set `subagent` declares is the whole contract, so
 * every name in it must be a name `execute` actually reads.
 *
 * #114 deleted a declared `async` boolean ("Run asynchronously
 * (fire-and-forget)") that nothing read: a model that passed `async: true` got a
 * fully synchronous run with no warning. That is a false statement in a
 * model-facing contract, and worse than a missing feature, because the contract
 * *is* what the model believes about the tool — it is what gets rendered into
 * the tool list, what the model plans around, what a wrong answer gets blamed
 * on. Deleting the claim is the fix; implementing fire-and-forget is out of
 * scope and blocked on #113 (reaping subagent children across session
 * replacement).
 *
 * The review that followed found a SECOND instance of the same defect class the
 * issue never named: `count?: number` on the parallel task item, read nowhere.
 * It differed from `async` in one instructive way: it lived only in the
 * hand-written `params` type on `execute` in `index.ts`, never in `TaskItem`, so
 * the JSON Schema the model sees never advertised it and a guard that enumerates
 * the schema alone could not have caught it. The root cause of both was one
 * contract stated twice — once for the model, once for TypeScript — with nothing
 * keeping the two in step. So the fix is structural rather than another
 * assertion: `SubagentParams` in `tool-schema.ts` is
 * `Static<typeof SUBAGENT_PARAMS_SCHEMA>` and `execute` takes that, which is the
 * `ask` / `sudo` precedent. There is no second list left to drift on its own, so
 * the only low-friction way to introduce a `count` is to say so at one of the
 * two surfaces a reviewer reads: the schema, or `execute`'s signature.
 *
 * What is guarded where, stated honestly:
 *
 *   - the schema's declared sets are pinned below, exactly and enumerated from
 *     the schema object rather than restated;
 *   - there is no second TS-side list left for a test to police. `tsc` does
 *     reject a params type that *contradicts* the schema — `model?: number` at
 *     the params position fails `registerTool`'s `execute` with TS2322 — but
 *     that check is neither new nor the derivation's doing: `registerTool`
 *     infers `TParams` from `parameters` and declares `execute`'s `params` as
 *     `Static<TParams>` (`pi-coding-agent` `dist/core/extensions/types.d.ts:514`),
 *     so the same TS2322 fires with or without `SubagentParams` (measured against
 *     the pre-derivation literal, and it failed there too).
 *   - what `tsc` never caught, and still does not, is the phantom itself. An
 *     extra *optional* member only widens the params type, and pi declares
 *     `execute` as a method, so method parameters are bivariant: `count?: number`
 *     in the old literal, in `TaskItem` inside that literal, and spliced on as
 *     `params: SubagentParams & { count?: number }` all compile (each measured).
 *     So the derivation removes the *place* a phantom hid — it does not add a
 *     compiler check that would catch one. Writing a phantom now takes a
 *     deliberate `& { … }` at the params position, an edit a reviewer sees, where
 *     before it was the default way to state the contract.
 *   - the residual gap, stated against what this branch removed rather than
 *     against the compiler. The ~370-line source-text scanner deleted in
 *     `ca1a328` DID catch a declared-and-unread task field: it parsed
 *     `index.ts` as text, derived the task fields the parallel branch reads
 *     (`readTaskFields()`) and compared them against
 *     `declaredTaskItemParams()`, pinning both directions — declared and not
 *     read, and read and not declared. So type erasure was never what defeated
 *     that guard: it read the file, and a test over source text does see what
 *     the body reads. It was deleted for its false-positive cost, not because it
 *     did not work — it could redden on an unrelated `index.ts` edit (Greptile's
 *     P2 on PR #143), and that brittleness is why the maintainer took the
 *     schema-shared-type option instead. Losing it has a real price: on the
 *     task-item surface a schema field that `execute` declares but ignores is
 *     once again undetectable here, which is exactly how `async` survived. The
 *     cheap, non-brittle replacement is a BEHAVIOURAL pin, not a second parser:
 *     `index.test.ts` ("the object forwarded to the executor") now asserts the
 *     exact key set handed to `executeParallel` / `executeSubagent`, so dropping
 *     a forwarded task field — or adding one nobody declared — fails a test. Its
 *     limit, stated rather than sold: it pins the shape handed over, so a schema
 *     field that `execute` never forwards at all is invisible to it, and it
 *     cannot prove the executor reads a key it is handed. That residue is the
 *     phantom class, and it is genuinely uncovered again. What still covers it is
 *     the two pins below, a schema small enough to read in one screen — five
 *     top-level parameters, four task fields — and review.
 *
 * If a name reappears here it has to arrive together with the behaviour that
 * honours it (#113 first, for `async`) and a consumer that reads it; until then
 * the honest description is the one that does not mention it.
 */

import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { SUBAGENT_PARAMS_SCHEMA } from "./tool-schema.js";

/** Read a schema node's declared property names, failing loudly if it has none. */
function propertyNames(node: unknown, what: string): string[] {
  const properties = (node as { properties?: Record<string, unknown> }).properties;
  if (!properties) throw new Error(`${what} declares no properties`);
  return Object.keys(properties);
}

/** The top-level parameters `subagent` declares. Read from the schema, never restated. */
function declaredParams(): string[] {
  return propertyNames(SUBAGENT_PARAMS_SCHEMA, "SUBAGENT_PARAMS_SCHEMA");
}

/**
 * The properties declared for ONE entry of the `tasks` array — `TaskItem`.
 * Reached through the schema rather than exported from `tool-schema.ts`, so the
 * guard depends on the contract the model actually receives and the module
 * keeps its current public surface (`TaskItem` is deliberately unexported).
 */
function declaredTaskItemParams(): string[] {
  const tasks = (SUBAGENT_PARAMS_SCHEMA as { properties?: Record<string, unknown> }).properties?.tasks;
  if (!tasks) throw new Error("SUBAGENT_PARAMS_SCHEMA declares no `tasks` property");
  const items = (tasks as { items?: unknown }).items;
  if (!items) throw new Error("`tasks` is not an array schema — no item schema to enumerate");
  return propertyNames(items, "The `tasks` item schema (TaskItem)");
}

describe("SUBAGENT_PARAMS_SCHEMA — declared parameter set (issue #114)", () => {
  it("pins native and managed declared parameters", () => {
    // Exact and sorted, so it fails in BOTH directions: adding a name the pin
    // does not know (`async` would) and deleting one of the five. Read from the
    // schema object, never restated by hand. And because `SubagentParams` is
    // derived, adding a name here is also adding it to what `execute` is handed,
    // so this pin is where a new name has to be justified. What it does NOT
    // check is whether anything reads the name — that cross-surface claim
    // belonged to the scanner described in the header and no longer exists, so
    // the name says only what the body proves.
    expect([...declaredParams()].sort()).toEqual(["agent", "cwd", "limits", "mode", "model", "outputContract", "task", "tasks", "thinking"]);
  });
});

describe("TaskItem — declared parallel task item (issue #114, second instance: `count`)", () => {
  it("pins native and managed task-item properties", () => {
    // `count` was the proof this surface needs its own pin: a phantom can be
    // added to the task item while the top-level set above stays green. Like the
    // pin above this one enumerates the SCHEMA only — with the scanner gone
    // nothing here compares the four against what the parallel branch reads, so
    // the name claims the enumeration and no more.
    expect([...declaredTaskItemParams()].sort()).toEqual(["agent", "cwd", "limits", "mode", "model", "outputContract", "task", "thinking"]);
  });
});

// Legacy-caller compatibility check — a real behavioural guarantee, so it is
// pinned rather than assumed. TypeBox `Type.Object` does not set
// `additionalProperties: false`, so deleting `async` — and deleting `count` from
// the TS type, which the schema never advertised anyway — stops promising the
// option without turning an existing caller's payload into a validation error: a
// caller still passing `async: true`, or a `count` on a task, keeps validating, it
// just no longer gets a promise about it. That is what makes both deletions safe
// to land in a patch release, and it is the one thing here that fails on its own
// if anyone ever tightens the schema with `additionalProperties: false`.
describe("SUBAGENT_PARAMS_SCHEMA — legacy callers passing the deleted fields still validate", () => {
  it("accepts a payload carrying `async`", () => {
    expect(Value.Check(SUBAGENT_PARAMS_SCHEMA as never, { task: "x", async: true })).toBe(true);
  });

  it("accepts a task item carrying `count`", () => {
    expect(
      Value.Check(SUBAGENT_PARAMS_SCHEMA as never, { tasks: [{ task: "x", count: 1 }] }),
    ).toBe(true);
  });
});
