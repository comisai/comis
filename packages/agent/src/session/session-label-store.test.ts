// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { createSessionLabelStore, type SessionLabelStore } from "./session-label-store.js";
import type { SessionStore, SessionData, SessionDetailedEntry, SessionListEntry } from "@comis/memory";
import type { SessionKey } from "@comis/core";
import { formatSessionKey } from "@comis/core";

// ---------------------------------------------------------------------------
// In-memory mock SessionStore
// ---------------------------------------------------------------------------

interface StoredSession {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  key: SessionKey;
}

function createMockSessionStore(): SessionStore & { _sessions: Map<string, StoredSession> } {
  const sessions = new Map<string, StoredSession>();

  return {
    _sessions: sessions,

    save(key: SessionKey, messages: unknown[], metadata?: Record<string, unknown>): void {
      const formatted = formatSessionKey(key);
      const existing = sessions.get(formatted);
      const now = Date.now();
      sessions.set(formatted, {
        messages,
        metadata: metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        key,
      });
    },

    load(key: SessionKey): SessionData | undefined {
      const formatted = formatSessionKey(key);
      const stored = sessions.get(formatted);
      if (!stored) return undefined;
      return {
        messages: stored.messages,
        metadata: { ...stored.metadata },
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
    },

    list(tenantId?: string): SessionListEntry[] {
      const entries: SessionListEntry[] = [];
      for (const [sessionKey, stored] of sessions) {
        if (tenantId !== undefined && stored.key.tenantId !== tenantId) continue;
        entries.push({ sessionKey, updatedAt: stored.updatedAt });
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    delete(key: SessionKey): boolean {
      const formatted = formatSessionKey(key);
      return sessions.delete(formatted);
    },

    deleteStale(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      let count = 0;
      for (const [key, stored] of sessions) {
        if (stored.updatedAt < cutoff) {
          sessions.delete(key);
          count++;
        }
      }
      return count;
    },

    loadByFormattedKey(sessionKey: string): SessionData | undefined {
      const stored = sessions.get(sessionKey);
      if (!stored) return undefined;
      return {
        messages: stored.messages,
        metadata: { ...stored.metadata },
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
    },

    listDetailed(tenantId?: string): SessionDetailedEntry[] {
      const entries: SessionDetailedEntry[] = [];
      for (const [sessionKey, stored] of sessions) {
        if (tenantId !== undefined && stored.key.tenantId !== tenantId) continue;
        entries.push({
          sessionKey,
          tenantId: stored.key.tenantId,
          userId: stored.key.userId,
          channelId: stored.key.channelId,
          metadata: { ...stored.metadata },
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        });
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(tenant: string, user: string, channel: string): SessionKey {
  return { tenantId: tenant, userId: user, channelId: channel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionLabelStore", () => {
  let mockStore: ReturnType<typeof createMockSessionStore>;
  let labelStore: SessionLabelStore;

  beforeEach(() => {
    mockStore = createMockSessionStore();
    labelStore = createSessionLabelStore(mockStore);
  });

  // -----------------------------------------------------------------------
  // getLabel
  // -----------------------------------------------------------------------

  it("returns label string when session has a label", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }], { label: "Project Planning" });

    const label = labelStore.getLabel(key);
    expect(label).toBe("Project Planning");
  });

  it("returns undefined when session exists but has no label", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }], { someOtherField: "value" });

    const label = labelStore.getLabel(key);
    expect(label).toBeUndefined();
  });

  it("returns undefined when session does not exist", () => {
    const key = makeKey("t1", "u1", "nonexistent");

    const label = labelStore.getLabel(key);
    expect(label).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // setLabel
  // -----------------------------------------------------------------------

  it("stores label in metadata.label", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }]);

    labelStore.setLabel(key, "Daily Standup");

    const data = mockStore.load(key);
    expect(data?.metadata.label).toBe("Daily Standup");
  });

  it("is a no-op when session does not exist", () => {
    const key = makeKey("t1", "u1", "nonexistent");

    // Should not throw
    labelStore.setLabel(key, "Some Label");

    // Session should still not exist
    const data = mockStore.load(key);
    expect(data).toBeUndefined();
  });

  it("preserves existing metadata fields when setting label", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }], {
      customField: "keepMe",
      anotherField: 42,
    });

    labelStore.setLabel(key, "My Label");

    const data = mockStore.load(key);
    expect(data?.metadata.label).toBe("My Label");
    expect(data?.metadata.customField).toBe("keepMe");
    expect(data?.metadata.anotherField).toBe(42);
  });

  it("overwrites existing label", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }], { label: "Old Label" });

    labelStore.setLabel(key, "New Label");

    const data = mockStore.load(key);
    expect(data?.metadata.label).toBe("New Label");
  });

  // -----------------------------------------------------------------------
  // removeLabel
  // -----------------------------------------------------------------------

  it("removes label while preserving other metadata", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }], {
      label: "To Remove",
      keepMe: "still here",
    });

    labelStore.removeLabel(key);

    const data = mockStore.load(key);
    expect(data?.metadata.label).toBeUndefined();
    expect(data?.metadata.keepMe).toBe("still here");
  });

  it("is a no-op when session does not exist", () => {
    const key = makeKey("t1", "u1", "nonexistent");

    // Should not throw
    labelStore.removeLabel(key);
  });

  it("is a no-op when session has no label", () => {
    const key = makeKey("t1", "u1", "c1");
    mockStore.save(key, [{ role: "user", content: "hi" }], { other: "data" });

    labelStore.removeLabel(key);

    const data = mockStore.load(key);
    expect(data?.metadata.other).toBe("data");
    expect(data?.metadata.label).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // listLabeled
  // -----------------------------------------------------------------------

  it("returns only sessions with labels", () => {
    const key1 = makeKey("t1", "u1", "c1");
    const key2 = makeKey("t1", "u2", "c2");
    const key3 = makeKey("t1", "u3", "c3");

    mockStore.save(key1, [], { label: "Planning" });
    mockStore.save(key2, [], {}); // no label
    mockStore.save(key3, [], { label: "Debug Session" });

    const labeled = labelStore.listLabeled();
    expect(labeled).toHaveLength(2);

    const labels = labeled.map((e) => e.label);
    expect(labels).toContain("Planning");
    expect(labels).toContain("Debug Session");
  });

  it("filters by tenantId when provided", () => {
    const key1 = makeKey("tenant-a", "u1", "c1");
    const key2 = makeKey("tenant-b", "u2", "c2");

    mockStore.save(key1, [], { label: "Tenant A Session" });
    mockStore.save(key2, [], { label: "Tenant B Session" });

    const labeled = labelStore.listLabeled("tenant-a");
    expect(labeled).toHaveLength(1);
    expect(labeled[0].label).toBe("Tenant A Session");
  });

  it("returns empty array when no sessions have labels", () => {
    const key1 = makeKey("t1", "u1", "c1");
    mockStore.save(key1, [], {});

    const labeled = labelStore.listLabeled();
    expect(labeled).toHaveLength(0);
  });

  it("returns sessionKey in each entry", () => {
    const key1 = makeKey("t1", "u1", "c1");
    mockStore.save(key1, [], { label: "My Session" });

    const labeled = labelStore.listLabeled();
    expect(labeled).toHaveLength(1);
    expect(labeled[0].sessionKey).toBe(formatSessionKey(key1));
    expect(labeled[0].label).toBe("My Session");
  });
});
