// SPDX-License-Identifier: Apache-2.0
/**
 * Preflight native-dependency doctor — extracted from `daemon.ts` to keep the
 * composition root under its 3000-line architecture cap (the v2.25 audio wiring
 * pushed daemon.ts to 3001; this self-contained, behavior-neutral probe is the
 * natural extraction). `daemon.ts` re-exports `runPreflightDoctor` so its public
 * surface (and `daemon.test.ts`'s `import … from "./daemon.js"`) is unchanged.
 *
 * The timestamp is read via `@comis/core`'s `systemNowDate()` (the sanctioned
 * runtime-root clock indirection) rather than a bare `new Date()`: extracting
 * this probe out of the globals-exempt `daemon.ts` bootstrap root would
 * otherwise trip the `globals` architecture gate (Phase 196 CR-01). The helper
 * keeps the same wall-clock behavior while routing the read through the
 * classifier-exempt `packages/core/src/runtime/` root.
 *
 * @module
 */

import { systemNowDate } from "@comis/core";

interface PreflightProbeDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}
type PreflightDatabaseCtor = new (path: string) => PreflightProbeDatabase;

/**
 * Probe better-sqlite3 before any subsystem init. A missing transitive
 * `bindings` folder (known failure mode from partial npm upgrades) makes
 * better-sqlite3 throw at first require, which otherwise surfaces as an
 * opaque mid-boot crash and a systemd restart loop. Here we catch it up
 * front and exit 78 (EX_CONFIG) with an actionable hint, so operators can
 * repair instead of chasing a cascading failure.
 */
export async function runPreflightDoctor(
  exitFn: (code: number) => void,
  opts: {
    stderrWrite?: (s: string) => void;
    loadBetterSqlite3?: () => Promise<PreflightDatabaseCtor>;
  } = {},
): Promise<void> {
  const write = opts.stderrWrite ?? ((s: string) => { process.stderr.write(s); });
  const load = opts.loadBetterSqlite3
    ?? (async () => (await import("better-sqlite3")).default as unknown as PreflightDatabaseCtor);
  try {
    const Database = await load();
    const db = new Database(":memory:");
    try {
      const row = db.prepare("select 1 as ok").get();
      if (!row) throw new Error("better-sqlite3 returned no row from sentinel query");
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    write(JSON.stringify({
      level: 60,
      time: systemNowDate().toISOString(),
      name: "comis-daemon",
      submodule: "preflight",
      errorKind: "dependency",
      err: message,
      hint: "Native module 'better-sqlite3' failed to load. Try: npm rebuild better-sqlite3 (or re-run install.sh). If this persists, reinstall comisai from a fresh tarball.",
      msg: "Preflight check failed: better-sqlite3 unavailable",
    }) + "\n");
    exitFn(78);
  }
}
