import { describe, expect, it } from "vitest";
import {
  applyProviderOutputLimit,
  decodeOutputLimitEvidence,
  encodeOutputLimitEvidence,
} from "./output-limit.js";

const requested = 16_384;

describe("applyProviderOutputLimit", () => {
  it.each([
    "max_output_tokens",
    "max_completion_tokens",
    "max_tokens",
    "maxOutputTokens",
  ])("clamps root provider field %s without changing siblings", (key) => {
    const payload = { model: "test", [key]: 32_768, messages: [] };
    const result = applyProviderOutputLimit(payload, requested);

    expect(result.evidence).toEqual({ requested, effective: requested, enforcement: "applied" });
    expect(result.payload).toEqual({ ...payload, [key]: requested });
    expect(result.payload).not.toBe(payload);
  });

  it("reports an existing lower provider cap as the effective ceiling", () => {
    expect(applyProviderOutputLimit({ max_tokens: 8_192 }, requested)).toEqual({
      payload: { max_tokens: 8_192 },
      evidence: { requested, effective: 8_192, enforcement: "applied" },
    });
  });

  it("uses the strictest ceiling when a payload exposes multiple cap fields", () => {
    expect(applyProviderOutputLimit({ max_tokens: 8_192, max_completion_tokens: 32_768 }, requested)).toEqual({
      payload: { max_tokens: 8_192, max_completion_tokens: 8_192 },
      evidence: { requested, effective: 8_192, enforcement: "applied" },
    });
  });

  it("adds the cap to OpenAI Responses payloads", () => {
    expect(applyProviderOutputLimit({ model: "gpt", input: [], stream: true }, requested)).toEqual({
      payload: { model: "gpt", input: [], stream: true, max_output_tokens: requested },
      evidence: { requested, effective: requested, enforcement: "applied" },
    });
  });

  it("leaves Codex Responses payloads unsupported", () => {
    const payload = {
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      instructions: "Reply once.",
      input: [],
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session",
      tool_choice: "auto",
      parallel_tool_calls: true,
    };

    const result = applyProviderOutputLimit(payload, requested);
    expect(result.payload).toBe(payload);
    expect(result.evidence).toEqual({ requested, enforcement: "unsupported" });
    expect(result.payload).not.toHaveProperty("max_output_tokens");
  });

  it("adds the cap to current and legacy Google payload config", () => {
    expect(applyProviderOutputLimit({ model: "gemini", contents: [], config: {} }, requested)).toEqual({
      payload: { model: "gemini", contents: [], config: { maxOutputTokens: requested } },
      evidence: { requested, effective: requested, enforcement: "applied" },
    });
    expect(applyProviderOutputLimit({ model: "gemini", contents: [], generationConfig: {} }, requested)).toEqual({
      payload: { model: "gemini", contents: [], generationConfig: { maxOutputTokens: requested } },
      evidence: { requested, effective: requested, enforcement: "applied" },
    });
  });

  it.each([undefined, null, "payload", [], { model: "custom", prompt: "hi" }, { contents: [], config: "bad" }])(
    "leaves unsupported payload unchanged: %j",
    (payload) => {
      const result = applyProviderOutputLimit(payload, requested);
      expect(result.payload).toBe(payload);
      expect(result.evidence).toEqual({ requested, enforcement: "unsupported" });
    },
  );
});

describe("output limit evidence marker", () => {
  it("round-trips only bounded enforcement evidence", () => {
    const applied = { requested, effective: 8_192, enforcement: "applied" as const };
    const unsupported = { requested, enforcement: "unsupported" as const };
    expect(decodeOutputLimitEvidence(encodeOutputLimitEvidence(applied))).toEqual(applied);
    expect(decodeOutputLimitEvidence(encodeOutputLimitEvidence(unsupported))).toEqual(unsupported);
  });

  it("rejects malformed evidence without exposing payload data", () => {
    expect(decodeOutputLimitEvidence("ordinary stderr")).toBeUndefined();
    expect(decodeOutputLimitEvidence("PI_ARCHIMEDES_OUTPUT_LIMIT not-json")).toBeUndefined();
    expect(decodeOutputLimitEvidence('PI_ARCHIMEDES_OUTPUT_LIMIT {"requested":0,"enforcement":"applied"}')).toBeUndefined();
    expect(decodeOutputLimitEvidence('PI_ARCHIMEDES_OUTPUT_LIMIT {"requested":8192,"effective":16384,"enforcement":"applied"}')).toBeUndefined();
  });
});
