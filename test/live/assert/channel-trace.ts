// SPDX-License-Identifier: Apache-2.0
/**
 * Channel-trace oracle — the shared, channel-agnostic DUAL-ORACLE cross-check
 * (Phase 205, ORACLE-01 + ORACLE-02).
 *
 * It composes the two oracles Phase 204 already shipped:
 *   - the CHANNEL oracle — `TgEmulator.lastBotReply(chat).text` (the exact bytes
 *     the bot put on the wire; ORACLE-01); accepted here as a minimal STRUCTURAL
 *     subset so the check stays channel-agnostic (not bound to `TgEmulator`).
 *   - the COMIS oracle — a DIRECT readonly `SELECT text FROM delivery_mirror
 *     WHERE session_key = ?` against the isolated `memory.db` (ORACLE-02).
 *
 * The HARD assertion (`assertChannelTrace`): the emulator-recorded outbound text
 * == `delivery_mirror.text` for the session — a THROW on mismatch OR on a
 * missing mirror row (no false success). This catches the "Comis thinks it sent
 * X but the wire shows Y" bug class the single-oracle VPS run structurally
 * cannot.
 *
 * Anti-pattern (deliberately avoided): reading the mirror via the delivery
 * mirror port's pending-only accessor, which filters `status='pending'` only —
 * the cross-check needs ACKNOWLEDGED rows too, so it reads the table DIRECTLY.
 *
 * Export shape MATCHES the sibling oracles (`assert/db-oracle.ts`
 * `runDbOracle`, `assert/log-oracle.ts` `runLogOracle`, `assert/observe.ts`
 * throwers): a function that opens readonly, runs the check, and throws
 * descriptively on failure.
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change. `test/` is outside every packages source-tree
 * ESLint/architecture rule, so raw `throw` / `better-sqlite3` are fine here.
 *
 * @module
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/**
 * Open a READONLY connection with the sqlite-vec extension loaded — copied
 * verbatim from `assert/db-oracle.ts` (where `openReadonlyWithVec` is PRIVATE,
 * not exported). Loading an extension is a connection-level operation, NOT a DB
 * write, so the readonly guarantee (T-134-12) is unchanged. A missing native
 * extension is tolerated (the isolated daemon may create `vec0` vtables; a plain
 * readonly connection that has not loaded sqlite-vec throws "no such module:
 * vec0" — loading it keeps those reads first-class, and a host that lacks the
 * extension simply degrades the vec-dependent reads, never the mirror read).
 */
function openReadonlyWithVec(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  try {
    sqliteVec.load(db);
  } catch {
    // Reader lacks sqlite-vec — vec-dependent reads degrade to their skip
    // paths; the plain `delivery_mirror.text` read here is unaffected.
  }
  return db;
}

/**
 * Read the LATEST `delivery_mirror.text` for a `session_key` from the isolated
 * `memory.db`, opened READONLY (the Comis half of the cross-check — ORACLE-02).
 *
 * Reads the table DIRECTLY (NOT via the delivery mirror port's pending-only
 * accessor, which filters `status='pending'`) so ACKNOWLEDGED rows are
 * included. Returns `undefined` on honest absence — never throws for a missing
 * row.
 *
 * @param dbPath     - Absolute path to the isolated SQLite `memory.db`.
 * @param sessionKey - The delivery session key to read the mirror text for.
 * @returns the latest mirror text for the session, or `undefined` if none.
 */
export function readMirrorText(dbPath: string, sessionKey: string): string | undefined {
  const db = openReadonlyWithVec(dbPath);
  try {
    const row = db
      .prepare("SELECT text FROM delivery_mirror WHERE session_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionKey) as { text?: string } | undefined;
    return row?.text as string | undefined;
  } finally {
    db.close();
  }
}

/**
 * Options for {@link assertChannelTrace}.
 *
 * The `emulator` is the CHANNEL oracle accepted as a minimal STRUCTURAL subset
 * (`{ lastBotReply(chat): { text?: string } | undefined }`) so the cross-check
 * stays channel-agnostic — any emulator that records outbound text satisfies
 * it, not just `TgEmulator` (which is the concrete 204 implementor and a
 * superset of this shape). Ready for reuse by the DELIV-01 scenario (205-06)
 * and Phases 206-208.
 */
export interface ChannelTraceOptions {
  /** The channel oracle (structural subset): the recorded wire bytes for a chat. */
  readonly emulator: {
    lastBotReply(chat: { chatId: number }): { text?: string } | undefined;
  };
  /** The chat whose last outbound is cross-checked. */
  readonly chat: { chatId: number };
  /** Absolute path to the isolated SQLite `memory.db` (the Comis oracle source). */
  readonly memoryDbPath: string;
  /** The delivery session key whose `delivery_mirror.text` is compared. */
  readonly sessionKey: string;
}

/**
 * The HARD dual-oracle cross-check (ORACLE-01 + ORACLE-02).
 *
 * Reads the CHANNEL oracle (`emulator.lastBotReply(chat).text` — the exact bytes
 * on the wire, ORACLE-01) and the COMIS oracle (`readMirrorText` — the latest
 * `delivery_mirror.text` for the session, ORACLE-02), then asserts they are
 * EQUAL. This is a HARD assertion: it THROWS — never a silent pass — when the
 * two disagree OR when the mirror row is absent. It catches the "Comis thinks it
 * sent X but the wire shows Y" bug class the single-oracle VPS run structurally
 * cannot. Matches the `assert/observe.ts` thrower idiom (void return, throws
 * descriptively on failure).
 *
 * @param opts - The two oracle handles + the session/chat identifiers.
 * @throws when the mirror row is absent (no delivery_mirror row), or when the
 *   wire text != the mirror text (a both-values-named, `dual-oracle`-tagged
 *   message so the failure is diagnosable from the throw alone).
 */
export async function assertChannelTrace(opts: ChannelTraceOptions): Promise<void> {
  // ORACLE-01 — the channel oracle: the exact bytes on the wire.
  const wire = opts.emulator.lastBotReply(opts.chat)?.text;
  // ORACLE-02 — the Comis oracle: the latest mirror text for the session
  // (read DIRECTLY, acknowledged rows included).
  const mirror = readMirrorText(opts.memoryDbPath, opts.sessionKey);

  // Missing mirror → an honest, reason-coded failure (NEVER a silent pass): a
  // wire reply with no corresponding delivery_mirror row is a real defect.
  if (mirror === undefined) {
    throw new Error(
      `[channel-trace] no delivery_mirror row for session "${opts.sessionKey}" ` +
        `(wire="${String(wire)}") — the bot put bytes on the wire but Comis recorded ` +
        `no mirror for the session. This is an honest cross-check failure, not a pass.`,
    );
  }

  // The HARD equality: the wire bytes MUST equal the mirror text.
  if (wire !== mirror) {
    throw new Error(
      `[channel-trace] dual-oracle mismatch: wire="${String(wire)}" mirror="${mirror}" ` +
        `sessionKey="${opts.sessionKey}" chatId=${opts.chat.chatId} — the channel oracle and ` +
        `the delivery_mirror disagree (Comis thinks it sent one thing; the wire shows another).`,
    );
  }
}
