// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary suite for the clawhub install-resolver. Every fetch (the install
 * decision, the verify verdict, the release artifact) must go through the
 * injected SSRF-validate + pinned-fetch seams; a blocked host rejects before a
 * connection opens. Each response is Zod-validated (additive fields tolerated,
 * drift fails loud naming the registry). The install decision AND the verdict
 * are fetched and evaluated BEFORE the artifact download — a blocked verdict
 * refuses with the artifact-download seam left untouched.
 *
 * Fixtures only — no live hub is ever contacted. The validate/fetch seams are
 * injected spies; a non-network reject must leave the fetch spy untouched.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { resolveClawHub, evaluateVerdict, type ClawHubTrust } from "./clawhub-source.js";
import type { ArchiveHttpResponse, ArchiveResponseBody, ArchiveUrlValidator } from "../acquire.js";
import * as F from "../test-fixtures/clawhub-install.js";

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
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  noBody?: boolean;
}): ArchiveHttpResponse {
  const headers = new Map<string, string>();
  if (opts.contentLength != null) headers.set("content-length", opts.contentLength);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k.toLowerCase(), v);
  const chunks: Uint8Array[] =
    opts.bytes !== undefined
      ? [opts.bytes]
      : opts.body !== undefined
        ? [new TextEncoder().encode(opts.body)]
        : [];
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: opts.noBody === true ? null : streamOf(chunks),
  };
}

/** A fetch spy that serves a pre-built response per URL; an unmapped URL 404s. */
function servingFetch(byUrl: Record<string, ArchiveHttpResponse>) {
  return vi.fn(async (url: string, _ip: string, _init?: unknown): Promise<ArchiveHttpResponse> => {
    return byUrl[url] ?? stubResponse({ ok: false, status: 404, body: "not found" });
  });
}

const okValidate: ArchiveUrlValidator = vi.fn(async () => ok({ hostname: "clawhub.ai", ip: "203.0.113.20" }));

const API_BASE = "https://clawhub.ai/api/v1";
const INSTALL_URL = `${API_BASE}/skills/${F.FIXTURE_SLUG}/install?ownerHandle=${F.FIXTURE_OWNER}`;
const VERIFY_URL = `${API_BASE}/skills/${F.FIXTURE_SLUG}/verify?version=${F.FIXTURE_VERSION}`;
const DOWNLOAD_URL = F.FIXTURE_DOWNLOAD_URL;
const CAPS = { maxResponseBytes: 1_048_576, maxArchiveBytes: 8_388_608 };

/** Build a URL→response map for the full install→verify→artifact flow. */
function flowFetch(opts: {
  install?: ArchiveHttpResponse;
  verify?: ArchiveHttpResponse;
  artifact?: ArchiveHttpResponse;
}) {
  return servingFetch({
    [INSTALL_URL]: opts.install ?? stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_OFFICIAL) }),
    [VERIFY_URL]: opts.verify ?? stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_CLEAN) }),
    [DOWNLOAD_URL]: opts.artifact ?? stubResponse({ bytes: F.FIXTURE_RELEASE_ZIP_BYTES }),
  });
}

const fetchedUrls = (fetchImpl: ReturnType<typeof vi.fn>): string[] =>
  fetchImpl.mock.calls.map((c) => c[0] as string);

// ---------------------------------------------------------------------------
// Happy path: install → verify → download → archiveBytes + officialPublisher
// ---------------------------------------------------------------------------

describe("resolveClawHub — install-resolver happy path", () => {
  it("resolves a valid official install to archiveBytes, fetching install + verify BEFORE the download", async () => {
    const fetchImpl = flowFetch({});
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.archiveBytes).toBe(F.FIXTURE_RELEASE_ZIP_BASE64);
    expect(result.value.identifier).toBe(F.FIXTURE_NAME);
    expect(result.value.registryOrigin).toBe("clawhub");
    expect(result.value.officialPublisher).toBe(true);
    // The install decision AND the verdict were fetched BEFORE the artifact.
    const urls = fetchedUrls(fetchImpl);
    expect(urls).toEqual([INSTALL_URL, VERIFY_URL, DOWNLOAD_URL]);
  });

  it("resolves a non-official install with officialPublisher false", async () => {
    const fetchImpl = flowFetch({
      install: stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_NON_OFFICIAL) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.officialPublisher).toBe(false);
    expect(result.value.archiveBytes).toBe(F.FIXTURE_RELEASE_ZIP_BASE64);
  });

  it("resolves when the artifact carries no server sha256 header", async () => {
    const fetchImpl = flowFetch({ artifact: stubResponse({ bytes: F.FIXTURE_RELEASE_ZIP_BYTES }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(true);
  });

  it("resolves when the artifact carries a MATCHING server sha256 header", async () => {
    const fetchImpl = flowFetch({
      artifact: stubResponse({
        bytes: F.FIXTURE_RELEASE_ZIP_BYTES,
        headers: { "X-ClawHub-Artifact-Sha256": F.FIXTURE_RELEASE_ZIP_SHA256 },
      }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(true);
  });

  it("tolerates additive unknown fields on install AND verify and resolves", async () => {
    const fetchImpl = flowFetch({
      install: stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_ADDITIVE) }),
      verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_ADDITIVE) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.officialPublisher).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape validation: fail loud naming the registry on drift
// ---------------------------------------------------------------------------

describe("resolveClawHub — Zod fail-loud on shape drift", () => {
  it("fails loud naming the registry when the install resolution has no archive", async () => {
    const fetchImpl = flowFetch({
      install: stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_DRIFT_MISSING) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain("clawhub");
    // Nothing downstream of the install fetch ran.
    expect(fetchedUrls(fetchImpl)).not.toContain(VERIFY_URL);
  });

  it("fails loud naming the registry when an install field is the wrong type", async () => {
    const fetchImpl = flowFetch({
      install: stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_DRIFT_WRONGTYPE) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain("clawhub");
  });

  it("fails loud naming the registry when the verify verdict drifts", async () => {
    const fetchImpl = flowFetch({
      verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_DRIFT) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain("clawhub");
    // The verdict drift is caught before the artifact download.
    expect(fetchedUrls(fetchImpl)).not.toContain(DOWNLOAD_URL);
  });

  it("fails loud naming the registry when the install body is not valid JSON", async () => {
    const fetchImpl = flowFetch({ install: stubResponse({ body: "{ not json" }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain("clawhub");
  });
});

// ---------------------------------------------------------------------------
// Input + SSRF + never-throws
// ---------------------------------------------------------------------------

describe("resolveClawHub — @owner/slug parse + SSRF + never-throws", () => {
  it("rejects a malformed skill name WITHOUT fetching", async () => {
    const fetchImpl = flowFetch({});
    const result = await resolveClawHub({ name: "not-a-scoped-name" }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an install URL the SSRF guard blocks WITHOUT fetching", async () => {
    const validate: ArchiveUrlValidator = vi.fn(async () => err(new Error("blocked: loopback range")));
    const fetchImpl = flowFetch({});
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(validate).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors the never-throws contract when a seam throws (typed internal reject + WARN)", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const validate: ArchiveUrlValidator = vi.fn(async () => {
      throw new Error("validator blew up");
    });
    const fetchImpl = flowFetch({});
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate, fetchImpl, logger });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("internal");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({ errorKind: "internal" });
  });
});

// ---------------------------------------------------------------------------
// Instrumentation — an object-first outcome line on both branches
// ---------------------------------------------------------------------------

describe("resolveClawHub — instrumentation", () => {
  it("logs an INFO carrying the identifier + officialPublisher on success", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = flowFetch({});
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl, logger });
    expect(result.ok).toBe(true);
    expect(logger.info).toHaveBeenCalled();
    expect(logger.info.mock.calls[0]![0]).toMatchObject({ identifier: F.FIXTURE_NAME, officialPublisher: true });
  });

  it("logs a WARN carrying the errorKind on a reject", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = flowFetch({
      install: stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_DRIFT_MISSING) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl, logger });
    expect(result.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({ errorKind: "validation" });
  });
});

// ---------------------------------------------------------------------------
// evaluateVerdict — the pure blocking predicate (clean verdict is not blocked)
// ---------------------------------------------------------------------------

describe("evaluateVerdict — a clean verdict is not blocked", () => {
  it("returns { blocked: false } for a clean, approved, not-blocked verdict", () => {
    const trust: ClawHubTrust = {
      scanStatus: "clean",
      moderationState: "approved",
      blockedFromDownload: false,
      reasons: [],
    };
    expect(evaluateVerdict(trust).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict-refuse-before-download — a blocking verdict refuses with the artifact
// download seam UNTOUCHED (install + verify fetched, the download never runs).
// The verdict is NOT confirm-overridable: resolveClawHub has no confirm param
// (structural), so the block returns a typed refuse pre-download.
// ---------------------------------------------------------------------------

describe("resolveClawHub — verdict-refuse-before-download", () => {
  it("refuses a malicious scan verdict BEFORE downloading the artifact", async () => {
    const fetchImpl = flowFetch({ verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_MALICIOUS) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(result.error.message).toContain("malicious");
    expect(result.error.message).toContain("clawhub");
    // install + verify fetched; the artifact download seam is UNTOUCHED.
    const urls = fetchedUrls(fetchImpl);
    expect(urls).toContain(INSTALL_URL);
    expect(urls).toContain(VERIFY_URL);
    expect(urls).not.toContain(DOWNLOAD_URL);
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("refuses a blockedFromDownload verdict, artifact untouched", async () => {
    const fetchImpl = flowFetch({ verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_BLOCKED_DOWNLOAD) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("refuses a quarantined moderation state, artifact untouched", async () => {
    const fetchImpl = flowFetch({ verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_QUARANTINED) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(result.error.message).toContain("quarantined");
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("refuses a revoked moderation state, artifact untouched", async () => {
    const fetchImpl = flowFetch({ verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_REVOKED) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(result.error.message).toContain("revoked");
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("refuses a reason-flagged verdict, artifact untouched", async () => {
    const fetchImpl = flowFetch({ verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_REASON_BLOCK) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("refuses a structured install block (HTTP 403) with verify + artifact untouched", async () => {
    const fetchImpl = flowFetch({
      install: stubResponse({ ok: false, status: 403, body: JSON.stringify(F.FIXTURE_INSTALL_STRUCTURED_BLOCK) }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(result.error.message + result.error.hint).toContain("clawhub");
    const urls = fetchedUrls(fetchImpl);
    expect(urls).toContain(INSTALL_URL);
    expect(urls).not.toContain(VERIFY_URL);
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("refuses an installKind:github resolution clearly, verify + artifact untouched", async () => {
    const fetchImpl = flowFetch({ install: stubResponse({ body: JSON.stringify(F.FIXTURE_INSTALL_GITHUB_KIND) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect((result.error.message + result.error.hint).toLowerCase()).toContain("github");
    const urls = fetchedUrls(fetchImpl);
    expect(urls).toContain(INSTALL_URL);
    expect(urls).not.toContain(VERIFY_URL);
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Top-level verdict fail-closed — a verify body whose AUTHORITATIVE top-level
// says the release did not pass (ok:false / decision non-pass) refuses BEFORE
// the download, even with NO security sub-object and no recognized reason token.
// ---------------------------------------------------------------------------

describe("resolveClawHub — fail-closed on the top-level verify verdict", () => {
  it("refuses an ok:false / decision:fail verdict with no security object, artifact untouched", async () => {
    const fetchImpl = flowFetch({ verify: stubResponse({ body: JSON.stringify(F.FIXTURE_VERIFY_TOPLEVEL_BLOCK) }) });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("precondition");
    expect(result.error.message).toContain("clawhub");
    // install + verify fetched; the artifact download seam is UNTOUCHED.
    const urls = fetchedUrls(fetchImpl);
    expect(urls).toContain(INSTALL_URL);
    expect(urls).toContain(VERIFY_URL);
    expect(urls).not.toContain(DOWNLOAD_URL);
    expect(fetchImpl).not.toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything(), expect.anything());
  });

  it("still resolves a clean ok:true / decision:pass verdict", async () => {
    const fetchImpl = flowFetch({});
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server sha256 integrity — verified WHEN PRESENT (a mismatch refuses the
// tampered artifact; an absent header is fine — the pipeline's self-computed
// pin is the always-present floor).
// ---------------------------------------------------------------------------

describe("resolveClawHub — server sha256 when present", () => {
  it("rejects a present-but-wrong server sha256 and never returns the bytes", async () => {
    const fetchImpl = flowFetch({
      artifact: stubResponse({
        bytes: F.FIXTURE_RELEASE_ZIP_BYTES,
        headers: { "X-ClawHub-Artifact-Sha256": F.FIXTURE_ARTIFACT_SHA256_WRONG },
      }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message + result.error.hint).toContain("sha256");
  });

  it("verifies the fallback header name when present", async () => {
    const fetchImpl = flowFetch({
      artifact: stubResponse({
        bytes: F.FIXTURE_RELEASE_ZIP_BYTES,
        headers: { "X-ClawHub-ClawPack-Sha256": F.FIXTURE_ARTIFACT_SHA256_WRONG },
      }),
    });
    const result = await resolveClawHub({ name: F.FIXTURE_NAME }, { caps: CAPS, validate: okValidate, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// evaluateVerdict — the pure blocking predicate: each blocking class blocks;
// clean / pending / not-run verdicts do not.
// ---------------------------------------------------------------------------

describe("evaluateVerdict — the pure blocking predicate", () => {
  const base = { blockedFromDownload: false, reasons: [] as readonly string[] };

  it("blocks a malicious scan status", () => {
    expect(evaluateVerdict({ ...base, scanStatus: "malicious" }).blocked).toBe(true);
  });

  it("blocks an explicit blockedFromDownload flag", () => {
    expect(evaluateVerdict({ ...base, blockedFromDownload: true }).blocked).toBe(true);
  });

  it("blocks each blocking moderation state", () => {
    for (const state of ["blocked", "quarantined", "revoked"]) {
      expect(evaluateVerdict({ ...base, moderationState: state }).blocked).toBe(true);
    }
  });

  it("blocks a reason matching a malicious / malware / *_blocked / *.blocked / blocked pattern", () => {
    for (const reason of ["scan:malicious", "static:malware", "policy_blocked", "moderation.blocked", "blocked"]) {
      expect(evaluateVerdict({ ...base, reasons: [reason] }).blocked).toBe(true);
    }
  });

  it("does NOT block a clean / pending / not-run verdict", () => {
    expect(evaluateVerdict({ ...base, scanStatus: "clean", moderationState: "approved" }).blocked).toBe(false);
    expect(evaluateVerdict({ ...base, scanStatus: "pending" }).blocked).toBe(false);
    expect(evaluateVerdict({ ...base, scanStatus: "not-run", reasons: ["note:informational"] }).blocked).toBe(false);
  });
});
