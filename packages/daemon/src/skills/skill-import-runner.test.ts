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
import { ok } from "@comis/shared";
import { writeProvenanceRecord, type ProvenanceRecord, type WellKnownResolveDeps } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import { enrichWithProvenanceSummary, resolveWellKnownFileSet } from "./skill-import-runner.js";
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
// resolveWellKnownFileSet — the fail-closed registry allowlist gate (WK-02).
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
