import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagent } from "./index.js";

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}

const limitProperties = (node: SchemaNode | undefined) => node?.properties?.limits?.properties;

function registeredSubagentSchema(): SchemaNode {
  const previousSocket = process.env.PI_SUBAGENT_SOCKET;
  const tools: Array<{ name: string; parameters: unknown }> = [];
  delete process.env.PI_SUBAGENT_SOCKET;
  try {
    registerSubagent({
      registerTool: (tool: { name: string; parameters: unknown }) => tools.push(tool),
    } as unknown as ExtensionAPI);
  } finally {
    if (previousSocket === undefined) delete process.env.PI_SUBAGENT_SOCKET;
    else process.env.PI_SUBAGENT_SOCKET = previousSocket;
  }
  return tools.find((tool) => tool.name === "subagent")?.parameters as SchemaNode;
}

describe("subagent registration", () => {
  it("does not register delegation tools inside a spawned subagent", () => {
    const previousSocket = process.env.PI_SUBAGENT_SOCKET;
    const tools: string[] = [];
    process.env.PI_SUBAGENT_SOCKET = "/tmp/subagent.sock";

    try {
      registerSubagent({
        registerTool: (tool: { name: string }) => tools.push(tool.name),
      } as unknown as ExtensionAPI);
    } finally {
      if (previousSocket === undefined) delete process.env.PI_SUBAGENT_SOCKET;
      else process.env.PI_SUBAGENT_SOCKET = previousSocket;
    }

    expect(tools).toEqual([]);
  });
});

describe("subagent limits schema", () => {
  it("exposes identical limits on top-level and parallel task inputs", () => {
    const root = registeredSubagentSchema();
    const topLevel = limitProperties({ properties: { limits: root.properties?.limits ?? {} } });
    const task = limitProperties(root.properties?.tasks?.items);

    expect(Object.keys(topLevel ?? {})).toEqual([
      "maxProviderRequests",
      "maxToolCalls",
      "maxTotalTokens",
      "maxCostUsd",
      "maxDurationMs",
    ]);
    expect(task).toEqual(topLevel);
  });

  it("requires positive count, token, duration, and cost values", () => {
    const root = registeredSubagentSchema();
    const limits = root.properties?.limits?.properties;

    expect(limits?.maxProviderRequests?.minimum).toBe(1);
    expect(limits?.maxToolCalls?.minimum).toBe(1);
    expect(limits?.maxTotalTokens?.minimum).toBe(1);
    expect(limits?.maxDurationMs?.minimum).toBe(1);
    expect(limits?.maxDurationMs?.maximum).toBe(2_147_483_647);
    expect(limits?.maxCostUsd?.exclusiveMinimum).toBe(0);
  });
});
