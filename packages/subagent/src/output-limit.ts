import type { OutputLimitEvidence } from "./types.js";

const ROOT_OUTPUT_LIMIT_KEYS = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
  "maxOutputTokens",
] as const;
const NESTED_OUTPUT_LIMIT_KEYS = ["config", "generationConfig"] as const;
const OUTPUT_LIMIT_PREFIX = "PI_ARCHIMEDES_OUTPUT_LIMIT ";

export function applyProviderOutputLimit(
  payload: unknown,
  requested: number,
): { payload: unknown; evidence: OutputLimitEvidence } {
  const evidence: OutputLimitEvidence = { requested, enforcement: "unsupported" };
  if (!isRecord(payload)) return { payload, evidence };

  let rewritten: Record<string, unknown> | undefined;
  const output = () => rewritten ??= { ...payload };

  for (const key of ROOT_OUTPUT_LIMIT_KEYS) {
    if (!(key in payload)) continue;
    output()[key] = clamped(payload[key], requested);
    evidence.enforcement = "applied";
  }

  if (
    evidence.enforcement === "unsupported" &&
    Array.isArray(payload.input) &&
    !isCodexResponsesPayload(payload)
  ) {
    output().max_output_tokens = requested;
    evidence.enforcement = "applied";
  }

  if (Array.isArray(payload.contents)) {
    for (const key of NESTED_OUTPUT_LIMIT_KEYS) {
      const nested = payload[key];
      if (!isRecord(nested)) continue;
      output()[key] = {
        ...nested,
        maxOutputTokens: clamped(nested.maxOutputTokens, requested),
      };
      evidence.enforcement = "applied";
    }
  }

  return { payload: rewritten ?? payload, evidence };
}

function isCodexResponsesPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.instructions === "string" &&
    isRecord(payload.text) &&
    Array.isArray(payload.include) &&
    payload.include.includes("reasoning.encrypted_content");
}

function clamped(value: unknown, requested: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, requested)
    : requested;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function encodeOutputLimitEvidence(evidence: OutputLimitEvidence): string {
  return OUTPUT_LIMIT_PREFIX + JSON.stringify(evidence);
}

export function decodeOutputLimitEvidence(line: string): OutputLimitEvidence | undefined {
  if (!line.startsWith(OUTPUT_LIMIT_PREFIX)) return undefined;
  try {
    const value = JSON.parse(line.slice(OUTPUT_LIMIT_PREFIX.length)) as Partial<OutputLimitEvidence>;
    if (
      typeof value.requested !== "number" ||
      !Number.isSafeInteger(value.requested) ||
      value.requested <= 0 ||
      (value.enforcement !== "applied" && value.enforcement !== "unsupported")
    ) {
      return undefined;
    }
    return { requested: value.requested, enforcement: value.enforcement };
  } catch {
    return undefined;
  }
}
