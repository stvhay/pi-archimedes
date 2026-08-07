import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { StreamState } from "./types.js";
import { addUsage, isUsage, readUsage } from "./usage.js";

export type MessageUpdateEvent = {
  type: "message_update";
  message?: unknown;
  assistantMessageEvent?: unknown;
};
export type JsonEvent = Exclude<ExtensionEvent, { type: "message_update" }> | MessageUpdateEvent;
type ToolStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type ToolEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;
type MessageStartEvent = Extract<ExtensionEvent, { type: "message_start" }>;
type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;
type AgentEndEvent = Extract<ExtensionEvent, { type: "agent_end" }>;
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

// Truncation limits for previews
const ARGS_PREVIEW_MAX = 120;
const TOOL_CALLS_MAX = 50;
const RECENT_OUTPUT_MAX = 50;
const STREAMING_PARTS_MAX = 50;
const STREAMING_OUTPUT_MAX_CHARS = 12_000;

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

type AssistantContentPart = AssistantMessage["content"][number];

function isAssistantContentPart(value: unknown): value is AssistantContentPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type === "thinking") return typeof part.thinking === "string";
  return part.type === "toolCall" &&
    typeof part.id === "string" &&
    typeof part.name === "string" &&
    Boolean(part.arguments) &&
    typeof part.arguments === "object" &&
    !Array.isArray(part.arguments);
}

function assistantContent(message: AssistantMessage): AssistantMessage["content"] {
  return Array.isArray(message.content) ? message.content.filter(isAssistantContentPart) : [];
}

function hasAssistantStreamData(message: AssistantMessage): boolean {
  return Array.isArray(message.content) &&
    message.content.every(isAssistantContentPart) &&
    isUsage(message.usage);
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

function clearStreamingMessage(state: StreamState): void {
  state.streamingOutput = undefined;
  state.streamingParts.clear();
}

function renderStreamingParts(state: StreamState): string | undefined {
  const parts = [...state.streamingParts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, part]) => part)
    .filter((part) => part.content.trim())
    .map((part) => part.type === "thinking" ? `[thinking] ${part.content.trim()}` : part.content);
  return parts.length > 0 ? parts.join("\n\n").slice(0, STREAMING_OUTPUT_MAX_CHARS) : undefined;
}

function updateStreamingPart(
  state: StreamState,
  index: number,
  type: "text" | "thinking",
  content: string,
  replace: boolean,
): boolean {
  const existing = state.streamingParts.get(index);
  if (!existing && state.streamingParts.size >= STREAMING_PARTS_MAX) return false;
  const otherChars = [...state.streamingParts.entries()].reduce(
    (total, [partIndex, part]) => total + (partIndex === index ? 0 : part.content.length),
    0,
  );
  const previous = existing?.type === type ? existing.content : "";
  const next = (replace ? content : `${previous}${content}`)
    .slice(0, Math.max(0, STREAMING_OUTPUT_MAX_CHARS - otherChars));
  if (existing?.type === type && existing.content === next) return false;
  state.streamingParts.set(index, { type, content: next });
  state.streamingOutput = renderStreamingParts(state);
  return true;
}

/** Reset replaceable assistant state when a new assistant message starts. */
export function handleMessageStart(state: StreamState, event: MessageStartEvent): void {
  if (event.message?.role !== "assistant") return;
  clearStreamingMessage(state);
  if (!state.provider && event.message.provider) state.provider = event.message.provider;
  if (!state.model && event.message.model) state.model = event.message.model;
}

/** Handle the latest in-flight assistant message as replaceable partial state. */
export function handleMessageUpdate(state: StreamState, event: MessageUpdateEvent): boolean {
  const message = event.message;
  if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
    const assistant = message as AssistantMessage;
    if (!hasAssistantStreamData(assistant)) return false;
    if (!state.provider && assistant.provider) state.provider = assistant.provider;
    if (!state.model && assistant.model) state.model = assistant.model;
    state.streamingParts.clear();
    state.streamingOutput = assistantText(assistant)?.slice(0, STREAMING_OUTPUT_MAX_CHARS);
    state.partialUsage = readUsage(assistant.usage);
    return true;
  }

  const update = event.assistantMessageEvent;
  if (!update || typeof update !== "object" || Array.isArray(update)) return false;
  const delta = update as Record<string, unknown>;
  const index = delta.contentIndex;
  if (!Number.isSafeInteger(index) || (index as number) < 0) return false;

  const eventType = delta.type;
  const type = typeof eventType === "string" && eventType.startsWith("thinking_") ? "thinking"
    : typeof eventType === "string" && eventType.startsWith("text_") ? "text"
    : undefined;
  if (!type || typeof eventType !== "string") return false;

  if (eventType.endsWith("_start")) {
    return updateStreamingPart(state, index as number, type, "", true);
  }
  if (eventType.endsWith("_delta") && typeof delta.delta === "string") {
    return updateStreamingPart(state, index as number, type, delta.delta, false);
  }
  if (eventType.endsWith("_end") && typeof delta.content === "string") {
    return updateStreamingPart(state, index as number, type, delta.content, true);
  }
  return false;
}

/**
 * Handle a message_end event — extract usage and text from assistant messages.
 */
export function handleMessageEnd(state: StreamState, event: MessageEndEvent): void {
  const message = event.message;
  if (
    !message ||
    typeof message !== "object" ||
    message.role !== "assistant" ||
    !hasAssistantStreamData(message)
  ) return;

  // Finalized data replaces the latest partial message.
  clearStreamingMessage(state);
  clearPartialUsage(state);

  // Capture provider/model identity
  if (!state.provider && message.provider) state.provider = message.provider;
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
  state.turnUsage = readUsage(message.usage);
  state.usage = addUsage(state.usage, state.turnUsage);
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
