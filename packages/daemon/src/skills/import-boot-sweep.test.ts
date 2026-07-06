// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the boot-time skill-import crash reconciliation sweep.
 *
 * Drives the reconciliation state machine against a REAL temp data dir with
 * hand-built staging dirs + `commit.json` markers + a real provenance store, so
 * every crash-window branch is proven end-to-end:
 *   - no marker            ⇒ pre-commit debris, discarded;
 *   - fresh, record absent ⇒ the move happened but the pin did not, rolled back;
 *   - fresh, record present ⇒ the commit completed, left intact;
 *   - update, re-pin NOT done ⇒ the parked previous install is restored;
 *   - update, re-pin DONE     ⇒ the committed update is PRESERVED (not reverted);
 *   - a double run is idempotent.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeProvenanceRecord, type ProvenanceRecord } from "@comis/skills";
import { sweepOrphanedImports, defaultSweepDeps, type SweepDeps } from "./import-boot-sweep.js";
import type { CommitIntent } from "./import-commit.js";

let dataDir: string;
let tmpRoot: string;
let skillsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), `boot-sweep-${randomUUID().slice(0, 8)}-`));
  tmpRoot = join(dataDir, "tmp");
  skillsDir = join(dataDir, "skills");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRecord(name: string, contentHash: string): ProvenanceRecord {
  return {
    name,
    scope: "shared",
    agentId: "agent-1",
    source: "upload",
    identifier: "upload:sha256:x",
    contentHash,
    scanVerdict: { clean: true, findingCount: 0 },
    files: ["SKILL.md"],
    importedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    importedBy: "agent-1",
  };
}

/** Hand-build a staging root; returns its absolute path. `marker === null` = no commit.json. */
function stageDir(id: string, marker: CommitIntent | null, opts: { parkedContent?: string } = {}): string {
  const root = join(tmpRoot, `skill-import-${id}`);
  mkdirSync(join(root, "staged"), { recursive: true });
  writeFileSync(join(root, "staged", "SKILL.md"), "staged leftover\n");
  if (opts.parkedContent !== undefined) {
    mkdirSync(join(root, "parked"), { recursive: true });
    writeFileSync(join(root, "parked", "SKILL.md"), opts.parkedContent);
  }
  if (marker !== null) writeFileSync(join(root, "commit.json"), JSON.stringify(marker));
  return root;
}

/** Create a live skill dir with a SKILL.md body. */
function liveSkill(name: string, body: string): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
}
function liveBody(name: string): string {
  return readFileSync(join(skillsDir, name, "SKILL.md"), "utf-8");
}

describe("sweepOrphanedImports", () => {
  it("discards a staging dir with NO commit.json (pre-commit debris)", () => {
    const root = stageDir("debris", null);
    const result = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(existsSync(root)).toBe(false);
    expect(result.discarded).toContain(root);
  });

  it("rolls back a FRESH move whose provenance record is ABSENT", () => {
    const live = liveSkill("freshroll", "moved-in but unprovenanced\n");
    const root = stageDir("fr", { mode: "fresh", targetPath: live, contentHash: "H", record: makeRecord("freshroll", "H") });
    // No provenance record in the store ⇒ the pin write never completed.

    const result = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(existsSync(live)).toBe(false); // rolled back — no installed-but-unprovenanced skill survives
    expect(existsSync(root)).toBe(false);
    expect(result.reconciled).toContain(root);
  });

  it("leaves a COMPLETED fresh install intact (record present)", async () => {
    const live = liveSkill("freshdone", "committed\n");
    await writeProvenanceRecord(dataDir, makeRecord("freshdone", "H"));
    const root = stageDir("fd", { mode: "fresh", targetPath: live, contentHash: "H", record: makeRecord("freshdone", "H") });

    const result = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(existsSync(live)).toBe(true); // completed commit — left intact
    expect(liveBody("freshdone")).toContain("committed");
    expect(existsSync(root)).toBe(false);
    expect(result.discarded).toContain(root);
  });

  it("restores the parked previous install when an UPDATE crashed BEFORE the re-pin", async () => {
    const live = liveSkill("updskill", "NEW body (half-committed)\n");
    // The on-disk record still pins the OLD content (re-pin did not complete).
    await writeProvenanceRecord(dataDir, makeRecord("updskill", "OLD"));
    const root = stageDir("ub", { mode: "update", targetPath: live, contentHash: "NEW", record: makeRecord("updskill", "NEW") }, { parkedContent: "OLD body\n" });

    const result = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(liveBody("updskill")).toContain("OLD body"); // parked restored
    expect(existsSync(root)).toBe(false);
    expect(result.reconciled).toContain(root);
  });

  it("PRESERVES the update when it crashed AFTER the re-pin (does not revert)", async () => {
    const live = liveSkill("updskill", "NEW body (committed)\n");
    // The on-disk record already pins NEW ⇒ the re-pin completed.
    await writeProvenanceRecord(dataDir, makeRecord("updskill", "NEW"));
    const root = stageDir("ua", { mode: "update", targetPath: live, contentHash: "NEW", record: makeRecord("updskill", "NEW") }, { parkedContent: "OLD body\n" });

    const result = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(liveBody("updskill")).toContain("NEW body"); // committed update preserved
    expect(existsSync(root)).toBe(false);
    expect(result.discarded).toContain(root);
  });

  it("never throws when a filesystem op fails mid-reconcile — logs the failure and continues (boot-safe)", async () => {
    // An update whose re-pin did NOT complete drives the restore-parked path,
    // which calls moveDir. A throwing moveDir (e.g. ENOTEMPTY when the best-
    // effort removeDir left a non-empty target) must be caught — the module
    // contract is "never throws / never blocks boot", and this runs unwrapped
    // at boot, so a propagated throw is a recurring boot-loop.
    const live = liveSkill("sweep-throw", "NEW body (half-committed)\n");
    await writeProvenanceRecord(dataDir, makeRecord("sweep-throw", "OLD")); // re-pin NOT done
    const root = stageDir(
      "st",
      { mode: "update", targetPath: live, contentHash: "NEW", record: makeRecord("sweep-throw", "NEW") },
      { parkedContent: "OLD body\n" },
    );

    const warn = vi.fn();
    const deps: SweepDeps = {
      ...defaultSweepDeps(dataDir, { info: vi.fn(), warn }),
      moveDir: () => {
        throw new Error("ENOTEMPTY: target not empty");
      },
    };

    expect(() => sweepOrphanedImports(deps)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    // The poisoned staging root is left in place for the next boot to retry.
    expect(existsSync(root)).toBe(true);
  });

  it("is idempotent across a double run", () => {
    stageDir("d1", null);
    liveSkill("freshroll2", "x\n");
    stageDir("d2", { mode: "fresh", targetPath: join(skillsDir, "freshroll2"), contentHash: "H", record: makeRecord("freshroll2", "H") });

    const first = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(first.discarded.length + first.reconciled.length).toBe(2);
    const second = sweepOrphanedImports(defaultSweepDeps(dataDir));
    expect(second.discarded).toHaveLength(0);
    expect(second.reconciled).toHaveLength(0);
  });
});
