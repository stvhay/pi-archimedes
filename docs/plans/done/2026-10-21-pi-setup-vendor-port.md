# pi-setup vendor port onto 2.11.1

Upstream base: `a44f94267239db0ef5d36d18d93391bf9d51c182` (`v2.11.1`).
Historical custom source remains at `8590ec0e1063811f86d1417ded9c2aeb48fd73b6` on the old vendor/work branches. This line ports contracts rather than merging or rewriting that history. Development Pi packages are pinned to 1.3.0; the existing `@types/node` hold remains.

## Retained contracts

- Public subagent `./agents`, `./config`, and `./types` ports; configured-model resolution; request-ordered result evidence.
- Caller/operator execution profiles and ceilings, first-stop termination, provider output-cap evidence, partial output/usage, and privacy-bounded repeated-error detection.
- Sliding idle leases renew on validated child activity, not parent repaint. Human ask waits pause idle time, never absolute deadlines or parent cancellation. Escalation checks actual exit, not `child.killed`.
- One-shot mode has one provider request, no tools/MCP/discovered extensions/skills/context files or session persistence, and an explicit child guard. Prompt-template macros intentionally remain available. No implicit wall deadline.
- Managed calls bypass the upstream bridge dispatch shortcut so enforcement cannot disappear. Native ask correlation/cancellation and accepted-success todo forwarding remain intact.
- Current-turn/cumulative token progress, bounded ordered parallel text, direct script-callable dispatch, and complete native JSON reports extended with execution/termination/child-trace evidence.
- Operator settings expose max parallelism and six default execution ceilings, including decimal USD. Ask replies omit absent custom input but retain defined strings.
- Footer sorts keyed extension statuses, preserves multiline Beads alignment, and only inlines Caveman/Ponytail when space permits.

## Native replacements

The singleton bus and custom cost accumulator are retired. `@pi-archimedes/core/events` supplies channel vocabulary and safe deferred emits over host-owned `pi.events`; no replay queue is added. Tool-result native usage counts each child once, excluding bridge results already accounted elsewhere. Progress displays live cost; footer totals update after result persistence. That timing is an explicit pi-setup owner decision.

Native parameter/report schemas, modern lifecycle outcomes, accepted-result todo forwarding, tool allowlists, MCP exclusion for closed allowlists, and upstream rendering/teardown remain authoritative. Managed truncation/cancellation is failed termination with partial evidence; unmanaged internal callers retain native outcome semantics.

## Policy stays outside this fork

Routing, billing-class policy, artifact persistence, evaluation and managed JSON transport normalization belong to pi-setup. Native reports retain full run output; pi-setup's wrapper bounds inline output and adds persistence and termination-source evidence. An output contract is not a quality verdict or authority grant.

Upstream's new sudo/web plugins remain default-enabled here. pi-setup explicitly disables both in its tracked settings; enabling either is a separate operator choice. Native first-run onboarding remains a human UI flow, not an agent authorization path. Onboarding state is runtime-only.

## Verification

Run `corepack pnpm -r exec tsc --noEmit` and `corepack pnpm test`. Managed regression suites coexist with native tests; the integrated suite contains 2,706 tests at this checkpoint. pi-setup separately verifies exact npm projections, installed wrapper behavior and its full gates. Local tests do not establish live-service delivery, publication, deployment, or overall release completion.
