import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("managed 2.11.1 migration contracts", () => {
  it("tests against the approved Pi 1.3.0 host", () => {
    // SDK 1.3.0 exports imports only and keeps package.json private.
    const path = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    expect(manifest.version).toBe("1.3.0");
  });

  it.each([
    ["./limits.ts", "BudgetTracker"],
    ["./output-limit.ts", "applyProviderOutputLimit"],
    ["./execution-profile.ts", "resolveChildExecution"],
    ["./dispatch-policy.ts", "validateDispatchPolicy"],
    ["./config.ts", "loadSubagentConfig"],
  ])("retains %s contract entrypoint", async (path, symbol) => {
    const module = await import(path).catch((error: unknown) => ({ importError: String(error) }));
    expect(module).toHaveProperty(symbol, expect.any(Function));
  });
});
