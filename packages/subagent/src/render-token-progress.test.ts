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

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};
const context = { state: {}, invalidate() {} };

function progress(): SubagentProgress {
  return {
    agent: "subagent",
    status: "running",
    task: "multi-turn task",
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    toolCount: 1,
    turnCount: 2,
    turnTokens: 1_200,
    inputTokens: 6_000,
    outputTokens: 2_400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens: 8_400,
    cost: 0,
    durationMs: 100,
    error: undefined,
    model: undefined,
    output: undefined,
    recentOutput: undefined,
    toolCalls: undefined,
  };
}

function result(): SubagentResult {
  return {
    agent: "subagent",
    task: "multi-turn task",
    exitCode: 0,
    usage: { input: 6_000, output: 2_400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
    model: undefined,
    finalOutput: "done",
    error: undefined,
    progress: progress(),
    progressSummary: { toolCount: 1, tokens: 8_400, durationMs: 100 },
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

describe("multi-turn token rendering", () => {
  const expected = "1k turn / 8k total tok";

  it.each([
    ["compact completed single", () => textOutput((text) => renderCompactSingle(text, result(), progress(), theme, context))],
    ["compact completed parallel", () => textOutput((text) => renderCompactParallel(text, details(), theme, context))],
    ["compact live single", () => textOutput((text) => renderCompactProgress(text, progress(), theme, context))],
    ["compact live parallel", () => textOutput((text) => renderCompactParallelProgress(text, details(), theme, context))],
    ["expanded completed", () => buildExpandedText(result(), progress(), theme)],
    ["expanded live single", () => textOutput((text) => renderProgressExpanded(text, progress(), theme))],
    ["expanded live parallel", () => buildProgressExpandedText(progress(), theme)],
  ])("shows current-turn and cumulative tokens in %s", (_name, render) => {
    expect(render()).toContain(expected);
  });
});
