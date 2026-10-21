import { describe, expect, it, vi } from "vitest";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Events } from "@pi-archimedes/core/events";
import { registerIpcRelay } from "./ipc-relay.js";

const { pick } = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock("./picker.js", () => ({ askSingleQuestionWithInlineNote: pick }));
vi.mock("@pi-archimedes/core/bridge", () => ({ getBridge: () => ({ active: false }) }));

describe("managed ask response shape", () => {
  it.each([undefined, "", "Typed answer"])("preserves defined custom input %s without inventing missing keys", async (customInput) => {
    const events = createEventBus();
    const unsubscribes: Array<() => void> = [];
    pick.mockResolvedValue({ selectedOptions: ["Yes"], ...(customInput !== undefined && { customInput }) });
    registerIpcRelay({ events } as unknown as ExtensionAPI, () => ({ ui: {} }) as ExtensionContext, unsubscribes);
    const response = new Promise<any>((resolve) => {
      unsubscribes.push(events.on(Events.ASK_RESPONSE, resolve));
    });
    try {
      events.emit(Events.ASK_REQUEST, {
        source: "subagent:peer", requestId: "request",
        questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
      });
      const result = await response;
      expect(result.requestId).toBe("request");
      expect(result.cancelled).toBe(false);
      expect(result.results[0]).toEqual({ id: "q", selectedOptions: ["Yes"], ...(customInput !== undefined && { customInput }) });
      expect(Object.hasOwn(result.results[0], "customInput")).toBe(customInput !== undefined);
    } finally {
      unsubscribes.forEach((off) => off());
    }
  });
});
