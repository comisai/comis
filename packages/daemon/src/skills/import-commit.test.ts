// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the daemon-side serialized skill-import commit.
 *
 * Proves the three commit invariants under concurrency AND fault injection:
 *   - Phase-A runs PRE-WRITE (a rejecting bundle declaration leaves ZERO live
 *     writes — the closed post-move bug).
 *   - The commit is serialized under the per-skill keyed lock (two same-name
 *     imports: one installs, one refuses, the store holds one uncorrupted record).
 *   - The MCP-server-name re-check + persist run under a SHARED GLOBAL lock so
 *     two DIFFERENT-skill imports declaring the SAME server name serialize (the
 *     second's re-check happens-after the first's persist and refuses).
 *   - Any failure at provenance/init/persist unwinds the move before the lock
 *     releases (fresh: moved-in removed; update: parked restored).
 *   - The re-import rule: identical hash = no-op; divergent = confirm-gated
 *     swap + re-pin; unprovenanced / foreign source/identifier = flat refuse.
 *
 * Drives the REAL provenance store + REAL resolveBundle against a temp data dir
 * (no store mock) so the pins re-verify against disk.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ComisLogger } from "@comis/infra";
import type { McpServerEntry } from "@comis/core";
import {
  readProvenanceStore,
  provenanceKey,
  computeInstalledSetHash,
  writeProvenanceRecord,
  type ProvenanceRecord,
} from "@comis/skills";
import type { AcquireInput } from "@comis/skills";
import {
  runSkillImport,
  type SkillImportDeps,
  type RunSkillImportOpts,
} from "./import-commit.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
    level: "info",
    isLevelEnabled: vi.fn(() => true),
  } as unknown as ComisLogger;
}

const UNPACK_CAPS = {
  maxArchiveBytes: 8_388_608,
  maxTotalUncompressedBytes: 67_108_864,
  maxFileBytes: 4_194_304,
  maxFileCount: 200,
  maxPathDepth: 10,
} as const;

/** A minimal valid spec-pure SKILL.md file set (single-file skill). */
function skillSet(name: string, body: string, extra: { path: string; content: string }[] = []): AcquireInput {
  const md = `---\nname: ${name}\ndescription: A test skill for the import commit.\n---\n\n${body}\n`;
  return { kind: "fileSet", files: [{ path: "SKILL.md", content: md }, ...extra] };
}

/** A SKILL.md file set that declares a bundled stdio MCP server. */
function mcpSkillSet(name: string, serverName: string): AcquireInput {
  const md =
    `---\nname: ${name}\ndescription: A skill with a bundled MCP server.\n` +
    `mcpServers:\n  - name: ${serverName}\n    transport: stdio\n    command: node\n    args:\n      - server.js\n---\n\nBody.\n`;
  return { kind: "fileSet", files: [{ path: "SKILL.md", content: md }] };
}

interface DepsOverrides {
  currentServers?: McpServerEntry[];
  installedBundleState?: Record<string, Record<string, string>>;
  persistImportedBundle?: SkillImportDeps["persistImportedBundle"];
  writeProvenanceRecord?: SkillImportDeps["writeProvenanceRecord"];
  reinitRegistry?: () => void;
  now?: () => string;
}

function makeDeps(dataDir: string, o: DepsOverrides = {}): SkillImportDeps {
  const current = o.currentServers ?? [];
  return {
    dataDir,
    skillsDir: join(dataDir, "skills"),
    tmpRoot: join(dataDir, "tmp"),
    logger: makeLogger(),
    caps: UNPACK_CAPS,
    maxBodyLength: 20_000,
    osvCheckEnabled: false,
    readCurrentMcpServers: () => current,
    readInstalledBundleState: () => o.installedBundleState ?? {},
    reinitRegistry: o.reinitRegistry ?? vi.fn(),
    ...(o.persistImportedBundle && { persistImportedBundle: o.persistImportedBundle }),
    ...(o.writeProvenanceRecord && { writeProvenanceRecord: o.writeProvenanceRecord }),
    ...(o.now && { now: o.now }),
  };
}

function opts(over: Partial<RunSkillImportOpts> = {}): RunSkillImportOpts {
  return {
    source: "upload",
    identifier: "upload:sha256:aaa",
    scope: "shared",
    agentId: "agent-1",
    ...over,
  };
}

function liveDir(dataDir: string, name: string): string {
  return join(dataDir, "skills", name);
}
function liveExists(dataDir: string, name: string): boolean {
  return existsSync(join(liveDir(dataDir, name), "SKILL.md"));
}
function readLiveMd(dataDir: string, name: string): string {
  return readFileSync(join(liveDir(dataDir, name), "SKILL.md"), "utf-8");
}
function recordFor(dataDir: string, o: RunSkillImportOpts, name: string): ProvenanceRecord | undefined {
  return readProvenanceStore(dataDir)[provenanceKey(o.scope, o.agentId, name)];
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), `import-commit-${randomUUID().slice(0, 8)}-`));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Phase-A pre-write
// ---------------------------------------------------------------------------

describe("runSkillImport — Phase-A runs pre-write", () => {
  it("a rejecting bundle (name collision) leaves ZERO live writes", async () => {
    // A user-owned MCP entry already occupies the server name; no ledger record
    // for this skill ⇒ resolveBundle rejects with name_collision at STAGE time.
    const deps = makeDeps(dataDir, {
      currentServers: [{ name: "dup-server", transport: "stdio", command: "node" } as McpServerEntry],
    });
    const result = await runSkillImport(mcpSkillSet("collides", "dup-server"), opts(), deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.bundleKind).toBe("name_collision");
    }
    // The closed bug: today's post-move Phase-A would have left files. Assert none.
    expect(liveExists(dataDir, "collides")).toBe(false);
    expect(recordFor(dataDir, opts(), "collides")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fresh install + provenance pin
// ---------------------------------------------------------------------------

describe("runSkillImport — fresh install", () => {
  it("moves the staged files live, writes a provenance pin, and stamps source:imported", async () => {
    const deps = makeDeps(dataDir);
    const result = await runSkillImport(
      skillSet("clean-skill", "Instruction body.", [{ path: "reference.md", content: "# Reference\nnotes\n" }]),
      opts(),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("imported");
      expect(result.value.name).toBe("clean-skill");
      expect(result.value.mode).toBe("fresh");
    }
    expect(liveExists(dataDir, "clean-skill")).toBe(true);
    expect(existsSync(join(liveDir(dataDir, "clean-skill"), "reference.md"))).toBe(true);

    const rec = recordFor(dataDir, opts(), "clean-skill");
    expect(rec).toBeDefined();
    // The pin re-verifies against disk: contentHash == hash over the live files.
    const onDisk = rec!.files.map((rel) => ({
      relPath: rel,
      bytes: readFileSync(join(liveDir(dataDir, "clean-skill"), rel)),
    }));
    expect(computeInstalledSetHash(onDisk)).toBe(rec!.contentHash);
    // The per-import staging dir is cleaned up (the shared tmp root may remain).
    const tmpRoot = join(dataDir, "tmp");
    const leftover = existsSync(tmpRoot) ? readdirSync(tmpRoot).filter((n) => n.startsWith("skill-import-")) : [];
    expect(leftover).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Re-import matrix
// ---------------------------------------------------------------------------

describe("runSkillImport — re-import rule", () => {
  it("identical re-import is an idempotent no-op", async () => {
    const set = skillSet("reimp", "Same body.");
    await runSkillImport(set, opts(), makeDeps(dataDir));
    const first = recordFor(dataDir, opts(), "reimp")!;

    const result = await runSkillImport(set, opts(), makeDeps(dataDir));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe("noop");
    // Exactly one record; unchanged.
    expect(Object.keys(readProvenanceStore(dataDir))).toHaveLength(1);
    expect(recordFor(dataDir, opts(), "reimp")!.contentHash).toBe(first.contentHash);
  });

  it("a divergent re-import WITHOUT confirm refuses (pin divergence)", async () => {
    await runSkillImport(skillSet("reimp", "Original body."), opts(), makeDeps(dataDir));
    const result = await runSkillImport(skillSet("reimp", "Changed body."), opts(), makeDeps(dataDir));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.needsConfirm).toBe(true);
    // The live dir + pin still describe the ORIGINAL.
    expect(readLiveMd(dataDir, "reimp")).toContain("Original body.");
  });

  it("a divergent re-import WITH confirm swaps + re-pins (importedAt preserved)", async () => {
    let clock = "2026-01-01T00:00:00.000Z";
    await runSkillImport(skillSet("reimp", "Original body."), opts(), makeDeps(dataDir, { now: () => clock }));
    const before = recordFor(dataDir, opts(), "reimp")!;

    clock = "2026-02-02T00:00:00.000Z";
    const result = await runSkillImport(
      skillSet("reimp", "Changed body."),
      opts({ confirm: true }),
      makeDeps(dataDir, { now: () => clock }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe("update");
    expect(readLiveMd(dataDir, "reimp")).toContain("Changed body.");
    const after = recordFor(dataDir, opts(), "reimp")!;
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.importedAt).toBe(before.importedAt); // preserved
    expect(after.updatedAt).toBe("2026-02-02T00:00:00.000Z"); // bumped
    expect(Object.keys(readProvenanceStore(dataDir))).toHaveLength(1);
  });

  it("a foreign source/identifier re-import flat-refuses even WITH confirm", async () => {
    await runSkillImport(skillSet("reimp", "Original body."), opts(), makeDeps(dataDir));
    const result = await runSkillImport(
      skillSet("reimp", "Changed body."),
      opts({ confirm: true, identifier: "upload:sha256:DIFFERENT" }),
      makeDeps(dataDir),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.needsConfirm).toBeFalsy();
    // Original preserved; the foreign identifier never got a record.
    expect(readLiveMd(dataDir, "reimp")).toContain("Original body.");
    expect(recordFor(dataDir, opts(), "reimp")!.identifier).toBe("upload:sha256:aaa");
  });

  it("an unprovenanced same-name collision flat-refuses (never confirm-able)", async () => {
    // A hand-dropped / bundled skill occupies the name with NO provenance record.
    mkdirSync(liveDir(dataDir, "handmade"), { recursive: true });
    writeFileSync(join(liveDir(dataDir, "handmade"), "SKILL.md"), "---\nname: handmade\ndescription: pre-existing\n---\nHand.\n");

    const result = await runSkillImport(skillSet("handmade", "Imported body."), opts({ confirm: true }), makeDeps(dataDir));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.needsConfirm).toBeFalsy();
    expect(readLiveMd(dataDir, "handmade")).toContain("Hand.");
    expect(recordFor(dataDir, opts(), "handmade")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mid-commit unwind
// ---------------------------------------------------------------------------

describe("runSkillImport — mid-commit unwind", () => {
  it("a provenance-write failure on a FRESH install removes the moved-in dir", async () => {
    const failingWrite: SkillImportDeps["writeProvenanceRecord"] = async () => ({
      ok: false,
      error: { message: "disk full", hint: "free space", errorKind: "resource" },
    });
    const result = await runSkillImport(
      skillSet("unwind-fresh", "Body."),
      opts(),
      makeDeps(dataDir, { writeProvenanceRecord: failingWrite }),
    );

    expect(result.ok).toBe(false);
    // Unwound: no installed-but-unprovenanced skill survives.
    expect(liveExists(dataDir, "unwind-fresh")).toBe(false);
    expect(recordFor(dataDir, opts(), "unwind-fresh")).toBeUndefined();
  });

  it("a provenance-write failure on an UPDATE restores the parked previous install", async () => {
    await runSkillImport(skillSet("unwind-upd", "Original body."), opts(), makeDeps(dataDir));

    const failingWrite: SkillImportDeps["writeProvenanceRecord"] = async () => ({
      ok: false,
      error: { message: "disk full", hint: "free space", errorKind: "resource" },
    });
    const result = await runSkillImport(
      skillSet("unwind-upd", "Changed body."),
      opts({ confirm: true }),
      makeDeps(dataDir, { writeProvenanceRecord: failingWrite }),
    );

    expect(result.ok).toBe(false);
    // The previous install is restored, not lost.
    expect(liveExists(dataDir, "unwind-upd")).toBe(true);
    expect(readLiveMd(dataDir, "unwind-upd")).toContain("Original body.");
    // The original pin is intact.
    expect(recordFor(dataDir, opts(), "unwind-upd")!.contentHash).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("runSkillImport — concurrency", () => {
  it("two truly concurrent same-name imports: one installs, one refuses, one record", async () => {
    const [a, b] = await Promise.all([
      runSkillImport(skillSet("racer", "Body A."), opts({ identifier: "upload:sha256:AAA" }), makeDeps(dataDir)),
      runSkillImport(skillSet("racer", "Body B."), opts({ identifier: "upload:sha256:BBB" }), makeDeps(dataDir)),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const errs = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(1);
    // The store holds exactly one uncorrupted record.
    const store = readProvenanceStore(dataDir);
    expect(Object.keys(store)).toHaveLength(1);
    expect(liveExists(dataDir, "racer")).toBe(true);
  });

  it("two concurrent DIFFERENT-skill imports declaring the SAME MCP server name serialize (second refuses)", async () => {
    // A shared server-namespace closure: persist appends, re-check re-reads.
    const current: McpServerEntry[] = [];
    const persistImportedBundle: SkillImportDeps["persistImportedBundle"] = async ({ nextServers }) => {
      current.length = 0;
      current.push(...(nextServers as McpServerEntry[]));
      return { ok: true, value: undefined };
    };
    const shared: DepsOverrides = { currentServers: current, persistImportedBundle };

    const [a, b] = await Promise.all([
      runSkillImport(mcpSkillSet("skill-a", "same-mcp"), opts({ agentId: "agent-1", identifier: "upload:sha256:A" }), makeDeps(dataDir, shared)),
      runSkillImport(mcpSkillSet("skill-b", "same-mcp"), opts({ agentId: "agent-1", identifier: "upload:sha256:B" }), makeDeps(dataDir, shared)),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const errs = [a, b].filter((r) => !r.ok);
    // Serialization: exactly one wins; the loser's re-check refuses (a broken
    // global lock would let BOTH persist ⇒ two entries / two oks).
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(1);
    if (!errs[0]!.ok) expect(errs[0]!.error.bundleKind).toBe("name_collision");
    expect(current.filter((e) => e.name === "same-mcp")).toHaveLength(1);
    // Exactly one skill installed + one record (the loser unwound its move + pin).
    expect([liveExists(dataDir, "skill-a"), liveExists(dataDir, "skill-b")].filter(Boolean)).toHaveLength(1);
    expect(Object.keys(readProvenanceStore(dataDir))).toHaveLength(1);
  });
});
