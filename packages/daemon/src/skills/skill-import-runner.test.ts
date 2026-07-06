// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the provenance-summary enrichment the skills-list surface
 * uses. A listed skill that has an import record gains a content-free summary
 * (acquisition channel + hash prefix + import timestamp, plus — for a
 * registry-sourced import — the recorded registry origin); a skill with no
 * record is returned unchanged.
 *
 * Drives the REAL provenance store against a temp data dir (no store mock) so
 * the summary reflects what actually round-trips to disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { ok } from "@comis/shared";
import {
  writeProvenanceRecord,
  computeInstalledSetHash,
  readProvenanceStore,
  provenanceKey,
  type ProvenanceRecord,
  type WellKnownResolveDeps,
} from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import {
  enrichWithProvenanceSummary,
  resolveWellKnownFileSet,
  resolveClawHubFileSet,
  importThroughPipeline,
} from "./skill-import-runner.js";
import type { WorkspaceApiDeps } from "../api/types.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), `skill-import-runner-${randomUUID().slice(0, 8)}-`));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    name: "demo-skill",
    scope: "local",
    agentId: "alice",
    source: "archive",
    identifier: "https://example.invalid/demo.skill",
    contentHash: "0".repeat(64),
    scanVerdict: { clean: true, findingCount: 0 },
    files: ["SKILL.md"],
    importedAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    importedBy: "alice",
    ...overrides,
  };
}

describe("enrichWithProvenanceSummary — registry origin on the list summary", () => {
  it("surfaces provenanceSummary.registry for a record that records one", async () => {
    await writeProvenanceRecord(
      dataDir,
      makeRecord({ name: "reg-skill", source: "wellknown", registry: "https://reg.example" }),
    );
    const [entry] = enrichWithProvenanceSummary([{ name: "reg-skill" }], dataDir, "alice");
    expect(entry?.provenanceSummary?.registry).toBe("https://reg.example");
    expect(entry?.provenanceSummary?.source).toBe("wellknown");
  });

  it("omits provenanceSummary.registry for a record that has none (archive/github)", async () => {
    await writeProvenanceRecord(dataDir, makeRecord({ name: "plain-skill", source: "archive" }));
    const [entry] = enrichWithProvenanceSummary([{ name: "plain-skill" }], dataDir, "alice");
    expect(entry?.provenanceSummary).toBeDefined();
    expect(entry?.provenanceSummary?.registry).toBeUndefined();
  });

  it("returns a skill with no import record unchanged (no provenanceSummary attached)", () => {
    const [entry] = enrichWithProvenanceSummary([{ name: "unrecorded" }], dataDir, "alice");
    expect(entry?.provenanceSummary).toBeUndefined();
  });
});

// ===========================================================================
// resolveWellKnownFileSet — the fail-closed registry allowlist gate.
//
// The gate is the access-control choke point: the requested registry origin must
// be a member of the caps-owning agent's skills.import.registries (a shared
// import reads the DEFAULT agent's list). A non-member refuses FLATLY — a config
// edit, never confirm-overridable — BEFORE the resolver issues any network fetch,
// so the injected validate/fetch seams stay untouched on the refuse path.
//
// Fixture bytes are defined inline (no cross-package fixture import); the
// validate/fetch seams are injected spies.
// ===========================================================================

/** A minimal spec-pure SKILL.md the resolver returns as the manifest. */
const WK_SKILL_MD =
  "---\nname: pdf-extractor\ndescription: Extract text from PDF files.\n---\n\nExtract text from PDFs.\n";
const WK_INDEX = {
  skills: [{ name: "pdf-extractor", description: "Extract text from PDF files.", files: ["SKILL.md"] }],
};
const WK_REGISTRY = "https://reg.example";
const WK_INDEX_URL = `${WK_REGISTRY}/.well-known/skills/index.json`;
const WK_FILE_URL = `${WK_REGISTRY}/.well-known/skills/pdf-extractor/SKILL.md`;

type WkValidate = NonNullable<WellKnownResolveDeps["validate"]>;
type WkFetch = NonNullable<WellKnownResolveDeps["fetchImpl"]>;

/** A single-chunk web-stream body the resolver's capped reader consumes. */
function wkStream(bytes: Uint8Array) {
  let done = false;
  return {
    getReader() {
      return {
        async read() {
          if (done) return { done: true as const, value: undefined };
          done = true;
          return { done: false as const, value: bytes };
        },
        async cancel() {
          done = true;
        },
      };
    },
    async cancel() {
      done = true;
    },
  };
}

/** A by-URL fetch spy serving a text body per URL; an unmapped URL 404s. */
function wkServingFetch(byUrl: Record<string, string>) {
  return vi.fn(async (url: string, _ip?: string, _init?: unknown) => {
    const body = byUrl[url];
    if (body === undefined) {
      return { ok: false as const, status: 404, headers: { get: (): string | null => null }, body: null };
    }
    const bytes = new TextEncoder().encode(body);
    return { ok: true as const, status: 200, headers: { get: (): string | null => null }, body: wkStream(bytes) };
  });
}

/** A no-op index cache so a gate-unit test never touches disk. */
const wkNoCache = { get: () => undefined, put: () => {} };

/** A permissive SSRF validator (the fixtures are off-network). */
const wkValidateOk: WkValidate = async () => ok({ hostname: "reg.example", ip: "203.0.113.10" });

function makeWkLogger(): ComisLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

function makeWkDeps(o: {
  registriesByAgent?: Record<string, string[]>;
  defaultAgentId?: string;
}): WorkspaceApiDeps {
  const agents: Record<string, unknown> = {};
  for (const [agentId, registries] of Object.entries(o.registriesByAgent ?? {})) {
    agents[agentId] = {
      skills: {
        import: {
          registries,
          maxFileCount: 200,
          maxFileBytes: 4_194_304,
          maxArchiveBytes: 8_388_608,
          maxTotalUncompressedBytes: 67_108_864,
          maxPathDepth: 10,
        },
      },
    };
  }
  return {
    agents,
    defaultAgentId: o.defaultAgentId ?? "default-agent",
    logger: makeWkLogger(),
    container: { config: { dataDir } },
  } as unknown as WorkspaceApiDeps;
}

describe("resolveWellKnownFileSet — fail-closed allowlist gate (before any fetch)", () => {
  it("refuses a non-allowlisted registry FLATLY, naming skills.import.registries, WITHOUT fetching", async () => {
    const validate: WkValidate = vi.fn(async () => ok({ hostname: "reg.example", ip: "203.0.113.10" }));
    const fetchImpl = wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: WK_SKILL_MD });
    const deps = makeWkDeps({ registriesByAgent: { "agent-a": [] } });
    const result = await resolveWellKnownFileSet(deps, {
      registry: "https://evil.example",
      name: "pdf-extractor",
      scope: "local",
      agentId: "agent-a",
      overrides: { validate, fetchImpl: fetchImpl as unknown as WkFetch },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message + result.error.hint).toContain("skills.import.registries");
    // The gate ran BEFORE the resolver: neither seam was touched.
    expect(validate).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the allowlist is populated but omits the requested origin (no fetch)", async () => {
    const validate: WkValidate = vi.fn(async () => ok({ hostname: "reg.example", ip: "203.0.113.10" }));
    const fetchImpl = wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: WK_SKILL_MD });
    const deps = makeWkDeps({ registriesByAgent: { "agent-a": ["https://other.example"] } });
    const result = await resolveWellKnownFileSet(deps, {
      registry: WK_REGISTRY,
      name: "pdf-extractor",
      scope: "local",
      agentId: "agent-a",
      overrides: { validate, fetchImpl: fetchImpl as unknown as WkFetch },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message + result.error.hint).toContain("skills.import.registries");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves an allowlisted registry to its SKILL.md-bearing file set + stable identifier", async () => {
    const validate: WkValidate = vi.fn(async () => ok({ hostname: "reg.example", ip: "203.0.113.10" }));
    const fetchImpl = wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: WK_SKILL_MD });
    const deps = makeWkDeps({ registriesByAgent: { "agent-a": [WK_REGISTRY] } });
    const result = await resolveWellKnownFileSet(deps, {
      registry: WK_REGISTRY,
      name: "pdf-extractor",
      scope: "local",
      agentId: "agent-a",
      overrides: { validate, fetchImpl: fetchImpl as unknown as WkFetch, cache: wkNoCache },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registryOrigin).toBe(WK_REGISTRY);
    expect(result.value.identifier).toBe("https://reg.example/.well-known/skills/pdf-extractor/");
    expect(result.value.files.some((f) => f.path === "SKILL.md")).toBe(true);
  });

  it("reads the DEFAULT agent's registries for a shared import, not the caller's", async () => {
    const validate: WkValidate = vi.fn(async () => ok({ hostname: "reg.example", ip: "203.0.113.10" }));
    const fetchImpl = wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: WK_SKILL_MD });
    // The default agent is allowlisted; the caller ("other-agent") is NOT.
    const deps = makeWkDeps({
      registriesByAgent: { "default-agent": [WK_REGISTRY], "other-agent": [] },
      defaultAgentId: "default-agent",
    });
    // A shared import by the caller resolves via the DEFAULT agent's list.
    const shared = await resolveWellKnownFileSet(deps, {
      registry: WK_REGISTRY,
      name: "pdf-extractor",
      scope: "shared",
      agentId: "other-agent",
      overrides: { validate, fetchImpl: fetchImpl as unknown as WkFetch, cache: wkNoCache },
    });
    expect(shared.ok).toBe(true);
    // A LOCAL import by the same caller reads the caller's (empty) list ⇒ refuses.
    const local = await resolveWellKnownFileSet(deps, {
      registry: WK_REGISTRY,
      name: "pdf-extractor",
      scope: "local",
      agentId: "other-agent",
      overrides: { validate, fetchImpl: fetchImpl as unknown as WkFetch },
    });
    expect(local.ok).toBe(false);
  });

  it("normalizes origins (case-insensitive host) and never matches the clawhub token to an http request", async () => {
    const validate: WkValidate = vi.fn(async () => ok({ hostname: "reg.example", ip: "203.0.113.10" }));
    // A mixed-case allowlist host matches the same requested origin (both new URL().origin).
    const matches = await resolveWellKnownFileSet(
      makeWkDeps({ registriesByAgent: { "agent-a": ["https://Reg.Example"] } }),
      {
        registry: WK_REGISTRY,
        name: "pdf-extractor",
        scope: "local",
        agentId: "agent-a",
        overrides: {
          validate,
          fetchImpl: wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: WK_SKILL_MD }) as unknown as WkFetch,
          cache: wkNoCache,
        },
      },
    );
    expect(matches.ok).toBe(true);
    // A clawhub-only allowlist does NOT satisfy an http-origin request (Phase 235 owns clawhub).
    const clawhubOnly = await resolveWellKnownFileSet(
      makeWkDeps({ registriesByAgent: { "agent-a": ["clawhub"] } }),
      {
        registry: WK_REGISTRY,
        name: "pdf-extractor",
        scope: "local",
        agentId: "agent-a",
        overrides: {
          validate,
          fetchImpl: wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: WK_SKILL_MD }) as unknown as WkFetch,
        },
      },
    );
    expect(clawhubOnly.ok).toBe(false);
  });
});

// ===========================================================================
// Ground truth (I9): an allowlisted fixture resolve → the REAL runSkillImport →
// the REAL provenance store. The registry origin + the stable per-(registry,name)
// identifier land in the pin, and a changed-bytes re-import obeys PROV-04 over a
// registry source (the stable identifier routes it to the divergence-confirm, not
// a foreign flat-refuse). No mock — the fixture bytes enter through the resolver's
// injected fetch seam; the pipeline + store are real.
// ===========================================================================

describe("resolveWellKnownFileSet → real runSkillImport (ground truth + PROV-04 over a registry)", () => {
  /** Resolve a fixture skill (off-network) and drive it through the real pipeline. */
  async function installWellKnown(deps: WorkspaceApiDeps, body: string, confirm?: boolean) {
    const md = `---\nname: pdf-extractor\ndescription: Extract text from PDF files.\n---\n\n${body}\n`;
    const fetchImpl = wkServingFetch({ [WK_INDEX_URL]: JSON.stringify(WK_INDEX), [WK_FILE_URL]: md });
    const resolved = await resolveWellKnownFileSet(deps, {
      registry: WK_REGISTRY,
      name: "pdf-extractor",
      scope: "local",
      agentId: "agent-a",
      overrides: { validate: wkValidateOk, fetchImpl: fetchImpl as unknown as WkFetch, cache: wkNoCache },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error.message}`);
    return importThroughPipeline(deps, {
      acquireInput: { kind: "fileSet", files: resolved.value.files },
      source: "wellknown",
      identifier: resolved.value.identifier,
      registry: resolved.value.registryOrigin,
      scope: "local",
      agentId: "agent-a",
      skillsDir: join(dataDir, "skills"),
      ...(confirm !== undefined && { confirm }),
      ctx: undefined,
    });
  }

  it("installs source:imported with the registry + stable identifier pinned over the INSTALLED set", async () => {
    const deps = makeWkDeps({ registriesByAgent: { "agent-a": [WK_REGISTRY] } });
    const imported = await installWellKnown(deps, "Extract text from PDFs.");
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.commit.source).toBe("imported");
    const rec = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")];
    expect(rec?.source).toBe("wellknown");
    expect(rec?.registry).toBe(WK_REGISTRY);
    expect(rec?.identifier).toBe("https://reg.example/.well-known/skills/pdf-extractor/");
    // The pin's contentHash is over the ACTUAL on-disk installed set (ground truth).
    const installedMd = readFileSync(join(dataDir, "skills", "pdf-extractor", "SKILL.md"), "utf-8");
    const expectedHash = computeInstalledSetHash([{ relPath: "SKILL.md", bytes: Buffer.from(installedMd, "utf-8") }]);
    expect(rec?.contentHash).toBe(expectedHash);
    // The list surface (skills.list enrichment) shows source + the registry.
    const [entry] = enrichWithProvenanceSummary([{ name: "pdf-extractor" }], dataDir, "agent-a");
    expect(entry?.provenanceSummary?.source).toBe("wellknown");
    expect(entry?.provenanceSummary?.registry).toBe(WK_REGISTRY);
  });

  it("PROV-04: a changed-bytes re-import refuses without confirm, then swaps + re-pins with it", async () => {
    const deps = makeWkDeps({ registriesByAgent: { "agent-a": [WK_REGISTRY] } });
    const first = await installWellKnown(deps, "Extract text from PDFs.");
    expect(first.ok).toBe(true);
    const rec1 = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")];
    // The SAME (registry, name) ⇒ the SAME identifier; the changed body ⇒ a
    // divergent installed hash ⇒ the provenance-matched divergence-confirm.
    const noConfirm = await installWellKnown(deps, "Extract text from PDF files — revised body.");
    expect(noConfirm.ok).toBe(false);
    if (noConfirm.ok) return;
    expect(noConfirm.error.needsConfirm).toBe(true);
    // A refused re-import leaves the pin untouched.
    const recMid = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")];
    expect(recMid?.contentHash).toBe(rec1?.contentHash);
    // With confirm ⇒ swap + re-pin: the registry is retained, importedAt is
    // preserved, and the contentHash advances to the new installed set.
    const withConfirm = await installWellKnown(deps, "Extract text from PDF files — revised body.", true);
    expect(withConfirm.ok).toBe(true);
    const rec2 = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")];
    expect(rec2?.registry).toBe(WK_REGISTRY);
    expect(rec2?.importedAt).toBe(rec1?.importedAt);
    expect(rec2?.contentHash).not.toBe(rec1?.contentHash);
  });
});

// ===========================================================================
// resolveClawHubFileSet — the clawhub fail-closed allowlist gate + the
// install-resolver → archive-bytes → real pipeline ground truth (I9).
//
// The `clawhub` token is recognized VERBATIM by the shipped registry gate, so a
// `registries:["clawhub"]` allowlist enables clawhub imports; an allowlist that
// omits it refuses FLATLY before any fetch (the injected SSRF seams stay
// untouched — the gate has NO confirm parameter to override). On pass, the
// resolver's release bytes enter the SAME staged pipeline as every other source;
// officialPublisher + requireOfficialPublisher thread through to the two-warnable-
// classes commit collector, and the pin is computed over the on-disk installed set.
//
// The resolver's SSRF seams share ArchiveUrlValidator/PinnedArchiveFetch with the
// well-known resolver (both funnel through the same pinned-fetch primitives), so
// the well-known seam aliases type the injected clawhub spies too.
// ===========================================================================

type ChValidate = WkValidate;
type ChFetch = WkFetch;

const CH_OWNER = "acme";
const CH_SLUG = "pdf-extractor";
const CH_NAME = `@${CH_OWNER}/${CH_SLUG}`;
const CH_VERSION = "1.0.0";
const CH_DOWNLOAD_URL = "https://cdn.clawhub.ai/artifacts/pdf-extractor/1.0.0/release.zip";
const CH_INSTALL_URL = `https://clawhub.ai/api/v1/skills/${CH_SLUG}/install?ownerHandle=${CH_OWNER}`;
const CH_VERIFY_URL = `https://clawhub.ai/api/v1/skills/${CH_SLUG}/verify?version=${CH_VERSION}`;
const CH_SKILL_MD =
  "---\nname: pdf-extractor\ndescription: Extract text from PDF files.\n---\n\nExtract text from PDFs.\n";

/**
 * Build a standards-valid single-entry STORED zip (local file header + central
 * directory + EOCD) so the resolver's returned bytes unpack to a real SKILL.md
 * on disk. `Buffer.alloc` zero-fills the header fields the reader tolerates as 0
 * (version-made-by, flags, mod time/date, extra/comment lengths, external attrs).
 */
function makeStoredZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, "utf-8");
  const data = Buffer.from(content, "utf-8");
  const crc = crc32(data) >>> 0;
  const size = data.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 8); // compression method: stored
  local.writeUInt32LE(crc, 14); // crc32
  local.writeUInt32LE(size, 18); // compressed size
  local.writeUInt32LE(size, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26); // filename length
  const localHeader = Buffer.concat([local, nameBuf, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 10); // compression method: stored
  central.writeUInt32LE(crc, 16); // crc32
  central.writeUInt32LE(size, 20); // compressed size
  central.writeUInt32LE(size, 24); // uncompressed size
  central.writeUInt16LE(nameBuf.length, 28); // filename length
  central.writeUInt32LE(0, 42); // local header offset
  const centralHeader = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(1, 8); // central-dir records on this disk
  eocd.writeUInt16LE(1, 10); // total central-dir records
  eocd.writeUInt32LE(centralHeader.length, 12); // central-dir size
  eocd.writeUInt32LE(localHeader.length, 16); // central-dir offset
  return Buffer.concat([localHeader, centralHeader, eocd]);
}

/** A well-formed official install decision resolving to the release archive. */
function chInstallOfficial(): Record<string, unknown> {
  return {
    ok: true,
    slug: CH_SLUG,
    channel: "official",
    isOfficial: true,
    installKind: "archive",
    archive: { version: CH_VERSION, downloadUrl: CH_DOWNLOAD_URL, channel: "official", isOfficial: true },
  };
}

/** A non-official (community channel) install decision — resolves, records officialPublisher:false. */
function chInstallNonOfficial(): Record<string, unknown> {
  return {
    ok: true,
    slug: CH_SLUG,
    channel: "community",
    isOfficial: false,
    installKind: "archive",
    archive: { version: CH_VERSION, downloadUrl: CH_DOWNLOAD_URL, channel: "community", isOfficial: false },
  };
}

const CH_VERIFY_CLEAN = {
  ok: true,
  decision: "pass",
  reasons: [] as string[],
  security: { scanStatus: "clean", moderationState: "approved", blockedFromDownload: false },
};
const CH_VERIFY_MALICIOUS = {
  ok: false,
  decision: "fail",
  reasons: [] as string[],
  security: { scanStatus: "malicious", moderationState: "approved", blockedFromDownload: false },
};

/** A single-chunk web-stream body over a Buffer (Buffer is a Uint8Array). */
function chStream(bytes: Uint8Array) {
  let done = false;
  return {
    getReader() {
      return {
        async read() {
          if (done) return { done: true as const, value: undefined };
          done = true;
          return { done: false as const, value: bytes };
        },
        async cancel() {
          done = true;
        },
      };
    },
    async cancel() {
      done = true;
    },
  };
}

/** A by-URL fetch spy serving JSON (install/verify) or raw bytes (artifact); unmapped ⇒ 404. */
function chServingFetch(byUrl: Record<string, { json?: unknown; bytes?: Buffer }>) {
  return vi.fn(async (url: string, _ip?: string, _init?: unknown) => {
    const entry = byUrl[url];
    if (entry === undefined) {
      return { ok: false as const, status: 404, headers: { get: (): string | null => null }, body: null };
    }
    const payload = entry.bytes ?? new TextEncoder().encode(JSON.stringify(entry.json));
    return { ok: true as const, status: 200, headers: { get: (): string | null => null }, body: chStream(payload) };
  });
}

/** A permissive SSRF validator (the fixtures are off-network). */
const chValidateOk: ChValidate = async () => ok({ hostname: "clawhub.ai", ip: "203.0.113.20" });

function makeChDeps(o: {
  registriesByAgent?: Record<string, string[]>;
  requireOfficialPublisher?: boolean;
  defaultAgentId?: string;
}): WorkspaceApiDeps {
  const agents: Record<string, unknown> = {};
  for (const [agentId, registries] of Object.entries(o.registriesByAgent ?? {})) {
    agents[agentId] = {
      skills: {
        import: {
          registries,
          maxFileCount: 200,
          maxFileBytes: 4_194_304,
          maxArchiveBytes: 8_388_608,
          maxTotalUncompressedBytes: 67_108_864,
          maxPathDepth: 10,
          ...(o.requireOfficialPublisher !== undefined && { requireOfficialPublisher: o.requireOfficialPublisher }),
        },
      },
    };
  }
  return {
    agents,
    defaultAgentId: o.defaultAgentId ?? "default-agent",
    logger: makeWkLogger(),
    container: { config: { dataDir } },
  } as unknown as WorkspaceApiDeps;
}

describe("resolveClawHubFileSet — fail-closed clawhub allowlist gate (before any fetch)", () => {
  it("refuses a non-allowlisted clawhub import FLATLY, naming skills.import.registries, WITHOUT fetching", async () => {
    const validate = vi.fn(chValidateOk);
    const fetchImpl = chServingFetch({ [CH_INSTALL_URL]: { json: chInstallOfficial() } });
    const deps = makeChDeps({ registriesByAgent: { "agent-a": [] } });
    const result = await resolveClawHubFileSet(deps, {
      name: CH_NAME,
      scope: "local",
      agentId: "agent-a",
      overrides: { validate, fetchImpl: fetchImpl as unknown as ChFetch },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(result.error.message + result.error.hint).toContain("skills.import.registries");
    // The gate ran BEFORE the resolver: neither SSRF seam was touched.
    expect(validate).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the allowlist is populated but omits the clawhub token (no fetch)", async () => {
    const validate = vi.fn(chValidateOk);
    const fetchImpl = chServingFetch({ [CH_INSTALL_URL]: { json: chInstallOfficial() } });
    const deps = makeChDeps({ registriesByAgent: { "agent-a": ["https://reg.example"] } });
    const result = await resolveClawHubFileSet(deps, {
      name: CH_NAME,
      scope: "local",
      agentId: "agent-a",
      overrides: { validate, fetchImpl: fetchImpl as unknown as ChFetch },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message + result.error.hint).toContain("skills.import.registries");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the DEFAULT agent's registries for a shared clawhub import, not the caller's", async () => {
    const fetchImpl = chServingFetch({
      [CH_INSTALL_URL]: { json: chInstallOfficial() },
      [CH_VERIFY_URL]: { json: CH_VERIFY_CLEAN },
      [CH_DOWNLOAD_URL]: { bytes: makeStoredZip("SKILL.md", CH_SKILL_MD) },
    });
    // The default agent is allowlisted for clawhub; the caller ("other-agent") is NOT.
    const deps = makeChDeps({
      registriesByAgent: { "default-agent": ["clawhub"], "other-agent": [] },
      defaultAgentId: "default-agent",
    });
    // A LOCAL import by the caller reads the caller's (empty) list ⇒ refuses (no fetch).
    const local = await resolveClawHubFileSet(deps, {
      name: CH_NAME,
      scope: "local",
      agentId: "other-agent",
      overrides: { validate: chValidateOk, fetchImpl: fetchImpl as unknown as ChFetch },
    });
    expect(local.ok).toBe(false);
    // A SHARED import resolves via the DEFAULT agent's (allowlisted) list.
    const shared = await resolveClawHubFileSet(deps, {
      name: CH_NAME,
      scope: "shared",
      agentId: "other-agent",
      overrides: { validate: chValidateOk, fetchImpl: fetchImpl as unknown as ChFetch },
    });
    expect(shared.ok).toBe(true);
  });
});

describe("resolveClawHubFileSet → real runSkillImport (I9 ground truth + two-warnable-classes)", () => {
  /** Resolve a fixture clawhub skill (off-network) and drive its bytes through the real pipeline. */
  async function installClawHub(
    deps: WorkspaceApiDeps,
    opts: { install?: unknown; verify?: unknown; body?: string; confirm?: boolean } = {},
  ) {
    const md =
      opts.body !== undefined
        ? `---\nname: pdf-extractor\ndescription: Extract text from PDF files.\n---\n\n${opts.body}\n`
        : CH_SKILL_MD;
    const fetchImpl = chServingFetch({
      [CH_INSTALL_URL]: { json: opts.install ?? chInstallOfficial() },
      [CH_VERIFY_URL]: { json: opts.verify ?? CH_VERIFY_CLEAN },
      [CH_DOWNLOAD_URL]: { bytes: makeStoredZip("SKILL.md", md) },
    });
    const resolved = await resolveClawHubFileSet(deps, {
      name: CH_NAME,
      scope: "local",
      agentId: "agent-a",
      overrides: { validate: chValidateOk, fetchImpl: fetchImpl as unknown as ChFetch },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(`clawhub resolve failed: ${resolved.error.message}`);
    return importThroughPipeline(deps, {
      acquireInput: { kind: "archiveBytes", base64: resolved.value.archiveBytes },
      source: "clawhub",
      identifier: resolved.value.identifier,
      registry: "clawhub",
      officialPublisher: resolved.value.officialPublisher,
      requireOfficialPublisher: resolved.value.requireOfficialPublisher,
      scope: "local",
      agentId: "agent-a",
      skillsDir: join(dataDir, "skills"),
      ...(opts.confirm !== undefined && { confirm: opts.confirm }),
      ctx: undefined,
    });
  }

  it("installs source:imported with registry:clawhub + officialPublisher pinned over the INSTALLED set", async () => {
    const deps = makeChDeps({ registriesByAgent: { "agent-a": ["clawhub"] } });
    const imported = await installClawHub(deps);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.commit.source).toBe("imported");
    const rec = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")];
    // Ground truth: the REAL store carries clawhub as the acquisition channel, the
    // clawhub registry token, the stable @owner/slug identifier, and the publisher signal.
    expect(rec?.source).toBe("clawhub");
    expect(rec?.registry).toBe("clawhub");
    expect(rec?.officialPublisher).toBe(true);
    expect(rec?.identifier).toBe(CH_NAME);
    // The pin's contentHash is over the ACTUAL on-disk installed set.
    const installedMd = readFileSync(join(dataDir, "skills", "pdf-extractor", "SKILL.md"), "utf-8");
    expect(rec?.contentHash).toBe(
      computeInstalledSetHash([{ relPath: "SKILL.md", bytes: Buffer.from(installedMd, "utf-8") }]),
    );
    // The list surface (skills.list enrichment) shows source + the officialPublisher signal.
    const [entry] = enrichWithProvenanceSummary([{ name: "pdf-extractor" }], dataDir, "agent-a");
    expect(entry?.provenanceSummary?.source).toBe("clawhub");
    expect(entry?.provenanceSummary?.officialPublisher).toBe(true);
  });

  it("a blocked verdict refuses regardless of confirm (the resolver blocks pre-download)", async () => {
    const deps = makeChDeps({ registriesByAgent: { "agent-a": ["clawhub"] } });
    const fetchImpl = chServingFetch({
      [CH_INSTALL_URL]: { json: chInstallOfficial() },
      [CH_VERIFY_URL]: { json: CH_VERIFY_MALICIOUS },
      [CH_DOWNLOAD_URL]: { bytes: makeStoredZip("SKILL.md", CH_SKILL_MD) },
    });
    const resolved = await resolveClawHubFileSet(deps, {
      name: CH_NAME,
      scope: "local",
      agentId: "agent-a",
      overrides: { validate: chValidateOk, fetchImpl: fetchImpl as unknown as ChFetch },
    });
    // The block lives INSIDE the resolver (no confirm parameter), so it can never
    // reach the commit's confirm branch — a blocked release refuses for all confirm.
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.errorKind).toBe("precondition");
    // Verdict-refuse-before-download: the artifact URL was never fetched.
    expect(fetchImpl).not.toHaveBeenCalledWith(CH_DOWNLOAD_URL, expect.anything(), expect.anything());
    // Nothing landed in the store.
    expect(readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")]).toBeUndefined();
  });

  it("a non-official publisher needs confirm (enumerated) and records officialPublisher:false with confirm", async () => {
    const deps = makeChDeps({ registriesByAgent: { "agent-a": ["clawhub"] } });
    // requireOfficialPublisher defaults true ⇒ the non-official publisher is a warnable class.
    const noConfirm = await installClawHub(deps, { install: chInstallNonOfficial() });
    expect(noConfirm.ok).toBe(false);
    if (noConfirm.ok) return;
    expect(noConfirm.error.needsConfirm).toBe(true);
    expect(noConfirm.error.warnings?.some((w) => /not official/i.test(w))).toBe(true);
    // With confirm ⇒ installs, and the record pins officialPublisher:false.
    const withConfirm = await installClawHub(deps, { install: chInstallNonOfficial(), confirm: true });
    expect(withConfirm.ok).toBe(true);
    const rec = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "pdf-extractor")];
    expect(rec?.officialPublisher).toBe(false);
    expect(rec?.registry).toBe("clawhub");
  });

  it("folds BOTH warnable classes (non-official + pin-divergence) into ONE confirm enumerating each", async () => {
    const deps = makeChDeps({ registriesByAgent: { "agent-a": ["clawhub"] } });
    // Install a non-official skill first (confirm acknowledges the non-official class).
    const first = await installClawHub(deps, { install: chInstallNonOfficial(), confirm: true });
    expect(first.ok).toBe(true);
    // A changed-bytes re-import: still non-official AND now pin-divergent ⇒ 2 classes.
    const noConfirm = await installClawHub(deps, { install: chInstallNonOfficial(), body: "Revised extraction body." });
    expect(noConfirm.ok).toBe(false);
    if (noConfirm.ok) return;
    expect(noConfirm.error.needsConfirm).toBe(true);
    expect(noConfirm.error.warnings?.length).toBe(2);
    expect(noConfirm.error.warnings?.some((w) => /not official/i.test(w))).toBe(true);
    expect(noConfirm.error.warnings?.some((w) => /pinned content hash|diverges/i.test(w))).toBe(true);
    // ONE confirm covers BOTH classes.
    const withConfirm = await installClawHub(deps, {
      install: chInstallNonOfficial(),
      body: "Revised extraction body.",
      confirm: true,
    });
    expect(withConfirm.ok).toBe(true);
    if (!withConfirm.ok) return;
    expect(withConfirm.value.commit.acknowledgedWarnings?.length).toBe(2);
  });
});
