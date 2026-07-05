// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior + boundary tests for the daemon-private provenance store, the shared
 * keyed import mutex, and the installed-set hash.
 *
 * The store is the durable substrate the trust tier hangs on: it marks a skill
 * imported (advisory DOWNWARD only — absence never elevates). It must read
 * fail-safe (a missing or corrupt file never blocks boot), write only
 * validated, non-escaping records at mode 0o600, and remove exactly one record.
 * Because the store is a single shared file, concurrent read-modify-write
 * importers MUST serialize on the module-singleton `withSkillImportLock` — the
 * unlocked path loses a record; the locked path converges to both.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  readProvenanceStore,
  writeProvenanceRecord,
  removeProvenanceRecord,
  parseProvenanceRecord,
  provenanceKey,
  computeInstalledSetHash,
  withSkillImportLock,
  SKILL_IMPORT_COMMIT_LOCK,
  type ProvenanceRecord,
} from "./provenance-store.js";

const STORE_FILE = "skill-provenance.json";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `provenance-store-${randomUUID().slice(0, 8)}-`));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    name: "demo-skill",
    scope: "shared",
    agentId: "default",
    source: "archive",
    identifier: "https://example.invalid/demo.skill",
    contentHash: "0".repeat(64),
    scanVerdict: { clean: true, findingCount: 0 },
    files: ["SKILL.md"],
    importedAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    importedBy: "default",
    ...overrides,
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("readProvenanceStore — fail-safe (never blocks boot)", () => {
  it("returns an empty store on a fresh dataDir (no file)", () => {
    expect(readProvenanceStore(tmpDir)).toEqual({});
  });

  it("returns an empty store on a corrupt / non-JSON file", () => {
    writeFileSync(join(tmpDir, STORE_FILE), "}{ not json at all", "utf-8");
    expect(readProvenanceStore(tmpDir)).toEqual({});
  });

  it("returns an empty store when the file holds valid JSON that is not an object", () => {
    writeFileSync(join(tmpDir, STORE_FILE), "[1, 2, 3]", "utf-8");
    expect(readProvenanceStore(tmpDir)).toEqual({});
  });

  it("never copies a __proto__ store key onto the returned store", () => {
    const rec = makeRecord({ name: "ok", scope: "local", agentId: "alice" });
    const key = provenanceKey("local", "alice", "ok");
    writeFileSync(
      join(tmpDir, STORE_FILE),
      `{"__proto__":{"polluted":true},"${key}":${JSON.stringify(rec)}}`,
      "utf-8",
    );
    const store = readProvenanceStore(tmpDir);
    expect(store[key]).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(store, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("skips a malformed record but keeps the valid ones (advisory downward)", async () => {
    const rec = makeRecord({ name: "alpha", scope: "local", agentId: "alice" });
    const key = provenanceKey("local", "alice", "alpha");
    // A store file with one valid record and one malformed entry.
    writeFileSync(
      join(tmpDir, STORE_FILE),
      JSON.stringify({ [key]: rec, "local:alice:broken": { name: 7 } }),
      "utf-8",
    );
    const store = readProvenanceStore(tmpDir);
    expect(store[key]).toBeDefined();
    expect(store["local:alice:broken"]).toBeUndefined();
  });
});

describe("writeProvenanceRecord — validated, contained, 0o600 round-trip", () => {
  it("writes a record that round-trips under its key, at mode 0o600", async () => {
    const rec = makeRecord({ name: "alpha", scope: "local", agentId: "alice" });
    const result = await writeProvenanceRecord(tmpDir, rec);
    expect(result.ok).toBe(true);

    const filePath = join(tmpDir, STORE_FILE);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    const store = readProvenanceStore(tmpDir);
    expect(store[provenanceKey("local", "alice", "alpha")]).toEqual(rec);
  });

  it("keys a shared-scope record with the 'shared' owner sentinel", async () => {
    const rec = makeRecord({ name: "beta", scope: "shared", agentId: "default" });
    await writeProvenanceRecord(tmpDir, rec);
    const store = readProvenanceStore(tmpDir);
    expect(store["shared:shared:beta"]).toEqual(rec);
  });

  it("rejects a traversal name with errorKind 'validation' and writes nothing", async () => {
    const result = await writeProvenanceRecord(tmpDir, makeRecord({ name: "../evil" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation reject");
    expect(result.error.errorKind).toBe("validation");
    expect(existsSync(join(tmpDir, STORE_FILE))).toBe(false);
  });

  it("rejects an absolute / separator-bearing name with errorKind 'validation'", async () => {
    const abs = await writeProvenanceRecord(tmpDir, makeRecord({ name: "/etc/passwd" }));
    expect(abs.ok).toBe(false);
    if (abs.ok) throw new Error("expected a validation reject");
    expect(abs.error.errorKind).toBe("validation");
  });

  it("rejects a structurally-invalid record (bad source enum) with errorKind 'validation'", async () => {
    const bad = { ...makeRecord(), source: "bogus" } as unknown as ProvenanceRecord;
    const result = await writeProvenanceRecord(tmpDir, bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation reject");
    expect(result.error.errorKind).toBe("validation");
  });

  it("rejects a URL-encoded traversal name (safePath backstop) with errorKind 'validation'", async () => {
    const result = await writeProvenanceRecord(tmpDir, makeRecord({ name: "%2e%2e%2fsecrets" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation reject");
    expect(result.error.errorKind).toBe("validation");
  });

  it("returns errorKind 'resource' when the data dir cannot be ensured", async () => {
    // A data dir nested under a regular file cannot be created (ENOTDIR).
    writeFileSync(join(tmpDir, "afile"), "x", "utf-8");
    const badDataDir = join(tmpDir, "afile", "nested");
    const result = await writeProvenanceRecord(badDataDir, makeRecord({ name: "alpha" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a resource reject");
    expect(result.error.errorKind).toBe("resource");
  });

  it("returns errorKind 'resource' when the store path is not writable", async () => {
    // A directory occupying the store path makes the symlink-safe file write fail.
    mkdirSync(join(tmpDir, STORE_FILE));
    const result = await writeProvenanceRecord(tmpDir, makeRecord({ name: "alpha" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a resource reject");
    expect(result.error.errorKind).toBe("resource");
  });
});

describe("removeProvenanceRecord — removes exactly one", () => {
  it("removes the target record while leaving the rest intact", async () => {
    const a = makeRecord({ name: "alpha", scope: "local", agentId: "alice" });
    const b = makeRecord({ name: "bravo", scope: "local", agentId: "alice" });
    const keyA = provenanceKey("local", "alice", "alpha");
    const keyB = provenanceKey("local", "alice", "bravo");
    await writeProvenanceRecord(tmpDir, a);
    await writeProvenanceRecord(tmpDir, b);

    const removed = await removeProvenanceRecord(tmpDir, keyA);
    expect(removed.ok).toBe(true);

    const store = readProvenanceStore(tmpDir);
    expect(store[keyA]).toBeUndefined();
    expect(store[keyB]).toEqual(b);
  });

  it("is idempotent for an absent key", async () => {
    const result = await removeProvenanceRecord(tmpDir, "local:alice:missing");
    expect(result.ok).toBe(true);
  });
});

describe("parseProvenanceRecord — the strict parse helper", () => {
  it("accepts a well-formed record and rejects a malformed one", () => {
    expect(parseProvenanceRecord(makeRecord()).ok).toBe(true);
    expect(parseProvenanceRecord({ name: "x" }).ok).toBe(false);
    // An unknown extra key is rejected (strictObject).
    expect(parseProvenanceRecord({ ...makeRecord(), extra: 1 }).ok).toBe(false);
  });
});

describe("computeInstalledSetHash — deterministic, order-independent", () => {
  it("is stable across input ordering", () => {
    const files = [
      { relPath: "SKILL.md", bytes: Buffer.from("body") },
      { relPath: "references/a.md", bytes: Buffer.from("alpha") },
      { relPath: "references/b.md", bytes: Buffer.from("bravo") },
    ];
    const reversed = [...files].reverse();
    expect(computeInstalledSetHash(files)).toBe(computeInstalledSetHash(reversed));
  });

  it("changes when a file's bytes change", () => {
    const base = [{ relPath: "SKILL.md", bytes: Buffer.from("body") }];
    const changed = [{ relPath: "SKILL.md", bytes: Buffer.from("BODY") }];
    expect(computeInstalledSetHash(base)).not.toBe(computeInstalledSetHash(changed));
  });
});

describe("withSkillImportLock — the module-singleton keyed mutex", () => {
  it("is load-bearing: unlocked concurrent writes lose a record, locked converge to both", async () => {
    const a = makeRecord({ name: "alpha", scope: "local", agentId: "alice" });
    const b = makeRecord({ name: "bravo", scope: "local", agentId: "alice" });
    const keyA = provenanceKey("local", "alice", "alpha");
    const keyB = provenanceKey("local", "alice", "bravo");

    // Unlocked: two concurrent read-modify-writes race -> one record is lost.
    await Promise.all([writeProvenanceRecord(tmpDir, a), writeProvenanceRecord(tmpDir, b)]);
    const unlocked = readProvenanceStore(tmpDir);
    expect(Object.keys(unlocked).length).toBe(1);

    // Reset the store.
    rmSync(join(tmpDir, STORE_FILE), { force: true });

    // Locked on one constant key (a global lock): the writes serialize -> both survive.
    await Promise.all([
      withSkillImportLock(SKILL_IMPORT_COMMIT_LOCK, () => writeProvenanceRecord(tmpDir, a)),
      withSkillImportLock(SKILL_IMPORT_COMMIT_LOCK, () => writeProvenanceRecord(tmpDir, b)),
    ]);
    const locked = readProvenanceStore(tmpDir);
    expect(Object.keys(locked).length).toBe(2);
    expect(locked[keyA]).toEqual(a);
    expect(locked[keyB]).toEqual(b);
  });

  it("serializes same-key work through the ONE module lock (singleton behavior)", async () => {
    const order: string[] = [];
    const slow = withSkillImportLock("k", async () => {
      order.push("A:start");
      await delay(25);
      order.push("A:end");
    });
    const fast = withSkillImportLock("k", async () => {
      order.push("B:start");
      order.push("B:end");
    });
    await Promise.all([slow, fast]);
    // B cannot start until A ends — proving both calls share ONE lock instance.
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("does not poison the chain when a prior holder rejects — the next same-key waiter still runs", async () => {
    const order: string[] = [];
    const failing = withSkillImportLock("k", async () => {
      order.push("A:threw");
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const next = await withSkillImportLock("k", async () => {
      order.push("B:ran");
      return "ok";
    });
    expect(next).toBe("ok");
    expect(order).toEqual(["A:threw", "B:ran"]);
  });

  it("lets different keys run concurrently (does not over-serialize)", async () => {
    const order: string[] = [];
    const a = withSkillImportLock("k1", async () => {
      order.push("A:start");
      await delay(25);
      order.push("A:end");
    });
    const b = withSkillImportLock("k2", async () => {
      order.push("B:start");
      order.push("B:end");
    });
    await Promise.all([a, b]);
    // B (a different key) runs while A awaits.
    expect(order).toEqual(["A:start", "B:start", "B:end", "A:end"]);
  });
});
