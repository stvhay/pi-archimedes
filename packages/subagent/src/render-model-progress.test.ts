import { describe, expect, it } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import {
  renderCompactParallel,
  renderCompactParallelProgress,
  renderCompactProgress,
  renderCompactSingle,
} from "./compact.js";
import {
  buildExpandedText,
  buildProgressExpandedText,
  renderProgressExpanded,
} from "./expanded.js";
import type { SubagentDetails, SubagentProgress, SubagentResult } from "./types.js";

const MODEL = "provider/model-name";
const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};
const context = { state: {}, invalidate() {} };

function progress(): SubagentProgress {
  return {
    agent: "subagent",
    status: "running",
    task: "show the model",
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    toolCount: 0,
    inputTokens: 1,
    outputTokens: 1,
    tokens: 2,
    cost: 0,
    durationMs: 100,
    error: undefined,
    model: MODEL,
    output: undefined,
    recentOutput: undefined,
    toolCalls: undefined,
  };
}

function result(): SubagentResult {
  return {
    agent: "subagent",
    task: "show the model",
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    model: MODEL,
    finalOutput: "done",
    error: undefined,
    progress: progress(),
    progressSummary: { toolCount: 0, tokens: 2, durationMs: 100 },
  };
}

function textOutput(render: (text: Text) => void): string {
  let output = "";
  render({ setText(value: string) { output = value; } } as Text);
  return output;
}

function details(): SubagentDetails {
  return { mode: "parallel", results: [result()], progress: [progress()] };
}

describe("effective model rendering", () => {
  it.each([
    ["compact completed single", () => textOutput((text) => renderCompactSingle(text, result(), progress(), theme, context))],
    ["compact completed parallel", () => textOutput((text) => renderCompactParallel(text, details(), theme, context))],
    ["compact live single", () => textOutput((text) => renderCompactProgress(text, progress(), theme, context))],
    ["compact live parallel", () => textOutput((text) => renderCompactParallelProgress(text, details(), theme, context))],
    ["expanded completed", () => buildExpandedText(result(), progress(), theme)],
    ["expanded live single", () => textOutput((text) => renderProgressExpanded(text, progress(), theme))],
    ["expanded live parallel", () => buildProgressExpandedText(progress(), theme)],
  ])("shows the model in %s", (_name, render) => {
    expect(render()).toContain(MODEL);
  });
});
