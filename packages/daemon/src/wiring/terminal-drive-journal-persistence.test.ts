// SPDX-License-Identifier: Apache-2.0
/**
 * RED (165-04 Task 1, DUR-02): the DAEMON-side durable journal store
 * (`persistDriveJournal` / `loadDriveJournal` / `removeDriveJournal`), the single
 * genuinely-new capability of Phase 165. The resume read is per-session lazy (a
 * `load(agentId, sessionId)` on the first woken turn of a recovered session); there is
 * deliberately NO bulk `recover(agentId)` scan (no production caller — 165-REVIEW ME-03).
 *
 * RED-first: `terminal-drive-journal-persistence.ts` does not exist when this
 * file is first committed — the import fails, every case is RED. The production
 * module turns them GREEN. (Mirrors the "module absent on first commit" idiom of
 * `terminal-wake-persistence.test.ts` + `terminal-drive-journal.test.ts`.)
 *
 * The store is the resume substrate the Phase-164 rolling journal
 * (`terminal-drive-journal.ts`, pure + serializable + DUR-02-ready) is persisted
 * THROUGH so a 40h drive that crosses a daemon restart resumes from its journal
 * (objective + last classification + answered prompts + steps tried) rather than
 * starting over (I10). It mirrors VERBATIM-in-shape the atomic-durable-write +
 * recover-on-boot substrate of `terminal-wake-persistence.ts` — `ensureContainedDir`
 * (dir `0o700`) + `writeRegularFile` (file `0o600`) with `dataDir` as the
 * `confinedBaseDir` ancestor-symlink defense, a boot-time recover scan that SKIPS a
 * corrupt/partial file, the best-effort swallowed-error contract, and an
 * explicit-only remove (persist/recover NEVER delete — I10 preserve-on-failure).
 *
 * It wraps the SHIPPED pure `serializeJournal`/`deserializeJournal` from
 * `@comis/skills` (no shape rewrite — §7.1.6 LOCKED); the durable dir is the
 * resolved-Q2 confined per-agent path `<dataDir>/terminal-drive/<agentId>/journals/`.
 *
 * The three load-bearing properties pinned here (RESEARCH §"DUR-02 ... RED" +
 * the Req→Test map rows):
 *   - ROUND-TRIP ACROSS A SIMULATED RESTART: persist → a FRESH store instance's
 *     recover re-reads the same dir and yields the same journal (the resume
 *     substrate). A genuinely-gone session's journal is PRESERVED (recover reads it;
 *     persist never deletes) so a fresh drive can pick up (I10).
 *   - CONTENT-FREE + SECRET-REDACTED + 0o600/0o700 confined (I3 / V8 / T-165-09/13):
 *     a secret-shaped token in `lastScreenDigest` round-trips WITHOUT being
 *     expanded/structured (the journal is content-free by construction — the store
 *     persists the opaque bytes the upstream `scrubSecretsFromText` already
 *     produced; it never re-structures them into a credential field). The file is
 *     mode-0o600 in a 0o700 dir.
 *   - TOTAL recover (the DUR-02 recovery contract, T-165-12): a corrupt-after-crash
 *     file → `deserializeJournal`'s SAFE default (or skipped), NEVER a throw; a
 *     write fault is swallowed best-effort (the in-memory journal already updated).
 *
 * Two complementary test idioms (per the plan's Task-1 action):
 *   - a REAL-fs `mkdtemp(os.tmpdir())` round-trip (H2 guard: NEVER `~/.comis`) that
 *     asserts the on-disk 0o700/0o600 modes + the cross-instance restart, exactly
 *     like `terminal-wake-persistence.test.ts`; and
 *   - INJECTED-fs spies (the `WorkerFsPort`-shaped deps bag) that capture the mode
 *     args + run the fsync-thrower / write-fault-thrower on macOS with no real disk.
 *
 * @module
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyJournal, type DriveJournal } from "@comis/skills/tools";
import {
  persistDriveJournal,
  loadDriveJournal,
  removeDriveJournal,
  driveJournalDir,
  type DriveJournalPersistenceDeps,
} from "./terminal-drive-journal-persistence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT = "agent-1";

/** A realistic content-free journal (the SHIPPED shape; the store never rewrites it). */
function makeJournal(overrides: Partial<DriveJournal> = {}): DriveJournal {
  return {
    ...emptyJournal("build the app"),
    lastClassification: "awaiting-input",
    lastScreenDigest: "prompt: continue? (y/n)",
    answeredPrompts: ["pattern:2", "trust:1"],
    stepsTried: ["ran:build", "ran:test"],
    elapsedMs: 3_600_000,
    interactions: 7,
    costUsd: 0.42,
    truncations: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// REAL-fs idiom — round-trip across a simulated restart + on-disk 0o600/0o700
// (mirrors terminal-wake-persistence.test.ts; H2: under os.tmpdir(), never ~/.comis)
// ---------------------------------------------------------------------------

describe("terminal-drive-journal-persistence (durable drive journal, real fs)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-drive-journal-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a persisted journal through persist then a FRESH per-session load (the restart resume read)", () => {
    const journal = makeJournal();
    persistDriveJournal({ dataDir }, AGENT, "sess-a", journal);

    // Simulated restart: the holder's lazy resume read re-reads ONE journal from disk
    // (DUR-02 is per-session; there is no bulk recover — 165-REVIEW ME-03).
    expect(loadDriveJournal({ dataDir }, AGENT, "sess-a")).toEqual(journal);
  });

  it("isolates journals per agent (a different agentId loads nothing)", () => {
    persistDriveJournal({ dataDir }, AGENT, "sess-a", makeJournal());
    expect(loadDriveJournal({ dataDir }, "other-agent", "sess-a")).toBeUndefined();
  });

  it("loadDriveJournal returns the persisted journal (the resume read, I10)", () => {
    const journal = makeJournal({ answeredPrompts: ["pattern:2"] });
    persistDriveJournal({ dataDir }, AGENT, "sess-resume", journal);

    const loaded = loadDriveJournal({ dataDir }, AGENT, "sess-resume");
    expect(loaded).toEqual(journal);
    // DUR-02 resume-no-re-answer substrate: the answered-prompt tag survives the restart.
    expect(loaded?.answeredPrompts).toContain("pattern:2");
  });

  it("loadDriveJournal returns undefined for a missing session (never throws)", () => {
    expect(() => loadDriveJournal({ dataDir }, AGENT, "never-there")).not.toThrow();
    expect(loadDriveJournal({ dataDir }, AGENT, "never-there")).toBeUndefined();
  });

  it("writes under a confined terminal-drive/<agentId>/journals subdir (0o700 dir / 0o600 file)", () => {
    persistDriveJournal({ dataDir }, AGENT, "sess-x", makeJournal());

    const journalsDir = driveJournalDir(dataDir, AGENT);
    expect(journalsDir).toBe(join(dataDir, "terminal-drive", AGENT, "journals"));

    const entries = readdirSync(journalsDir);
    expect(entries).toContain("sess-x.json");

    // Dir mode 0o700, file mode 0o600 — the @comis/observability fs-safe invariants (V8).
    expect(statSync(journalsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(journalsDir, "sess-x.json")).mode & 0o777).toBe(0o600);
  });

  it("I3: a secret-shaped digest round-trips WITHOUT being expanded into a credential field", () => {
    // The journal is content-free by construction; the store persists the opaque
    // (already-redacted-upstream) bytes verbatim — it must never re-structure a
    // secret-shaped token into a key/value the way a config dump would.
    const journal = makeJournal({ lastScreenDigest: "token sk-LIVE-deadbeef in prompt" });
    persistDriveJournal({ dataDir }, AGENT, "sess-secret", journal);

    const raw = readFileSync(join(driveJournalDir(dataDir, AGENT), "sess-secret.json"), "utf-8");
    // The persisted bytes carry NO credential-field STRUCTURE — only the flat,
    // content-free journal keys. (The opaque digest string itself round-trips; we
    // assert the store did not introduce any apiKey/password/secret/token KEY.)
    const onDisk = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(
      [
        "answeredPrompts",
        "costUsd",
        "elapsedMs",
        "interactions",
        "lastClassification",
        "lastScreenDigest",
        "objective",
        "stepsTried",
        "truncations",
      ].sort(),
    );
    expect(raw).not.toMatch(/"(apiKey|password|secret|token|authorization|botToken|privateKey)"\s*:/i);
    // And it round-trips losslessly (the opaque digest survives, never re-expanded).
    expect(loadDriveJournal({ dataDir }, AGENT, "sess-secret")).toEqual(journal);
  });

  it("loads a good journal even when a corrupt sibling file exists (corrupt-after-crash → never a throw)", () => {
    persistDriveJournal({ dataDir }, AGENT, "good", makeJournal());
    const journalsDir = driveJournalDir(dataDir, AGENT);
    mkdirSync(journalsDir, { recursive: true });
    // A truncated-mid-write file + a non-JSON file alongside the good one.
    writeFileSync(join(journalsDir, "corrupt.json"), "{ this is not json");
    writeFileSync(join(journalsDir, "half.json"), '{"objective":"x"');

    // The good one loads intact; a corrupt sibling does not affect it (per-session read).
    expect(() => loadDriveJournal({ dataDir }, AGENT, "good")).not.toThrow();
    expect(loadDriveJournal({ dataDir }, AGENT, "good")).toEqual(makeJournal());
  });

  it("loadDriveJournal yields deserialize's SAFE default for a corrupt file (never throws)", () => {
    const journalsDir = driveJournalDir(dataDir, AGENT);
    mkdirSync(journalsDir, { recursive: true });
    writeFileSync(join(journalsDir, "broken.json"), "{ not json at all");

    // A corrupt-after-crash file → deserializeJournal's safe default (a fresh
    // empty journal), NEVER a throw. (deserializeJournal is total.)
    expect(() => loadDriveJournal({ dataDir }, AGENT, "broken")).not.toThrow();
    const loaded = loadDriveJournal({ dataDir }, AGENT, "broken");
    expect(loaded).toEqual(emptyJournal(""));
  });

  it("loads undefined when the agent's journal dir does not exist yet", () => {
    expect(loadDriveJournal({ dataDir }, "fresh-agent", "sess-a")).toBeUndefined();
  });

  it("I10 preserve-on-failure: persist/load NEVER delete; remove is a DISTINCT explicit call", () => {
    persistDriveJournal({ dataDir }, AGENT, "sess-keep", makeJournal());
    // Re-persisting / loading repeatedly never removes the journal — a
    // genuinely-gone session keeps its journal for a fresh drive (I10).
    loadDriveJournal({ dataDir }, AGENT, "sess-keep");
    persistDriveJournal({ dataDir }, AGENT, "sess-other", makeJournal());
    loadDriveJournal({ dataDir }, AGENT, "sess-keep");
    expect(loadDriveJournal({ dataDir }, AGENT, "sess-keep")).toEqual(makeJournal());

    // Only the explicit remove deletes it (ENOENT-tolerant on a repeat).
    removeDriveJournal({ dataDir }, AGENT, "sess-keep");
    expect(loadDriveJournal({ dataDir }, AGENT, "sess-keep")).toBeUndefined();
    expect(() => removeDriveJournal({ dataDir }, AGENT, "sess-keep")).not.toThrow();
  });

  it("does not throw to the caller when the persist target is unwritable (best-effort)", () => {
    // A dataDir that is actually a FILE makes the confined dir-creation fail; the
    // swallowed-error contract means persist must still not throw (the in-memory
    // journal already updated).
    const fileAsDir = join(dataDir, "not-a-dir");
    writeFileSync(fileAsDir, "x");
    expect(() => persistDriveJournal({ dataDir: fileAsDir }, AGENT, "sess-a", makeJournal())).not.toThrow();
  });

  it("stays best-effort (never throws) for a degenerate relative dataDir like '.'", () => {
    // A degenerate dataDir (a relative "." from a bootstrap/test config) makes
    // safePath throw PathTraversalError; persist/recover/load/remove must SWALLOW
    // that so recover-on-boot never crashes the daemon constructor.
    expect(() => persistDriveJournal({ dataDir: "." }, AGENT, "sess-rel", makeJournal())).not.toThrow();
    expect(() => loadDriveJournal({ dataDir: "." }, AGENT, "sess-rel")).not.toThrow();
    expect(loadDriveJournal({ dataDir: "." }, AGENT, "sess-rel")).toBeUndefined();
    expect(() => removeDriveJournal({ dataDir: "." }, AGENT, "sess-rel")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// INJECTED-fs idiom — mode-arg spies + the durable write→rename→fsync sequence +
// the fsync-thrower (runs on macOS with no real disk). The WorkerFsPort-shaped
// deps bag (terminal-worker-entry.ts:117) is threaded so the test captures the
// mode args + injects a thrower (mirrors the worker writeDurable test seam).
// ---------------------------------------------------------------------------

describe("terminal-drive-journal-persistence (injected fs — mode + durability)", () => {
  /** A capturing fs-safe substrate: records the mode args, writes nowhere. */
  function spyDeps(): {
    deps: DriveJournalPersistenceDeps;
    ensured: Array<{ dir: string; mode: number; confinedBaseDir?: string }>;
    written: Array<{ path: string; content: string; confinedBaseDir?: string }>;
    fsyncCalls: number;
    renameCalls: number;
  } {
    const ensured: Array<{ dir: string; mode: number; confinedBaseDir?: string }> = [];
    const written: Array<{ path: string; content: string; confinedBaseDir?: string }> = [];
    let fsyncCalls = 0;
    let renameCalls = 0;
    const deps: DriveJournalPersistenceDeps = {
      dataDir: "/data",
      ensureContainedDir: (opts) => {
        ensured.push({ dir: opts.dir, mode: opts.mode, confinedBaseDir: opts.confinedBaseDir });
      },
      writeRegularFile: (opts) => {
        written.push({
          path: opts.path,
          content: typeof opts.content === "string" ? opts.content : opts.content.toString("utf8"),
          confinedBaseDir: opts.confinedBaseDir,
        });
      },
      renameSync: () => {
        renameCalls += 1;
      },
      openSync: () => 7,
      fsyncSync: () => {
        fsyncCalls += 1;
      },
      closeSync: () => undefined,
    };
    return {
      deps,
      ensured,
      written,
      get fsyncCalls() {
        return fsyncCalls;
      },
      get renameCalls() {
        return renameCalls;
      },
    };
  }

  it("creates the journals dir at mode 0o700 with dataDir as the confinedBaseDir", () => {
    const s = spyDeps();
    persistDriveJournal(s.deps, AGENT, "sess-a", makeJournal());
    expect(s.ensured).toHaveLength(1);
    expect(s.ensured[0].mode).toBe(0o700);
    expect(s.ensured[0].dir).toBe(join("/data", "terminal-drive", AGENT, "journals"));
    expect(s.ensured[0].confinedBaseDir).toBe("/data");
  });

  it("writes the serialized journal through the 0o600 fs-safe write with the confinedBaseDir", () => {
    const s = spyDeps();
    const journal = makeJournal();
    persistDriveJournal(s.deps, AGENT, "sess-a", journal);
    expect(s.written).toHaveLength(1);
    expect(s.written[0].path).toBe(join("/data", "terminal-drive", AGENT, "journals", "sess-a.json"));
    expect(s.written[0].confinedBaseDir).toBe("/data");
    // The bytes are exactly the SHIPPED serializeJournal output (no shape rewrite).
    expect(JSON.parse(s.written[0].content)).toEqual(journal);
  });

  it("swallows ONLY the disabled-fsync refusal under --permission (best-effort durability)", () => {
    const s = spyDeps();
    // The fsync branch throws the permission-model refusal; persist must swallow it
    // (the write+rename already made the journal durable) and NOT propagate.
    s.deps.fsyncSync = () => {
      const e = new Error("fsync API is disabled when Permission Model is enabled.");
      (e as { code?: string }).code = "ERR_ACCESS_DENIED";
      throw e;
    };
    expect(() => persistDriveJournal(s.deps, AGENT, "sess-a", makeJournal())).not.toThrow();
  });

  it("swallows a GENUINE write fault best-effort (the in-memory journal already updated)", () => {
    const s = spyDeps();
    // A genuine EIO on the write path is best-effort-swallowed (mirrors the wake
    // substrate: a failed persist degrades to 'missed on recover', never a throw).
    s.deps.writeRegularFile = () => {
      const e = new Error("EIO: i/o error");
      (e as { code?: string }).code = "EIO";
      throw e;
    };
    expect(() => persistDriveJournal(s.deps, AGENT, "sess-a", makeJournal())).not.toThrow();
  });

  it("removeDriveJournal swallows ENOENT via the injected unlink (explicit-only)", () => {
    const unlink = vi.fn(() => {
      const e = new Error("ENOENT");
      (e as { code?: string }).code = "ENOENT";
      throw e;
    });
    const deps: DriveJournalPersistenceDeps = { dataDir: "/data", unlinkSync: unlink };
    expect(() => removeDriveJournal(deps, AGENT, "gone")).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});
