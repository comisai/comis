// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import type { NormalizedMessage } from "@comis/core";
import {
  createChaosEchoAdapter,
  type ChaosEchoAdapter,
} from "./chaos-echo-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "echo-test",
    channelType: "echo",
    senderId: "user-1",
    text: "Hello from test",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChaosEchoAdapter", () => {
  let adapter: ChaosEchoAdapter;

  beforeEach(() => {
    adapter = createChaosEchoAdapter();
  });

  // -------------------------------------------------------------------------
  // Passthrough behavior
  // -------------------------------------------------------------------------

  describe("passthrough behavior", () => {
    it("delegates sendMessage to inner adapter", async () => {
      const result = await adapter.sendMessage("ch-1", "hello");
      expect(result.ok).toBe(true);
      expect(adapter.inner.getSentMessages()).toHaveLength(1);
      expect(adapter.inner.getSentMessages()[0]!.text).toBe("hello");
    });

    it("delegates start/stop without chaos", async () => {
      adapter.setChaos({ failRate: 1.0 });

      const startResult = await adapter.start();
      expect(startResult.ok).toBe(true);

      const stopResult = await adapter.stop();
      expect(stopResult.ok).toBe(true);
    });

    it("delegates onMessage to inner adapter", async () => {
      const received: NormalizedMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
      });

      const msg = makeMessage({ text: "injected" });
      await adapter.inner.injectMessage(msg);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("injected");
    });

    it("exposes channelId and channelType from inner", () => {
      expect(adapter.channelId).toBe("echo-test");
      expect(adapter.channelType).toBe("echo");
    });
  });

  // -------------------------------------------------------------------------
  // failRate
  // -------------------------------------------------------------------------

  describe("failRate", () => {
    it("returns err when failRate is 1.0", async () => {
      adapter.setChaos({ failRate: 1.0 });
      const result = await adapter.sendMessage("ch-1", "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Chaos");
      }
    });

    it("succeeds when failRate is 0", async () => {
      adapter.setChaos({ failRate: 0 });
      const result = await adapter.sendMessage("ch-1", "hello");
      expect(result.ok).toBe(true);
    });

    it("applies to all intercepted methods", async () => {
      adapter.setChaos({ failRate: 1.0 });

      const editResult = await adapter.editMessage("ch-1", "msg-1", "edited");
      expect(editResult.ok).toBe(false);

      const reactResult = await adapter.reactToMessage("ch-1", "msg-1", "👍");
      expect(reactResult.ok).toBe(false);

      const deleteResult = await adapter.deleteMessage("ch-1", "msg-1");
      expect(deleteResult.ok).toBe(false);

      const fetchResult = await adapter.fetchMessages("ch-1");
      expect(fetchResult.ok).toBe(false);

      const attachResult = await adapter.sendAttachment("ch-1", {
        type: "image",
        url: "https://example.com/img.png",
      });
      expect(attachResult.ok).toBe(false);

      const actionResult = await adapter.platformAction("pin", { id: "1" });
      expect(actionResult.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // failOnNext
  // -------------------------------------------------------------------------

  describe("failOnNext", () => {
    it("fails first N calls then succeeds", async () => {
      adapter.setChaos({ failOnNext: 2 });

      const r1 = await adapter.sendMessage("ch-1", "msg1");
      expect(r1.ok).toBe(false);

      const r2 = await adapter.sendMessage("ch-1", "msg2");
      expect(r2.ok).toBe(false);

      const r3 = await adapter.sendMessage("ch-1", "msg3");
      expect(r3.ok).toBe(true);
    });

    it("decrements across different methods", async () => {
      adapter.setChaos({ failOnNext: 1 });

      const sendResult = await adapter.sendMessage("ch-1", "hello");
      expect(sendResult.ok).toBe(false);

      const editResult = await adapter.editMessage("ch-1", "msg-1", "edited");
      expect(editResult.ok).toBe(true);
    });

    it("failOnNext takes priority over failRate 0", async () => {
      adapter.setChaos({ failOnNext: 1, failRate: 0 });

      const result = await adapter.sendMessage("ch-1", "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("deterministic");
      }
    });
  });

  // -------------------------------------------------------------------------
  // latencyMs
  // -------------------------------------------------------------------------

  describe("latencyMs", () => {
    it("adds delay to intercepted calls", async () => {
      adapter.setChaos({ latencyMs: 50 });

      await adapter.sendMessage("ch-1", "hello");

      const log = adapter.getCallLog();
      expect(log).toHaveLength(1);
      expect(log[0]!.durationMs).toBeGreaterThanOrEqual(45);
    });

    it("does not add delay to start/stop", async () => {
      adapter.setChaos({ latencyMs: 100 });

      const before = Date.now();
      await adapter.start();
      const elapsed = Date.now() - before;

      expect(elapsed).toBeLessThan(50);
    });
  });

  // -------------------------------------------------------------------------
  // rateLimiting
  // -------------------------------------------------------------------------

  describe("rateLimiting", () => {
    it("allows calls up to maxCalls", async () => {
      adapter.setChaos({
        rateLimiting: { maxCalls: 3, windowMs: 1000 },
      });

      const r1 = await adapter.sendMessage("ch-1", "msg1");
      const r2 = await adapter.sendMessage("ch-1", "msg2");
      const r3 = await adapter.sendMessage("ch-1", "msg3");

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
    });

    it("rejects calls exceeding maxCalls", async () => {
      adapter.setChaos({
        rateLimiting: { maxCalls: 2, windowMs: 1000 },
      });

      const r1 = await adapter.sendMessage("ch-1", "msg1");
      const r2 = await adapter.sendMessage("ch-1", "msg2");
      const r3 = await adapter.sendMessage("ch-1", "msg3");

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.error.message).toContain("rate limited");
      }
    });

    it("resets after window expires", async () => {
      adapter.setChaos({
        rateLimiting: { maxCalls: 1, windowMs: 50 },
      });

      const r1 = await adapter.sendMessage("ch-1", "msg1");
      expect(r1.ok).toBe(true);

      // Wait for the sliding window to expire
      await new Promise((r) => globalThis.setTimeout(r, 60));

      const r2 = await adapter.sendMessage("ch-1", "msg2");
      expect(r2.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Call recording
  // -------------------------------------------------------------------------

  describe("call recording", () => {
    it("records successful calls", async () => {
      await adapter.sendMessage("ch-1", "hello");

      const log = adapter.getCallLog();
      expect(log).toHaveLength(1);
      expect(log[0]!.method).toBe("sendMessage");
      expect(log[0]!.result).toBe("success");
      expect(log[0]!.timestamp).toBeGreaterThan(0);
      expect(log[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records failed calls with error", async () => {
      adapter.setChaos({ failRate: 1.0 });
      await adapter.sendMessage("ch-1", "hello");

      const log = adapter.getCallLog();
      expect(log).toHaveLength(1);
      expect(log[0]!.result).toBe("failure");
      expect(log[0]!.error).toContain("Chaos");
    });

    it("records args in call log", async () => {
      await adapter.sendMessage("ch-1", "hello");

      const log = adapter.getCallLog();
      expect(log[0]!.args).toEqual(["ch-1", "hello", undefined]);
    });

    it("clearCallLog empties the log", async () => {
      await adapter.sendMessage("ch-1", "msg1");
      await adapter.sendMessage("ch-1", "msg2");
      expect(adapter.getCallLog()).toHaveLength(2);

      adapter.clearCallLog();
      expect(adapter.getCallLog()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // setChaos and resetChaos
  // -------------------------------------------------------------------------

  describe("setChaos and resetChaos", () => {
    it("setChaos merges config", async () => {
      adapter.setChaos({ failRate: 0.5 });
      adapter.setChaos({ latencyMs: 10 });

      // latencyMs should be active (check via durationMs in call log)
      await adapter.sendMessage("ch-1", "hello");
      const log = adapter.getCallLog();
      expect(log[0]!.durationMs).toBeGreaterThanOrEqual(5);
    });

    it("resetChaos clears all config", async () => {
      adapter.setChaos({ failRate: 1.0, failOnNext: 5, latencyMs: 100 });
      adapter.resetChaos();

      const result = await adapter.sendMessage("ch-1", "hello");
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Custom options
  // -------------------------------------------------------------------------

  describe("custom options", () => {
    it("uses custom channelId", () => {
      const custom = createChaosEchoAdapter({ channelId: "custom-ch" });
      expect(custom.channelId).toBe("custom-ch");
    });

    it("initial chaos config applied", async () => {
      const custom = createChaosEchoAdapter({
        chaos: { failRate: 1.0 },
      });

      const result = await custom.sendMessage("ch-1", "hello");
      expect(result.ok).toBe(false);
    });
  });
});
