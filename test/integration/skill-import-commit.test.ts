// SPDX-License-Identifier: Apache-2.0
/**
 * Ground-truth integration test for the staged skill-import commit.
 *
 * Drives the REAL `runSkillImport` (stage → commit) against a REAL temp data dir
 * + REAL provenance store, then a REAL discovery pass through
 * `createSkillRegistry`, proving — with no mock store and no mock discovery:
 *   - a clean `.skill` archive installs, lists with `source: "imported"`, and
 *     carries a provenance pin whose `contentHash` re-verifies against the bytes
 *     actually on disk;
 *   - a `scripts/helper.py` and an exec-bit file in the archive are ABSENT from
 *     the live skills dir, and the pin covers ONLY the kept text (the staged tree
 *     is kept-only, so the move installs only post-filter text).
 *
 * Per CLAUDE.md, integration tests import from `dist/` (the Vitest alias) and
 * rely on `pnpm build` having run. Linux-tier: also exercise under
 * `pnpm test:integration` on Linux before merge.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runSkillImport, type SkillImportDeps, type RunSkillImportOpts } from "@comis/daemon";
import { readProvenanceStore, provenanceKey, computeInstalledSetHash, createSkillRegistry } from "@comis/skills";
import type { SkillsConfig, TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// A minimal STORE-method zip writer (real unpack path exercise; no dependency).
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
interface ZipMember {
  name: string;
  content: string;
  execBit?: boolean;
}
function makeStoreZip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const raw = Buffer.from(m.content, "utf-8");
    const nameBuf = Buffer.from(m.name, "utf-8");
    const crc = crc32(raw);
    const externalAttr = (((m.execBit === true ? 0o100755 : 0o100644) << 16) >>> 0) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method 0 = STORE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, raw);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix host
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + raw.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

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

function makeDeps(dataDir: string): SkillImportDeps {
  return {
    dataDir,
    skillsDir: join(dataDir, "skills"),
    tmpRoot: join(dataDir, "tmp"),
    logger: makeLogger(),
    caps: {
      maxArchiveBytes: 8_388_608,
      maxTotalUncompressedBytes: 67_108_864,
      maxFileBytes: 4_194_304,
      maxFileCount: 200,
      maxPathDepth: 10,
    },
    maxBodyLength: 20_000,
    osvCheckEnabled: false,
    readCurrentMcpServers: () => [],
    readInstalledBundleState: () => ({}),
    reinitRegistry: () => {},
    now: () => new Date().toISOString(),
  };
}

function opts(): RunSkillImportOpts {
  return { source: "archive", identifier: "https://example.test/skill.zip", scope: "shared", agentId: "agent-1" };
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A ground-truth imported skill.\n---\n\nInstruction body for ${name}.\n`;
}

/** Build a discovery registry over the live skills dir, stamping imported from the store. */
function discover(dataDir: string) {
  const config = {
    discoveryPaths: [join(dataDir, "skills")],
    promptSkills: { maxBodyLength: 20_000, enableDynamicContext: false, maxAutoInject: 3 },
  } as unknown as SkillsConfig;
  const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as TypedEventBus;
  const importedNames = (): ReadonlySet<string> => {
    const names = new Set<string>();
    for (const rec of Object.values(readProvenanceStore(dataDir))) {
      if (rec.scope === "shared" || (rec.scope === "local" && rec.agentId === "agent-1")) names.add(rec.name);
    }
    return names;
  };
  const registry = createSkillRegistry(config, bus, { agentId: "agent-1", tenantId: "t1", userId: "system" }, undefined, undefined, importedNames);
  registry.init();
  return registry;
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), `skill-import-e2e-${randomUUID().slice(0, 8)}-`));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skill import commit (ground truth)", () => {
  it("installs a clean .skill, lists it source:imported, and pins a disk-verifiable contentHash", async () => {
    const zip = makeStoreZip([
      { name: "myskill/SKILL.md", content: skillMd("myskill") },
      { name: "myskill/reference.md", content: "# Reference\nnotes\n" },
    ]);
    const result = await runSkillImport({ kind: "archiveBytes", base64: zip.toString("base64") }, opts(), makeDeps(dataDir));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`import failed: ${result.error.message}`);
    expect(result.value.source).toBe("imported");

    // Real discovery lists it as imported.
    const descs = discover(dataDir).getPromptSkillDescriptions();
    const desc = descs.find((d) => d.name === "myskill");
    expect(desc).toBeDefined();
    expect(desc!.source).toBe("imported");

    // The pin re-verifies against the bytes actually on disk.
    const rec = readProvenanceStore(dataDir)[provenanceKey("shared", "agent-1", "myskill")];
    expect(rec).toBeDefined();
    const liveDir = join(dataDir, "skills", "myskill");
    const onDisk = rec!.files.map((rel) => ({ relPath: rel, bytes: readFileSync(join(liveDir, rel)) }));
    expect(computeInstalledSetHash(onDisk)).toBe(rec!.contentHash);
    expect(result.value.provenanceSummary.contentHash).toBe(rec!.contentHash);
  });

  it("drops scripts/ + exec-bit files: they never reach the live dir and the pin covers kept text only", async () => {
    const zip = makeStoreZip([
      { name: "d5skill/SKILL.md", content: skillMd("d5skill") },
      { name: "d5skill/reference.md", content: "# Reference\nkept text\n" },
      { name: "d5skill/scripts/helper.py", content: "print('should be dropped')\n" },
      { name: "d5skill/run.sh", content: "#!/bin/sh\necho dropped\n", execBit: true },
    ]);
    const result = await runSkillImport({ kind: "archiveBytes", base64: zip.toString("base64") }, opts(), makeDeps(dataDir));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`import failed: ${result.error.message}`);

    const liveDir = join(dataDir, "skills", "d5skill");
    // Kept text present.
    expect(existsSync(join(liveDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(liveDir, "reference.md"))).toBe(true);
    // Dropped execution vectors ABSENT from the live dir.
    expect(existsSync(join(liveDir, "scripts", "helper.py"))).toBe(false);
    expect(existsSync(join(liveDir, "run.sh"))).toBe(false);

    // The pin covers ONLY the kept text (SKILL.md + reference.md), and re-verifies.
    const rec = readProvenanceStore(dataDir)[provenanceKey("shared", "agent-1", "d5skill")];
    expect(rec!.files.sort()).toEqual(["SKILL.md", "reference.md"]);
    const onDisk = rec!.files.map((rel) => ({ relPath: rel, bytes: readFileSync(join(liveDir, rel)) }));
    expect(computeInstalledSetHash(onDisk)).toBe(rec!.contentHash);
    // Sanity: the hash is NOT over a set that included the dropped files.
    const withDropped = [
      ...onDisk,
      { relPath: "scripts/helper.py", bytes: Buffer.from("print('should be dropped')\n") },
    ];
    expect(computeInstalledSetHash(withDropped)).not.toBe(rec!.contentHash);
  });
});
