import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagent, SUBAGENT_PARAMS_SCHEMA } from "./index.js";

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minimum?: number;
  exclusiveMinimum?: number;
}

const limitProperties = (node: SchemaNode | undefined) => node?.properties?.limits?.properties;

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
    const root = SUBAGENT_PARAMS_SCHEMA as unknown as SchemaNode;
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
    const root = SUBAGENT_PARAMS_SCHEMA as unknown as SchemaNode;
    const limits = root.properties?.limits?.properties;

    expect(limits?.maxProviderRequests?.minimum).toBe(1);
    expect(limits?.maxToolCalls?.minimum).toBe(1);
    expect(limits?.maxTotalTokens?.minimum).toBe(1);
    expect(limits?.maxDurationMs?.minimum).toBe(1);
    expect(limits?.maxCostUsd?.exclusiveMinimum).toBe(0);
  });
});
