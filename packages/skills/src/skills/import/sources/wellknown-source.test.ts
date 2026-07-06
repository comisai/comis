// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary suite for the well-known registry resolver. Every fetch (the index
 * AND each file) must go through the injected SSRF-validate + pinned-fetch
 * seams; a blocked host rejects before a connection opens. The index shape is
 * Zod-validated (additive fields tolerated, drift fails loud naming the
 * registry), the requested skill is looked up, and EVERY advertised path is
 * validated before any file is fetched — one unsafe path rejects the whole
 * bundle. The index metadata may be served from an injected cache; every file
 * is always re-fetched.
 *
 * Fixtures only — no live registry is ever contacted. The validate/fetch/cache
 * seams are injected spies; a non-network reject must leave the fetch spy
 * untouched.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { resolveWellKnown } from "./wellknown-source.js";
import type {
  ArchiveHttpResponse,
  ArchiveResponseBody,
  ArchiveUrlValidator,
} from "../acquire.js";
import type { SkillIndexCache } from "../skill-index-cache.js";
import * as F from "../test-fixtures/wellknown-index.js";

// ---------------------------------------------------------------------------
// Response + seam stubs (a minimal web-stream body the capped reader consumes)
// ---------------------------------------------------------------------------

function streamOf(chunks: readonly Uint8Array[]): ArchiveResponseBody {
  let index = 0;
  let cancelled = false;
  return {
    getReader() {
      return {
        async read() {
          if (cancelled || index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++]! };
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
    async cancel() {
      cancelled = true;
    },
  };
}

function stubResponse(opts: {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  body?: string;
  noBody?: boolean;
}): ArchiveHttpResponse {
  const headers = new Map<string, string>();
  if (opts.contentLength != null) headers.set("content-length", opts.contentLength);
  const chunks = opts.body !== undefined ? [new TextEncoder().encode(opts.body)] : [];
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: opts.noBody === true ? null : streamOf(chunks),
  };
}

/** A fetch spy that serves a body per URL; an unmapped URL 404s. */
function servingFetch(byUrl: Record<string, string>) {
  return vi.fn(async (url: string, _ip: string, _init?: unknown): Promise<ArchiveHttpResponse> => {
    const body = byUrl[url];
    if (body === undefined) return stubResponse({ ok: false, status: 404 });
    return stubResponse({ body });
  });
}

const okValidate: ArchiveUrlValidator = vi.fn(async () => ok({ hostname: "reg.example", ip: "203.0.113.10" }));

const REGISTRY = "https://reg.example";
const INDEX_URL = `${REGISTRY}/.well-known/skills/index.json`;
const fileUrl = (name: string, rel: string): string => `${REGISTRY}/.well-known/skills/${name}/${rel}`;
const CAPS = { maxFileCount: 200, maxFileBytes: 4_194_304 };

// ---------------------------------------------------------------------------
// Index resolution: SSRF pin, shape validation, name lookup, per-path reject
// ---------------------------------------------------------------------------

describe("resolveWellKnown — index resolution + SSRF + shape validation", () => {
  it("rejects a blocked index host through the SSRF guard WITHOUT fetching", async () => {
    const validate: ArchiveUrlValidator = vi.fn(async () => err(new Error("blocked: loopback range")));
    const fetchImpl = servingFetch({});
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(validate).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid (non-http) registry naming the registry, without fetching", async () => {
    const fetchImpl = servingFetch({});
    const result = await resolveWellKnown(
      { registry: "not a url", name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message).toContain("not a url");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loud when the index is missing the skills array, naming the registry", async () => {
    const fetchImpl = servingFetch({ [INDEX_URL]: JSON.stringify(F.FIXTURE_SHAPE_DRIFT_INDEX) });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain(REGISTRY);
  });

  it("fails loud when the index skills field is the wrong type", async () => {
    const fetchImpl = servingFetch({ [INDEX_URL]: JSON.stringify(F.FIXTURE_SHAPE_DRIFT_WRONG_TYPE_INDEX) });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain(REGISTRY);
  });

  it("fails loud when the index is not valid JSON", async () => {
    const fetchImpl = servingFetch({ [INDEX_URL]: "{ not json" });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain(REGISTRY);
  });

  it("tolerates additive unknown fields and resolves successfully", async () => {
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(F.FIXTURE_ADDITIVE_FIELD_INDEX),
      [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registryOrigin).toBe(REGISTRY);
    expect(result.value.files.some((f) => f.path === "SKILL.md")).toBe(true);
  });

  it("rejects a name the index does not advertise, naming the registry", async () => {
    const fetchImpl = servingFetch({ [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX) });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "does-not-exist" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain(REGISTRY);
    expect(result.error.message).toContain("does-not-exist");
  });

  it("rejects the WHOLE bundle on one unsafe advertised path, BEFORE any file fetch", async () => {
    const fetchImpl = servingFetch({ [INDEX_URL]: JSON.stringify(F.FIXTURE_PATH_ESCAPE_INDEX) });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "path-escape" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain(REGISTRY);
    // Only the index was fetched; no file URL was ever requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(INDEX_URL);
  });
});

// ---------------------------------------------------------------------------
// Index cache seam: hit short-circuits the index fetch; miss stores names+paths
// ---------------------------------------------------------------------------

describe("resolveWellKnown — index cache seam", () => {
  it("uses a cache hit and does NOT fetch the index (files are still fetched)", async () => {
    // Serve ONLY the file — if the resolver tried to fetch the index it would 404.
    const fetchImpl = servingFetch({
      [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
    });
    const cache: SkillIndexCache = {
      get: vi.fn(() => [{ name: "pdf-extractor", files: ["SKILL.md"] }]),
      put: vi.fn(),
    };
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl, cache },
    );
    expect(result.ok).toBe(true);
    expect(cache.get).toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    for (const call of fetchImpl.mock.calls) expect(call[0]).not.toBe(INDEX_URL);
  });

  it("fetches the index on a cache miss and stores names+paths only", async () => {
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX),
      [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
      [fileUrl("pdf-extractor", "references/notes.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/references/notes.md"]!,
    });
    const cache: SkillIndexCache = { get: vi.fn(() => undefined), put: vi.fn() };
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl, cache },
    );
    expect(result.ok).toBe(true);
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const putEntries = (cache.put as ReturnType<typeof vi.fn>).mock.calls[0]![1] as ReadonlyArray<{ name: string }>;
    expect(putEntries.map((e) => e.name)).toEqual(["pdf-extractor", "csv-summarizer"]);
  });
});

// ---------------------------------------------------------------------------
// Bundle fetch: bound the fan-out, cap each file, require the manifest
// ---------------------------------------------------------------------------

describe("resolveWellKnown — bundle fetch bounds + manifest requirement", () => {
  it("bounds the advertised file count BEFORE fetching, naming maxFileCount", async () => {
    const idx = { skills: [{ name: "many", description: "d", files: ["SKILL.md", "a.md", "b.md"] }] };
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(idx),
      [fileUrl("many", "SKILL.md")]: "x",
      [fileUrl("many", "a.md")]: "x",
      [fileUrl("many", "b.md")]: "x",
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "many" },
      { caps: { maxFileCount: 2, maxFileBytes: CAPS.maxFileBytes }, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain("maxFileCount");
    // Bounded before any file fetch: only the index was ever requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(INDEX_URL);
  });

  it("rejects an over-cap file naming maxFileBytes", async () => {
    const idx = { skills: [{ name: "big", description: "d", files: ["SKILL.md"] }] };
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(idx),
      [fileUrl("big", "SKILL.md")]: "x".repeat(2000),
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "big" },
      { caps: { maxFileCount: 200, maxFileBytes: 1000 }, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("resource");
    expect(result.error.message + result.error.hint).toContain("maxFileBytes");
    expect(result.error.message).toContain("SKILL.md");
  });

  it("requires a SKILL.md manifest, rejecting a set without one, naming the registry", async () => {
    const idx = { skills: [{ name: "no-manifest", description: "d", files: ["references/notes.md"] }] };
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(idx),
      [fileUrl("no-manifest", "references/notes.md")]: F.FIXTURE_MISSING_SKILLMD_FILES["no-manifest/references/notes.md"]!,
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "no-manifest" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain(REGISTRY);
    expect(result.error.message + result.error.hint).toContain("SKILL.md");
  });

  it("resolves the valid fixture to a SKILL.md-bearing skill-root-relative file set", async () => {
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX),
      [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
      [fileUrl("pdf-extractor", "references/notes.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/references/notes.md"]!,
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/notes.md"]);
    const manifest = result.value.files.find((f) => f.path === "SKILL.md");
    expect(manifest?.content).toBe(F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]);
  });
});

// ---------------------------------------------------------------------------
// Stable per-(registry,name) identifier — routes a changed-bytes re-import to
// the provenance divergence-confirm, not a foreign flat-refuse.
// ---------------------------------------------------------------------------

describe("resolveWellKnown — stable identifier", () => {
  it("pins the identifier to <origin>/.well-known/skills/<name>/", async () => {
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX),
      [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
      [fileUrl("pdf-extractor", "references/notes.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/references/notes.md"]!,
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.identifier).toBe("https://reg.example/.well-known/skills/pdf-extractor/");
  });

  it("keeps the identifier stable when the fetched bytes change", async () => {
    const first = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      {
        caps: CAPS,
        validate: okValidate,
        fetchImpl: servingFetch({
          [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX),
          [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
          [fileUrl("pdf-extractor", "references/notes.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/references/notes.md"]!,
        }),
      },
    );
    const second = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      {
        caps: CAPS,
        validate: okValidate,
        fetchImpl: servingFetch({
          [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX),
          [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_CHANGED_BYTES_FILES["pdf-extractor/SKILL.md"]!,
          [fileUrl("pdf-extractor", "references/notes.md")]: F.FIXTURE_CHANGED_BYTES_FILES["pdf-extractor/references/notes.md"]!,
        }),
      },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Same (registry, name) ⇒ same identifier, even though the bytes differ.
    expect(second.value.identifier).toBe(first.value.identifier);
    const firstManifest = first.value.files.find((f) => f.path === "SKILL.md")?.content;
    const secondManifest = second.value.files.find((f) => f.path === "SKILL.md")?.content;
    expect(secondManifest).not.toBe(firstManifest);
  });
});

// ---------------------------------------------------------------------------
// Instrumentation — an object-first outcome line on both branches
// ---------------------------------------------------------------------------

describe("resolveWellKnown — instrumentation", () => {
  it("logs an INFO carrying the origin on success", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = servingFetch({
      [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX),
      [fileUrl("pdf-extractor", "SKILL.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/SKILL.md"]!,
      [fileUrl("pdf-extractor", "references/notes.md")]: F.FIXTURE_VALID_FILES["pdf-extractor/references/notes.md"]!,
    });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "pdf-extractor" },
      { caps: CAPS, validate: okValidate, fetchImpl, logger },
    );
    expect(result.ok).toBe(true);
    expect(logger.info).toHaveBeenCalled();
    expect(logger.info.mock.calls[0]![0]).toMatchObject({ registryOrigin: REGISTRY });
  });

  it("logs a WARN carrying the errorKind on a reject", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = servingFetch({ [INDEX_URL]: JSON.stringify(F.FIXTURE_VALID_INDEX) });
    const result = await resolveWellKnown(
      { registry: REGISTRY, name: "absent" },
      { caps: CAPS, validate: okValidate, fetchImpl, logger },
    );
    expect(result.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({ errorKind: "validation" });
  });
});
