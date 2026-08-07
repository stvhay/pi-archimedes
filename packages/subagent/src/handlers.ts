import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { StreamState } from "./types.js";
import { addUsage, readUsage } from "./usage.js";

export type JsonEvent = ExtensionEvent;
type ToolStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type ToolEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;
type MessageUpdateEvent = Extract<ExtensionEvent, { type: "message_update" }>;
type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;
type AgentEndEvent = Extract<ExtensionEvent, { type: "agent_end" }>;
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

// Truncation limits for previews
const ARGS_PREVIEW_MAX = 120;
const TOOL_CALLS_MAX = 50;
const RECENT_OUTPUT_MAX = 50;

/**
 * Extract a short args preview from tool arguments.
 * Generic: no hardcoded tool names.
 */
export function extractArgsPreview(args: unknown): string {
  if (typeof args === "string") {
    // Replace newlines so previews stay single-line
    return args.replace(/\n/g, " ").slice(0, ARGS_PREVIEW_MAX);
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    const keys = Object.keys(obj);
    // Single-key object: show the value directly (or serialize if complex)
    if (keys.length === 1) {
      const v = obj[keys[0]!];
      if (typeof v === "string") return v.replace(/\n/g, " ").slice(0, ARGS_PREVIEW_MAX);
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      // Complex value (array/nested object) — serialize just this value
      const serialized = JSON.stringify(v);
      if (serialized) return serialized.slice(0, ARGS_PREVIEW_MAX);
    }
    // Multi-key: find the longest string value (likely the main payload)
    let best: string | undefined;
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.length > (best?.length ?? 0)) {
        best = v;
      }
    }
    if (best) return best.replace(/\n/g, " ").slice(0, ARGS_PREVIEW_MAX);
  }
  const serialized = JSON.stringify(args);
  return serialized?.slice(0, ARGS_PREVIEW_MAX) ?? "";
}

/**
 * Handle a tool_execution_start event.
 */
export function handleToolStart(state: StreamState, event: ToolStartEvent): void {
  state.toolCount++;
  state.currentTool = event.toolName;
  state.currentToolArgs = JSON.stringify(event.args);
  state.currentToolStartedAt = Date.now();
  // Record tool call with args preview
  const argsPreview = extractArgsPreview(event.args);
  state.toolCalls.push(`${state.currentTool}: ${argsPreview}`);
  if (state.toolCalls.length > TOOL_CALLS_MAX) {
    state.toolCalls.splice(0, state.toolCalls.length - TOOL_CALLS_MAX);
  }
}

/**
 * Handle a tool_execution_end event.
 */
export function handleToolEnd(state: StreamState): void {
  state.currentTool = undefined;
  state.currentToolArgs = undefined;
  state.currentToolStartedAt = undefined;
}

/**
 * Handle a tool_execution_end event — capture tool result output for live display.
 * The result is in event.result (the tool's return value).
 */
export function handleToolResult(state: StreamState, event: ToolEndEvent): void {
  const result = event.result as Record<string, unknown> | undefined;
  if (!result) return;

  const toolName = event.toolName;

  // Extract text content from tool result
  const content = result.content as Array<Record<string, unknown>> | string | undefined;

  if (typeof content === "string" && content.trim()) {
    const lines = content.split("\n").filter((l) => l.trim());
    state.recentOutput.push(`[${toolName}] ${lines[0]?.slice(0, ARGS_PREVIEW_MAX)}`);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text" && (part.text as string)?.trim()) {
        const text = part.text as string;
        const lines = text.split("\n").filter((l) => l.trim());
        state.recentOutput.push(`[${toolName}] ${lines[0]?.slice(0, ARGS_PREVIEW_MAX)}`);
        break;
      }
    }
  }

  if (state.recentOutput.length > RECENT_OUTPUT_MAX) {
    state.recentOutput.splice(0, state.recentOutput.length - RECENT_OUTPUT_MAX);
  }
}

function objectItems<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== null && typeof item === "object") as T[];
}

function assistantContent(message: AssistantMessage): AssistantMessage["content"] {
  return objectItems<AssistantMessage["content"][number]>(message.content);
}

function assistantText(message: AssistantMessage): string | undefined {
  const parts: string[] = [];
  for (const part of assistantContent(message)) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      parts.push(part.text);
    } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      parts.push(`[thinking] ${part.thinking.trim()}`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function clearPartialUsage(state: StreamState): void {
  state.partialUsage = readUsage(undefined);
}

/** Handle the latest in-flight assistant message as replaceable partial state. */
export function handleMessageUpdate(state: StreamState, event: MessageUpdateEvent): void {
  const message = event.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") return;
  if (!state.model && message.model) state.model = message.model;
  state.streamingOutput = assistantText(message);
  state.partialUsage = readUsage(message.usage);
}

/**
 * Handle a message_end event — extract usage and text from assistant messages.
 */
export function handleMessageEnd(state: StreamState, event: MessageEndEvent): void {
  const message = event.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") return;

  // Finalized data replaces the latest partial message.
  state.streamingOutput = undefined;
  clearPartialUsage(state);

  // Capture model name
  if (!state.model && message.model) {
    state.model = message.model;
  }

  // Collect text + thinking output
  for (const part of assistantContent(message)) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      state.accumulatedOutput.push(part.text);
      const lines = part.text.split("\n").filter((line: string) => line.trim());
      state.recentOutput.push(...lines.slice(-10));
    } else if (
      part.type === "thinking" &&
      typeof part.thinking === "string" &&
      part.thinking.trim()
    ) {
      state.accumulatedOutput.push(`[thinking] ${part.thinking.trim()}`);
      const lines = part.thinking.split("\n").filter((line: string) => line.trim());
      state.recentOutput.push(...lines.slice(-5).map((line: string) => `[thinking] ${line}`));
    }
  }

  // Cap recentOutput
  if (state.recentOutput.length > RECENT_OUTPUT_MAX) {
    state.recentOutput.splice(0, state.recentOutput.length - RECENT_OUTPUT_MAX);
  }

  // Extract usage (turnCount tracked via turn_start in stream.ts)
  state.usage = addUsage(state.usage, readUsage(message.usage));
}

/**
 * Handle an agent_end event — extract final output from the last assistant message.
 */
export function handleAgentEnd(state: StreamState, event: AgentEndEvent): void {
  const messages = objectItems<AgentEndEvent["messages"][number]>(event.messages);
  if (messages.length === 0) return;

  // Use only the last assistant message for final output
  const lastAssistant = [...messages].reverse().find((message): message is AssistantMessage =>
    message.role === "assistant");
  if (!lastAssistant) return;

  state.finalOutput = assistantText(lastAssistant);
}
