/** Managed pi-setup preserves script-callable delegation. Upstream 2.11.1's
 * model-only exposure would remove tools.subagent from existing codemode callers.
 * Child recursion remains separately blocked by registration and spawn guards. */

import { describe, it, expect, vi } from "vitest";
import { registerSubagent } from "./index.js";

type RegisteredTool = { name: string; exposure?: string; annotations?: Record<string, boolean> };

function register(): Record<string, RegisteredTool> {
  const tools: RegisteredTool[] = [];
  registerSubagent({
    registerTool: (t: unknown) => tools.push(t as RegisteredTool),
    on: () => {},
    getAllTools: () => [],
    events: { emit: () => {}, on: () => () => {} },
  } as never);
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("subagent exposure", () => {
  it("subagent remains direct for existing model and script callers", () => {
    expect(register().subagent!.exposure).toBe("direct");
  });

  it("list_agents stays direct — a script that dispatches nothing still reads the catalogue", () => {
    expect(register().list_agents!.exposure ?? "direct").toBe("direct");
  });

  it("neither tool carries annotations", () => {
    const tools = register();
    expect(tools.subagent!.annotations).toBeUndefined();
    expect(tools.list_agents!.annotations).toBeUndefined();
  });

  it("nothing in this package is codemode or deferred exposure (ADR 0029)", () => {
    for (const tool of Object.values(register())) {
      expect(["codemode", "deferred", "hidden"]).not.toContain(tool.exposure);
    }
  });
});
