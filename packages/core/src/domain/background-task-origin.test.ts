// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { BackgroundTaskOriginSchema } from "./background-task-origin.js";

describe("BackgroundTaskOriginSchema", () => {
  it("Test 1: accepts valid input with all fields", () => {
    const result = BackgroundTaskOriginSchema.parse({
      agentId: "default",
      sessionKey: "default:echo:test:user1",
      channelType: "echo",
      channelId: "test",
      traceId: "abc-123",
      backgroundHopCount: 0,
    });
    expect(result).toEqual({
      agentId: "default",
      sessionKey: "default:echo:test:user1",
      channelType: "echo",
      channelId: "test",
      traceId: "abc-123",
      backgroundHopCount: 0,
    });
  });

  it("Test 2: accepts traceId: null (optional/nullable per D-06)", () => {
    const result = BackgroundTaskOriginSchema.parse({
      agentId: "default",
      sessionKey: "default:echo:test:user1",
      channelType: "echo",
      channelId: "test",
      traceId: null,
      backgroundHopCount: 0,
    });
    expect(result.traceId).toBeNull();
  });

  it("Test 3: backgroundHopCount defaults to 0 when omitted", () => {
    const result = BackgroundTaskOriginSchema.parse({
      agentId: "default",
      sessionKey: "default:echo:test:user1",
      channelType: "echo",
      channelId: "test",
      traceId: null,
    });
    expect(result.backgroundHopCount).toBe(0);
  });

  it("Test 4: accepts backgroundHopCount: 2 (positive integer)", () => {
    const result = BackgroundTaskOriginSchema.parse({
      agentId: "default",
      sessionKey: "default:echo:test:user1",
      channelType: "echo",
      channelId: "test",
      traceId: null,
      backgroundHopCount: 2,
    });
    expect(result.backgroundHopCount).toBe(2);
  });

  it("Test 5: rejects backgroundHopCount: -1 (negative)", () => {
    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "default",
        sessionKey: "default:echo:test:user1",
        channelType: "echo",
        channelId: "test",
        traceId: null,
        backgroundHopCount: -1,
      }),
    ).toThrow();
  });

  it("Test 6: rejects backgroundHopCount: 1.5 (fraction)", () => {
    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "default",
        sessionKey: "default:echo:test:user1",
        channelType: "echo",
        channelId: "test",
        traceId: null,
        backgroundHopCount: 1.5,
      }),
    ).toThrow();
  });

  it("Test 7: rejects missing required fields", () => {
    expect(() =>
      BackgroundTaskOriginSchema.parse({ agentId: "default" }),
    ).toThrow();
  });

  it("Test 8: rejects empty strings for required fields", () => {
    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "",
        sessionKey: "default:echo:test:user1",
        channelType: "echo",
        channelId: "test",
        traceId: null,
      }),
    ).toThrow();

    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "default",
        sessionKey: "",
        channelType: "echo",
        channelId: "test",
        traceId: null,
      }),
    ).toThrow();

    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "default",
        sessionKey: "default:echo:test:user1",
        channelType: "",
        channelId: "test",
        traceId: null,
      }),
    ).toThrow();

    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "default",
        sessionKey: "default:echo:test:user1",
        channelType: "echo",
        channelId: "",
        traceId: null,
      }),
    ).toThrow();
  });

  it("Test 9: rejects unknown fields (z.strictObject)", () => {
    expect(() =>
      BackgroundTaskOriginSchema.parse({
        agentId: "default",
        sessionKey: "default:echo:test:user1",
        channelType: "echo",
        channelId: "test",
        traceId: null,
        unknownField: "should-fail",
      }),
    ).toThrow();
  });
});
