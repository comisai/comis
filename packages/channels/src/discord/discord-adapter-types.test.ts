// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 41 TS-HYG-05 — TDD RED tests for the Discord channel narrowing
 * helper `asTextLike` + structural `DiscordTextLikeChannel` interface.
 *
 * These tests express the function contract that Plan 41-05 will later
 * import to eliminate the 18 `as any` casts in `discord-actions.ts`.
 *
 * Anti-pattern reminder (41-RESEARCH §"Anti-Patterns" line 425):
 * `asTextLike` is a typed-cast utility, not a fallible computation; the
 * `null` branch IS the "not text-like" signal. This file therefore does
 * NOT import `Result` from `@comis/shared`.
 *
 * @module
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { asTextLike, type DiscordTextLikeChannel } from "./discord-adapter-types.js";

describe("asTextLike — Discord channel narrowing (TS-HYG-05)", () => {
  it("asTextLike returns null when channel is null", () => {
    expect(asTextLike(null)).toBeNull();
  });

  it("asTextLike returns null when channel lacks an isTextBased method", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = { id: "123", type: 0 } as any;
    expect(asTextLike(channel)).toBeNull();
  });

  it("asTextLike returns null when channel.isTextBased() returns false", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = { id: "123", type: 0, isTextBased: () => false } as any;
    expect(asTextLike(channel)).toBeNull();
  });

  it("asTextLike returns the channel typed as DiscordTextLikeChannel when isTextBased() is true", () => {
    const channel = {
      id: "123",
      type: 0,
      isTextBased: () => true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: {} as any,
      sendTyping: async () => undefined,
      setTopic: async () => undefined,
      setRateLimitPerUser: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: async () => ({}) as any,
      edit: async () => undefined,
      delete: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = asTextLike(channel);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.id).toBe("123");
    expect(typeof result.sendTyping).toBe("function");
  });

  it("asTextLike returns null when isTextBased is present but not a function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = { id: "123", type: 0, isTextBased: "not-a-function" } as any;
    expect(asTextLike(channel)).toBeNull();
  });

  it("DiscordTextLikeChannel interface exports the messages MessageManager property", () => {
    expectTypeOf<DiscordTextLikeChannel>().toHaveProperty("messages");
    expectTypeOf<DiscordTextLikeChannel>().toHaveProperty("setTopic");
    expectTypeOf<DiscordTextLikeChannel>().toHaveProperty("send");
  });
});
