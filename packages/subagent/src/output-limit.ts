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

  const rootKeys = ROOT_OUTPUT_LIMIT_KEYS.filter((key) => key in payload);
  const nestedKeys = Array.isArray(payload.contents)
    ? NESTED_OUTPUT_LIMIT_KEYS.filter((key) => isRecord(payload[key]))
    : [];
  const addResponsesCap = rootKeys.length === 0 &&
    Array.isArray(payload.input) &&
    !isCodexResponsesPayload(payload);
  if (rootKeys.length === 0 && nestedKeys.length === 0 && !addResponsesCap) {
    return { payload, evidence };
  }

  const existing = [
    ...rootKeys.map((key) => payload[key]),
    ...nestedKeys.map((key) => (payload[key] as Record<string, unknown>).maxOutputTokens),
  ];
  const effective = existing.reduce<number>(
    (limit, value) => Math.min(limit, clamped(value, requested)),
    requested,
  );
  const rewritten: Record<string, unknown> = { ...payload };
  for (const key of rootKeys) rewritten[key] = effective;
  if (addResponsesCap) rewritten.max_output_tokens = effective;
  for (const key of nestedKeys) {
    rewritten[key] = {
      ...(payload[key] as Record<string, unknown>),
      maxOutputTokens: effective,
    };
  }

  return {
    payload: rewritten,
    evidence: { requested, effective, enforcement: "applied" },
  };
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
      (value.enforcement !== "applied" && value.enforcement !== "unsupported") ||
      (value.enforcement === "applied" && (
        typeof value.effective !== "number" ||
        !Number.isSafeInteger(value.effective) ||
        value.effective <= 0 ||
        value.effective > value.requested
      )) ||
      (value.enforcement === "unsupported" && value.effective !== undefined)
    ) {
      return undefined;
    }
    return {
      requested: value.requested,
      ...(value.effective !== undefined ? { effective: value.effective } : {}),
      enforcement: value.enforcement,
    };
  } catch {
    return undefined;
  }
}
