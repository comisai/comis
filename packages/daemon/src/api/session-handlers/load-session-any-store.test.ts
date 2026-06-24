// SPDX-License-Identifier: Apache-2.0
/**
 * COMPACT-STORE-MISS (30uc-20260624): `loadSessionAnyStore` — the lifecycle
 * handlers' EITHER-store loader. A REAL on-disk-layout test (AGENTS §2.10): the
 * live bug shipped precisely because a fixture-only handler test (a mock
 * sessionStore that returns a session) proved the LOGIC but NOT that a LIVE
 * file-JSONL session — the only place a channel chat transcript actually lives —
 * is found. So this WRITES an actual
 * `<ws>/sessions/<tenant>/<channel>/<userId>~peer~<peerId>.jsonl` and drives the
 * REAL helper (real scanWorkspaceSessions + loadJsonlSession + key derivation).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSessionAnyStore, type SessionHandlerDeps } from "./session-helpers.js";

type StoreData = { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined;

/** A deps stub carrying ONLY the two fields loadSessionAnyStore reads. */
function makeDeps(opts: {
  sqliteHit?: StoreData;
  defaultWorkspaceDir?: string;
}): SessionHandlerDeps {
  return {
    sessionStore: { loadByFormattedKey: (_k: string) => opts.sqliteHit },
    defaultWorkspaceDir: opts.defaultWorkspaceDir ?? "",
  } as unknown as SessionHandlerDeps;
}

/** Write a pi-wrapped JSONL transcript at the canonical workspace path; return the
 *  workspace dir + the formatted key scanWorkspaceSessions derives for it. */
function writeJsonlSession(userId: string, channelId: string, peerId: string, tenantId = "default"): { ws: string; key: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "load-any-store-"));
  const dir = path.join(ws, "sessions", tenantId, channelId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${userId}~peer~${peerId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "hi there" } }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  // The key scanWorkspaceSessions derives (pathToSessionKey → formatSessionKey).
  const key = `${tenantId}:${userId}:${channelId}:peer:${peerId}`;
  return { ws, key };
}

describe("loadSessionAnyStore (COMPACT-STORE-MISS)", () => {
  it("finds a LIVE file-JSONL session when the SQLite store misses (the active-chat case)", () => {
    const { ws, key } = writeJsonlSession("111", "222", "333");
    // SQLite empty (the live-daemon reality) — the fallback must read the JSONL.
    const data = loadSessionAnyStore(makeDeps({ sqliteHit: undefined, defaultWorkspaceDir: ws }), key);

    expect(data, `must resolve the live file session for ${key}`).toBeDefined();
    expect(data!.messages).toHaveLength(2);
    expect((data!.messages[0] as { role: string }).role).toBe("user");
    expect((data!.messages[1] as { content: string }).content).toBe("hi there");
  });

  it("prefers the SQLite store when it HAS the session (no needless file scan)", () => {
    const sqliteHit = { messages: [{ role: "user", content: "from-sqlite" }], metadata: {}, createdAt: 1, updatedAt: 2 };
    const data = loadSessionAnyStore(makeDeps({ sqliteHit, defaultWorkspaceDir: "/nonexistent" }), "any:key:here");
    expect(data).toBe(sqliteHit);
  });

  it("returns undefined when neither store has the session (honest not-found)", () => {
    const { ws } = writeJsonlSession("111", "222", "333");
    const data = loadSessionAnyStore(makeDeps({ sqliteHit: undefined, defaultWorkspaceDir: ws }), "default:999:888:peer:777");
    expect(data).toBeUndefined();
  });

  it("returns undefined (never throws) when no workspace dir is configured and SQLite misses", () => {
    const data = loadSessionAnyStore(makeDeps({ sqliteHit: undefined, defaultWorkspaceDir: "" }), "default:1:2:peer:3");
    expect(data).toBeUndefined();
  });
});
