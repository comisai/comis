// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for message-send-limiter: per-execution rate limiter
 * preventing message.send/reply spam during agentic execution.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createMessageSendLimiter } from "./message-send-limiter.js";

describe("createMessageSendLimiter", () => {
  it("allows non-message tools", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 1 });
    const result = limiter.check("exec", { command: "ls" });
    expect(result).toBeUndefined();
  });

  it("allows message actions other than send/reply (react, edit, delete, fetch, attach)", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 1 });
    for (const action of ["react", "edit", "delete", "fetch", "attach"]) {
      const result = limiter.check("message", { action });
      expect(result).toBeUndefined();
    }
  });

  it("allows sends up to limit", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 3 });
    for (let i = 0; i < 3; i++) {
      const result = limiter.check("message", { action: "send", text: `msg ${i}` });
      expect(result).toBeUndefined();
    }
  });

  it("blocks send at max+1 with descriptive reason", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 2 });
    // Use up the limit
    limiter.check("message", { action: "send", text: "first" });
    limiter.check("message", { action: "send", text: "second" });
    // This should be blocked
    const result = limiter.check("message", { action: "send", text: "third" });
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("2");
    expect(typeof result!.reason).toBe("string");
  });

  it("blocks reply at max+1 (same counter as send)", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 2 });
    limiter.check("message", { action: "send", text: "first" });
    limiter.check("message", { action: "reply", text: "second" });
    // Third send/reply should be blocked
    const result = limiter.check("message", { action: "reply", text: "third" });
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("reset() clears counter, sends work again", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 1 });
    limiter.check("message", { action: "send", text: "first" });
    // Should be blocked
    expect(limiter.check("message", { action: "send", text: "second" })).toBeDefined();
    // Reset
    limiter.reset();
    // Should work again
    expect(limiter.check("message", { action: "send", text: "third" })).toBeUndefined();
  });

  it("max=0 means unlimited (100 sends all allowed)", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 0 });
    for (let i = 0; i < 100; i++) {
      const result = limiter.check("message", { action: "send", text: `msg ${i}` });
      expect(result).toBeUndefined();
    }
  });

  it("count getter tracks increments", () => {
    const limiter = createMessageSendLimiter({ maxSendsPerExecution: 5 });
    expect(limiter.count).toBe(0);
    limiter.check("message", { action: "send", text: "one" });
    expect(limiter.count).toBe(1);
    limiter.check("message", { action: "reply", text: "two" });
    expect(limiter.count).toBe(2);
    // Non-send actions don't increment
    limiter.check("message", { action: "react", emoji: "thumbsup" });
    expect(limiter.count).toBe(2);
    // Non-message tools don't increment
    limiter.check("exec", { command: "ls" });
    expect(limiter.count).toBe(2);
  });
});
