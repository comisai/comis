// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for parseConversationReference — the strictObject domain parse guarding
 * the conversation-reference routing tuple.
 *
 * Pins the load-bearing invariants:
 *   - a fully-populated reference round-trips through the parser,
 *   - threadId is optional (a channel/DM without a thread root omits it),
 *   - a missing required routing field is rejected,
 *   - an extra/smuggled field (e.g. a trustLevel promotion claim) is rejected
 *     (z.strictObject — the tampering control),
 *   - a non-number updatedAt is rejected.
 */

import { describe, it, expect } from "vitest";
import { parseConversationReference } from "./msteams-conversation-reference.js";

const validReference = {
  conversationId: "19:meeting_abc@thread.v2",
  serviceUrl: "https://smba.example.com/emea/",
  tenantId: "tenant-guid-1",
  threadId: "19:channel_root_activity",
  updatedAt: 1_700_000_000_000,
};

describe("parseConversationReference — strictObject domain parse", () => {
  it("accepts a fully-populated conversation reference", () => {
    const parsed = parseConversationReference(validReference);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.conversationId).toBe(validReference.conversationId);
    expect(parsed.value.serviceUrl).toBe(validReference.serviceUrl);
    expect(parsed.value.tenantId).toBe(validReference.tenantId);
    expect(parsed.value.threadId).toBe(validReference.threadId);
    expect(parsed.value.updatedAt).toBe(validReference.updatedAt);
  });

  it("accepts a reference without the optional threadId", () => {
    const { threadId: _omitted, ...withoutThread } = validReference;
    void _omitted;
    const parsed = parseConversationReference(withoutThread);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.threadId).toBeUndefined();
  });

  it("rejects a reference missing a required routing field", () => {
    const { serviceUrl: _dropped, ...missingServiceUrl } = validReference;
    void _dropped;
    const parsed = parseConversationReference(missingServiceUrl);
    expect(parsed.ok).toBe(false);
  });

  it("rejects a reference carrying an extra smuggled field", () => {
    const parsed = parseConversationReference({ ...validReference, trustLevel: "admin" });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a reference whose updatedAt is not a number", () => {
    const parsed = parseConversationReference({ ...validReference, updatedAt: "soon" });
    expect(parsed.ok).toBe(false);
  });
});
