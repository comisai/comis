// SPDX-License-Identifier: Apache-2.0
/**
 * Identity persistence across messages.
 *
 * Validates that agent identity loaded from AGENTS.md is consistent across
 * multiple assembleSystemPrompt calls and that session messages accumulate
 * correctly across multiple loadOrCreate/save cycles.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadIdentityFiles,
  assembleSystemPrompt,
  type IdentityFiles,
} from "./identity-loader.js";
import { createSessionLifecycle } from "../session/session-lifecycle.js";
import type { SessionStore, SessionData } from "@comis/memory";
import type { SessionKey } from "@comis/core";

// ---------------------------------------------------------------------------
// In-memory fake SessionStore (copied from session-lifecycle.test.ts pattern)
// ---------------------------------------------------------------------------

interface StoredSession {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function createFakeSessionStore(): SessionStore & {
  _sessions: Map<string, StoredSession>;
} {
  const sessions = new Map<string, StoredSession>();

  function keyStr(key: SessionKey): string {
    return `${key.tenantId}:${key.userId}:${key.channelId}`;
  }

  return {
    _sessions: sessions,

    save(key, messages, metadata) {
      const k = keyStr(key);
      const existing = sessions.get(k);
      const now = Date.now();
      sessions.set(k, {
        messages,
        metadata: metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    load(key): SessionData | undefined {
      const k = keyStr(key);
      const s = sessions.get(k);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    list(tenantId?) {
      const entries: Array<{ sessionKey: string; updatedAt: number }> = [];
      for (const [k, v] of sessions) {
        if (tenantId === undefined || k.startsWith(tenantId + ":")) {
          entries.push({ sessionKey: k, updatedAt: v.updatedAt });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    delete(key) {
      const k = keyStr(key);
      return sessions.delete(k);
    },

    deleteStale(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let deleted = 0;
      for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff) {
          sessions.delete(k);
          deleted++;
        }
      }
      return deleted;
    },

    loadByFormattedKey(sessionKey: string): SessionData | undefined {
      const s = sessions.get(sessionKey);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    listDetailed(tenantId?: string) {
      const entries: Array<{
        sessionKey: string;
        tenantId: string;
        userId: string;
        channelId: string;
        metadata: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
      }> = [];
      for (const [k, v] of sessions) {
        const parts = k.split(":");
        const tid = parts[0] ?? "";
        if (tenantId === undefined || tid === tenantId) {
          entries.push({
            sessionKey: k,
            tenantId: tid,
            userId: parts[1] ?? "",
            channelId: parts[2] ?? "",
            metadata: v.metadata,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("— Identity persistence across messages", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agt05-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("loadIdentityFiles loads AGENTS.md and returns consistent content", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "You are TestBot. Follow instructions carefully.",
    );

    const result1 = await loadIdentityFiles(workspaceDir);
    const result2 = await loadIdentityFiles(workspaceDir);

    expect(result1.agents).toBe("You are TestBot. Follow instructions carefully.");
    expect(result2.agents).toBe("You are TestBot. Follow instructions carefully.");
    expect(result1.agents).toBe(result2.agents);
  });

  it("assembleSystemPrompt produces same identity content across multiple calls", () => {
    const identity: IdentityFiles = {
      agents: "You are TestBot. Follow instructions carefully.",
    };

    const prompt1 = assembleSystemPrompt(identity);
    const prompt2 = assembleSystemPrompt(identity);

    // Both prompts should contain the identity content
    expect(prompt1).toContain("You are TestBot. Follow instructions carefully.");
    expect(prompt2).toContain("You are TestBot. Follow instructions carefully.");

    // Both prompts should contain the system date/time section
    expect(prompt1).toContain("## Current Date & Time");
    expect(prompt2).toContain("## Current Date & Time");

    // The identity content substring should be identical in both prompts
    const identityContent = "You are TestBot. Follow instructions carefully.";
    const idx1 = prompt1.indexOf(identityContent);
    const idx2 = prompt2.indexOf(identityContent);
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(-1);
  });

  it("session messages persist across loadOrCreate calls (session continuity)", () => {
    const store = createFakeSessionStore();
    const mgr = createSessionLifecycle(store);

    const key: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };

    // First "message turn": new session returns empty
    const turn1Messages = mgr.loadOrCreate(key);
    expect(turn1Messages).toHaveLength(0);

    // Save messages from first turn
    mgr.save(key, [
      { role: "user", content: "msg 1" },
      { role: "assistant", content: "reply 1" },
    ]);

    // Second "message turn": loads previous messages
    const turn2Messages = mgr.loadOrCreate(key);
    expect(turn2Messages).toHaveLength(2);

    // Save messages from second turn (accumulating)
    mgr.save(key, [
      { role: "user", content: "msg 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "reply 2" },
    ]);

    // Third "message turn": loads all 4 messages
    const turn3Messages = mgr.loadOrCreate(key);
    expect(turn3Messages).toHaveLength(4);
  });

  it("identity + session together: system prompt stays consistent while messages accumulate", async () => {
    // Create workspace with AGENTS.md
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "You are TestBot.",
    );

    // Load identity files once
    const identity = await loadIdentityFiles(workspaceDir);

    // Create SessionManager with fake store
    const store = createFakeSessionStore();
    const mgr = createSessionLifecycle(store);

    const key: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };

    const prompts: string[] = [];
    const messageCounts: number[] = [];

    // Turn 1: assemble prompt, new session (0 messages), save 2 messages
    prompts.push(assembleSystemPrompt(identity));
    messageCounts.push(mgr.loadOrCreate(key).length);
    mgr.save(key, [
      { role: "user", content: "msg 1" },
      { role: "assistant", content: "reply 1" },
    ]);

    // Turn 2: assemble prompt, load messages (2 present), save 4 messages
    prompts.push(assembleSystemPrompt(identity));
    messageCounts.push(mgr.loadOrCreate(key).length);
    mgr.save(key, [
      { role: "user", content: "msg 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "reply 2" },
    ]);

    // Turn 3: assemble prompt, load messages (4 present)
    prompts.push(assembleSystemPrompt(identity));
    messageCounts.push(mgr.loadOrCreate(key).length);

    // All 3 assembled prompts contain identity content
    for (const prompt of prompts) {
      expect(prompt).toContain("You are TestBot.");
    }

    // Message counts across turns: 0, 2, 4
    expect(messageCounts).toEqual([0, 2, 4]);
  });
});
