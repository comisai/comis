// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the guarded SessionManager-internals boundary.
 *
 * These run against the REAL SDK SessionManager (no mocks) on purpose: the
 * session scrubbers repair persisted entries through two private SDK
 * internals (`fileEntries`, `_rewriteFile`). The SDK has no public seam for
 * in-place repair of already-persisted entries, so an SDK-internal rename
 * would otherwise silently disable the scrubbers (they are best-effort
 * no-ops on shape mismatch). The canary test here turns that silent no-op
 * into a loud CI failure at SDK-bump time.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  getSessionFileEntries,
  installSecretSafeSessionPersistence,
  installSessionPersistenceProjector,
  rewriteSessionFile,
} from "./session-manager-internals.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sm-internals-"));
  tempDirs.push(dir);
  return dir;
}

function appendUser(sm: SessionManager, text: string): void {
  sm.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function appendAssistant(sm: SessionManager, text: string): void {
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages" as any,
    provider: "anthropic" as any,
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  } as any);
}

// ---------------------------------------------------------------------------
// Canary: the SDK internals the scrubbers depend on still exist
// ---------------------------------------------------------------------------

describe("session-manager-internals SDK canary", () => {
  it("CANARY: SessionManager still carries the private persistence and repair seams", () => {
    const sm = SessionManager.inMemory("/tmp/test-cwd");
    // If either assertion fails after an SDK bump, the private internals were
    // renamed/removed: the session scrubbers (poisoned-thinking, redacted
    // tool-call, forged-marker) would silently no-op. Re-point the guarded
    // boundary in session-manager-internals.ts — do NOT patch the scrubbers
    // individually.
    const internals = sm as unknown as {
      fileEntries?: unknown;
      _persist?: unknown;
      _rewriteFile?: unknown;
    };
    expect(Array.isArray(internals.fileEntries)).toBe(true);
    expect(typeof internals._persist).toBe("function");
    expect(typeof internals._rewriteFile).toBe("function");
  });
});

describe("session persistence projection", () => {
  it("rejects a missing persistence hook instead of permitting unprojected writes", () => {
    const error = vi.fn();
    const logger = createMockLogger({ error });

    const result = installSecretSafeSessionPersistence(
      {} as SessionManager,
      logger,
      "agent_a:telegram:user_a",
    );

    expect(result.ok).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "dependency",
        step: "session-persistence",
      }),
      expect.stringContaining("stopped"),
    );
  });

  it("returns false from the guarded low-level installer on a shape mismatch", () => {
    const installed = installSessionPersistenceProjector(
      {} as SessionManager,
      (entry) => ({ value: entry, redactions: 0 }),
    );

    expect(installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSessionFileEntries
// ---------------------------------------------------------------------------

describe("getSessionFileEntries", () => {
  it("returns the live persisted-entry list of a real SessionManager", () => {
    const sm = SessionManager.inMemory("/tmp/test-cwd");
    appendUser(sm, "hello");
    appendAssistant(sm, "world");

    const entries = getSessionFileEntries(sm);
    expect(entries).toBeDefined();
    const messages = entries!.filter((e) => e.type === "message");
    expect(messages.length).toBe(2);
    const roles = messages.map((e) => (e as { message: { role: string } }).message.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("returns the SAME array the SDK mutates internally (live view, not a copy)", () => {
    const sm = SessionManager.inMemory("/tmp/test-cwd");
    const before = getSessionFileEntries(sm);
    expect(before).toBeDefined();
    const countBefore = before!.length;
    appendUser(sm, "added later");
    // The boundary must hand back the live list: a defensive copy would make
    // scrubber mutations invisible to the SDK's replay/rewrite paths.
    expect(before!.length).toBeGreaterThan(countBefore);
  });

  it("returns undefined on a shape mismatch instead of throwing (best-effort scrubber contract)", () => {
    expect(getSessionFileEntries({} as unknown as SessionManager)).toBeUndefined();
    expect(
      getSessionFileEntries({ fileEntries: "not-an-array" } as unknown as SessionManager),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rewriteSessionFile
// ---------------------------------------------------------------------------

describe("rewriteSessionFile", () => {
  it("persists an in-place entry repair to disk (end-to-end through a reopen)", () => {
    const dir = makeTempDir();
    const path = join(dir, "canary-session.jsonl");
    const sm = SessionManager.open(path, dir);
    appendUser(sm, "trigger");
    appendAssistant(sm, "CANARY-SENSITIVE-TEXT");

    // In-place repair through the boundary, exactly as the scrubbers do.
    const entries = getSessionFileEntries(sm);
    expect(entries).toBeDefined();
    let mutated = 0;
    for (const entry of entries!) {
      if (entry.type !== "message") continue;
      const msg = (entry as { message: { role?: string; content?: unknown } }).message;
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<{ type?: string; text?: string }>) {
        if (block.type === "text" && block.text === "CANARY-SENSITIVE-TEXT") {
          block.text = "(scrubbed)";
          mutated++;
        }
      }
    }
    expect(mutated).toBe(1);
    expect(rewriteSessionFile(sm)).toBe(true);

    // Ground truth 1: raw bytes on disk no longer carry the sensitive text.
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain("CANARY-SENSITIVE-TEXT");
    expect(raw).toContain("(scrubbed)");

    // Ground truth 2: a fresh SDK reopen sees the repaired entry.
    const reopened = SessionManager.open(path, dir);
    const reopenedTexts = reopened
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as unknown as { message: { content?: unknown } }).message.content)
      .filter(Array.isArray)
      .flat()
      .map((b) => (b as { text?: string }).text);
    expect(reopenedTexts).toContain("(scrubbed)");
    expect(reopenedTexts).not.toContain("CANARY-SENSITIVE-TEXT");
  });

  it("returns false on a shape mismatch instead of throwing (best-effort scrubber contract)", () => {
    expect(rewriteSessionFile({} as unknown as SessionManager)).toBe(false);
    expect(
      rewriteSessionFile({ _rewriteFile: "not-a-function" } as unknown as SessionManager),
    ).toBe(false);
  });
});
