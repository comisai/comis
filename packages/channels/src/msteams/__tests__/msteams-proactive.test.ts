// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { ConversationReference } from "@comis/core";
import {
  rebuildConversationReference,
  isRevokedProxyError,
} from "../msteams-proactive.js";

const storedRef: ConversationReference = {
  conversationId: "19:convo",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  tenantId: "tenant-1",
  threadId: "thread-9",
  updatedAt: 1_700_000_000_000,
};

describe("rebuildConversationReference", () => {
  it("maps a stored reference to the proactive send target when the serviceUrl is host-safe", () => {
    const result = rebuildConversationReference(storedRef, () => true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        serviceUrl: "https://smba.trafficmanager.net/emea/",
        tenantId: "tenant-1",
        threadId: "thread-9",
      });
    }
  });

  it("errs when the stored serviceUrl fails the host-safety guard (no exfiltration to a poisoned host)", () => {
    const poisoned: ConversationReference = { ...storedRef, serviceUrl: "https://attacker.example/" };
    const result = rebuildConversationReference(poisoned, () => false);
    expect(result.ok).toBe(false);
  });

  it("passes the STORED serviceUrl through the injected guard verbatim (re-validation on every send)", () => {
    const seen: string[] = [];
    rebuildConversationReference(storedRef, (url) => {
      seen.push(url);
      return true;
    });
    expect(seen).toEqual(["https://smba.trafficmanager.net/emea/"]);
  });
});

describe("isRevokedProxyError", () => {
  it("detects a revoked-proxy connector error so the caller routes to the store-backed send", () => {
    expect(
      isRevokedProxyError(
        new Error("The bot cannot use this proxy that has been revoked for the conversation"),
      ),
    ).toBe(true);
  });

  it("detects the revoked-proxy signal in a bare string too", () => {
    expect(isRevokedProxyError("proxy that has been revoked")).toBe(true);
  });

  it("returns false for an unrelated connector error", () => {
    expect(isRevokedProxyError(new Error("connector send returned status 500"))).toBe(false);
  });

  it("returns false for a non-error value", () => {
    expect(isRevokedProxyError(undefined)).toBe(false);
    expect(isRevokedProxyError({ nope: true })).toBe(false);
  });
});
