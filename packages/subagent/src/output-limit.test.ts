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

    expect(result.evidence).toEqual({ requested, enforcement: "applied" });
    expect(result.payload).toEqual({ ...payload, [key]: requested });
    expect(result.payload).not.toBe(payload);
  });

  it("never raises an existing lower provider cap", () => {
    expect(applyProviderOutputLimit({ max_tokens: 8_192 }, requested).payload).toEqual({
      max_tokens: 8_192,
    });
  });

  it("adds the cap to OpenAI Responses payloads", () => {
    expect(applyProviderOutputLimit({ model: "gpt", input: [], stream: true }, requested)).toEqual({
      payload: { model: "gpt", input: [], stream: true, max_output_tokens: requested },
      evidence: { requested, enforcement: "applied" },
    });
  });

  it("adds the cap to current and legacy Google payload config", () => {
    expect(applyProviderOutputLimit({ model: "gemini", contents: [], config: {} }, requested)).toEqual({
      payload: { model: "gemini", contents: [], config: { maxOutputTokens: requested } },
      evidence: { requested, enforcement: "applied" },
    });
    expect(applyProviderOutputLimit({ model: "gemini", contents: [], generationConfig: {} }, requested)).toEqual({
      payload: { model: "gemini", contents: [], generationConfig: { maxOutputTokens: requested } },
      evidence: { requested, enforcement: "applied" },
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
    const evidence = { requested, enforcement: "unsupported" as const };
    expect(decodeOutputLimitEvidence(encodeOutputLimitEvidence(evidence))).toEqual(evidence);
  });

  it("rejects malformed evidence without exposing payload data", () => {
    expect(decodeOutputLimitEvidence("ordinary stderr")).toBeUndefined();
    expect(decodeOutputLimitEvidence("PI_ARCHIMEDES_OUTPUT_LIMIT not-json")).toBeUndefined();
    expect(decodeOutputLimitEvidence('PI_ARCHIMEDES_OUTPUT_LIMIT {"requested":0,"enforcement":"applied"}')).toBeUndefined();
  });
});
