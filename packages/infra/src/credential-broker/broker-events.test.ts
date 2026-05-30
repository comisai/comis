// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for broker-events.ts — typed emit helpers.
 * @module
 */
import { describe, expect, it, vi } from "vitest";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import {
  emitSessionOpened,
  emitSessionClosed,
  emitRequest,
  emitInjected,
  emitDenied,
  emitCredentialUnavailable,
  emitEgressBlocked,
} from "./broker-events.js";

const NOW = 1_700_000_000_000;

describe("emitSessionOpened", () => {
  it("emits broker:session_opened with all required fields", () => {
    const eventBus = createMockEventBus();
    emitSessionOpened(eventBus, {
      sessionId: "s1",
      agentId: "a1",
      host: "api.anthropic.com",
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:session_opened");
    expect(payload).toMatchObject({
      sessionId: "s1",
      agentId: "a1",
      host: "api.anthropic.com",
      timestamp: NOW,
    });
  });

  it("emits broker:session_opened with optional presetId", () => {
    const eventBus = createMockEventBus();
    emitSessionOpened(eventBus, {
      sessionId: "s2",
      agentId: "a2",
      host: "api.openai.com",
      presetId: "preset-xyz",
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const [, payload] = calls[0]!;
    expect(payload).toMatchObject({ presetId: "preset-xyz" });
  });
});

describe("emitSessionClosed", () => {
  it("emits broker:session_closed with all required fields", () => {
    const eventBus = createMockEventBus();
    emitSessionClosed(eventBus, {
      sessionId: "s1",
      agentId: "a1",
      durationMs: 5000,
      reason: "teardown",
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:session_closed");
    expect(payload).toMatchObject({
      sessionId: "s1",
      agentId: "a1",
      durationMs: 5000,
      reason: "teardown",
      timestamp: NOW,
    });
  });

  it("accepts all reason values", () => {
    for (const reason of ["teardown", "error"] as const) {
      const eventBus = createMockEventBus();
      emitSessionClosed(eventBus, {
        sessionId: "s3",
        agentId: "a3",
        durationMs: 100,
        reason,
        timestamp: NOW,
      });
      const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const [, payload] = calls[0]!;
      expect(payload.reason).toBe(reason);
    }
  });
});

describe("emitRequest", () => {
  it("emits broker:request with all required fields", () => {
    const eventBus = createMockEventBus();
    emitRequest(eventBus, {
      sessionId: "s1",
      host: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:request");
    expect(payload).toMatchObject({
      sessionId: "s1",
      host: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      timestamp: NOW,
    });
  });
});

describe("emitInjected", () => {
  it("emits broker:injected with all required fields", () => {
    const eventBus = createMockEventBus();
    emitInjected(eventBus, {
      sessionId: "s1",
      host: "api.anthropic.com",
      ruleKind: "setHeader",
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:injected");
    expect(payload).toMatchObject({
      sessionId: "s1",
      host: "api.anthropic.com",
      ruleKind: "setHeader",
      timestamp: NOW,
    });
  });
});

describe("emitDenied", () => {
  it("emits broker:denied with all required fields", () => {
    const eventBus = createMockEventBus();
    emitDenied(eventBus, {
      sessionId: "s1",
      host: "api.anthropic.com",
      reason: "no_binding",
      statusCode: 403,
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:denied");
    expect(payload).toMatchObject({
      sessionId: "s1",
      host: "api.anthropic.com",
      reason: "no_binding",
      statusCode: 403,
      timestamp: NOW,
    });
  });

  it("accepts all reason values", () => {
    const reasons = [
      "no_binding",
      "bad_token",
      "path_policy",
      "malformed_request",
      "body_too_large",
      "ws_upgrade_not_supported",
    ] as const;
    for (const reason of reasons) {
      const eventBus = createMockEventBus();
      emitDenied(eventBus, {
        sessionId: "s4",
        host: "host.example.com",
        reason,
        statusCode: 403,
        timestamp: NOW,
      });
      const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const [, payload] = calls[0]!;
      expect(payload.reason).toBe(reason);
    }
  });
});

describe("emitCredentialUnavailable", () => {
  it("emits broker:credential_unavailable with all required fields", () => {
    const eventBus = createMockEventBus();
    emitCredentialUnavailable(eventBus, {
      sessionId: "s1",
      secretRef: "ANTHROPIC_API_KEY",
      agentId: "a1",
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:credential_unavailable");
    expect(payload).toMatchObject({
      sessionId: "s1",
      secretRef: "ANTHROPIC_API_KEY",
      agentId: "a1",
      timestamp: NOW,
    });
  });
});

describe("emitEgressBlocked", () => {
  const PLAINTEXT_HOST = "evil-host.example.com";

  it("emits broker:egress_blocked with a 64-char hex hash", () => {
    const eventBus = createMockEventBus();
    emitEgressBlocked(eventBus, {
      sessionId: "s1",
      host: PLAINTEXT_HOST,
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [eventName, payload] = calls[0]!;
    expect(eventName).toBe("broker:egress_blocked");
    expect(payload.targetHostHash).toHaveLength(64);
    expect(payload.targetHostHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never emits the plaintext host in the payload", () => {
    const eventBus = createMockEventBus();
    emitEgressBlocked(eventBus, {
      sessionId: "s1",
      host: PLAINTEXT_HOST,
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const [, payload] = calls[0]!;
    // The hash must NOT equal the plaintext host
    expect(payload.targetHostHash).not.toBe(PLAINTEXT_HOST);
    // The serialized payload must NOT contain the plaintext host string
    expect(JSON.stringify(payload)).not.toContain(PLAINTEXT_HOST);
  });

  it("emitted payload has no 'host' field (only targetHostHash)", () => {
    const eventBus = createMockEventBus();
    emitEgressBlocked(eventBus, {
      sessionId: "s1",
      host: PLAINTEXT_HOST,
      timestamp: NOW,
    });
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const [, payload] = calls[0]!;
    expect(payload).not.toHaveProperty("host");
    expect(payload).toMatchObject({
      sessionId: "s1",
      timestamp: NOW,
    });
  });

  it("produces consistent deterministic hashes for the same host", () => {
    const eventBus1 = createMockEventBus();
    const eventBus2 = createMockEventBus();
    emitEgressBlocked(eventBus1, { sessionId: "s1", host: PLAINTEXT_HOST, timestamp: NOW });
    emitEgressBlocked(eventBus2, { sessionId: "s2", host: PLAINTEXT_HOST, timestamp: NOW });
    const hash1 = (eventBus1.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1].targetHostHash;
    const hash2 = (eventBus2.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1].targetHostHash;
    expect(hash1).toBe(hash2);
  });
});
