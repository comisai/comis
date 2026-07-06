// SPDX-License-Identifier: Apache-2.0
/**
 * Fixture shapes for the clawhub install-resolver flow.
 *
 * A community skill hub resolves an install through three endpoints under
 * `https://clawhub.ai/api/v1`: an install decision (`GET /skills/{slug}/install`)
 * that returns the release `archive.downloadUrl` for a scoped `@owner/slug`
 * skill, a verify decision (`GET /skills/{slug}/verify`) that carries the scan /
 * moderation verdict, and the release artifact itself (the download URL). The
 * install decision AND the verdict are fetched and evaluated BEFORE the artifact
 * download — a blocked or malicious release never gets downloaded.
 *
 * These consts are the off-network inputs a resolver is exercised against — no
 * live hub is ever contacted. The API is undocumented, so every response is
 * Zod-validated and the resolver fails loud on drift; the fixtures are the
 * operative contract the schema pins.
 *
 * The shapes span every case the resolver must handle:
 *   - a well-formed official install + a clean verify verdict (the happy path);
 *   - a non-official install (community channel) — resolves, but records
 *     `officialPublisher:false`;
 *   - an install / verify carrying unknown additive fields (top-level AND nested)
 *     — a published hub may grow fields, so extras are tolerated;
 *   - a drifted install (a required field missing, or the wrong type) — the
 *     resolver fails loud naming the registry rather than importing wrong bytes;
 *   - a drifted verify (a required field missing);
 *   - a structured install block (`ok:false` at HTTP 403/409/410/423) — refused;
 *   - a `github`-kind install resolution — refused (a separate import source);
 *   - blocking verdicts (`malicious` scan, `blockedFromDownload`, `quarantined`,
 *     `revoked` moderation, a reason-flagged verdict) — each refused;
 *   - a release zip whose bytes carry a matching (or mismatching) server sha256.
 *
 * The release artifact is a standards-valid zip carrying a spec-pure `SKILL.md`
 * (only `name` + `description` frontmatter) so the same bytes drive both the
 * resolver test here and the staged unpack downstream. Its correct sha256 is
 * computed from the bytes so the "matching header" case can never drift.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { makeZip } from "./make-archive.js";

// ---------------------------------------------------------------------------
// Typed shapes for the well-formed fixtures (drift fixtures are left untyped so
// they can carry deliberately malformed values).
// ---------------------------------------------------------------------------

/** The `archive` sub-object of an archive-kind install resolution. */
export interface ClawHubArchiveFixture {
  readonly version: string;
  readonly downloadUrl: string;
  readonly channel?: string | null;
  readonly isOfficial?: boolean | null;
}

/** A well-formed archive-kind install resolution. */
export interface ClawHubInstallFixture {
  readonly ok: boolean;
  readonly slug: string;
  readonly channel?: string | null;
  readonly isOfficial?: boolean | null;
  readonly installKind: string;
  readonly archive: ClawHubArchiveFixture;
}

/** The loosely-typed `security` sub-object of a verify verdict. */
export interface ClawHubSecurityFixture {
  readonly scanStatus?: string;
  readonly moderationState?: string;
  readonly blockedFromDownload?: boolean;
  readonly status?: string;
}

/** A well-formed verify verdict. */
export interface ClawHubVerifyFixture {
  readonly ok: boolean;
  readonly decision: string;
  readonly reasons?: readonly string[];
  readonly security?: ClawHubSecurityFixture;
}

// ---------------------------------------------------------------------------
// The release artifact (a real spec-pure zip + its correct sha256)
// ---------------------------------------------------------------------------

/** The scoped skill name the fixtures resolve. */
export const FIXTURE_OWNER = "acme";
export const FIXTURE_SLUG = "pdf-extractor";
export const FIXTURE_NAME = `@${FIXTURE_OWNER}/${FIXTURE_SLUG}`;
export const FIXTURE_VERSION = "1.0.0";

/** The release artifact download URL every install fixture advertises. */
export const FIXTURE_DOWNLOAD_URL = "https://cdn.clawhub.ai/artifacts/pdf-extractor/1.0.0/release.zip";

const RELEASE_SKILL_MD = `---
name: pdf-extractor
description: Extracts text and tables from PDF documents into structured output.
---
Extract structured text and tables from the supplied PDF.
`;

/** A standards-valid release zip carrying a spec-pure SKILL.md at its root. */
export const FIXTURE_RELEASE_ZIP_BYTES: Buffer = makeZip([{ name: "SKILL.md", content: RELEASE_SKILL_MD }]);

/** The release zip as base64 — the shape the resolver returns for the pipeline. */
export const FIXTURE_RELEASE_ZIP_BASE64: string = FIXTURE_RELEASE_ZIP_BYTES.toString("base64");

/** The correct sha256 (hex) of the release bytes — the "matching header" value. */
export const FIXTURE_RELEASE_ZIP_SHA256: string = createHash("sha256")
  .update(FIXTURE_RELEASE_ZIP_BYTES)
  .digest("hex");

// ---------------------------------------------------------------------------
// Install-resolution fixtures
// ---------------------------------------------------------------------------

/** A valid official install resolution (isOfficial + the official channel). */
export const FIXTURE_INSTALL_OFFICIAL: ClawHubInstallFixture = {
  ok: true,
  slug: FIXTURE_SLUG,
  channel: "official",
  isOfficial: true,
  installKind: "archive",
  archive: {
    version: FIXTURE_VERSION,
    downloadUrl: FIXTURE_DOWNLOAD_URL,
    channel: "official",
    isOfficial: true,
  },
};

/** A valid non-official install resolution (community channel). */
export const FIXTURE_INSTALL_NON_OFFICIAL: ClawHubInstallFixture = {
  ok: true,
  slug: FIXTURE_SLUG,
  channel: "community",
  isOfficial: false,
  installKind: "archive",
  archive: {
    version: FIXTURE_VERSION,
    downloadUrl: FIXTURE_DOWNLOAD_URL,
    channel: "community",
    isOfficial: false,
  },
};

/**
 * A well-formed install resolution carrying unknown additive fields — an extra
 * top-level key AND an extra nested `archive` key. The resolver tolerates both.
 */
export const FIXTURE_INSTALL_ADDITIVE = {
  ok: true,
  slug: FIXTURE_SLUG,
  channel: "official",
  isOfficial: true,
  installKind: "archive",
  downloads: 4211,
  archive: {
    version: FIXTURE_VERSION,
    downloadUrl: FIXTURE_DOWNLOAD_URL,
    channel: "official",
    isOfficial: true,
    sizeBytes: 20480,
  },
};

/**
 * A drifted install resolution: `ok:true` but with NO `archive` (and no
 * `installKind`) to download. The resolver fails loud naming the registry.
 */
export const FIXTURE_INSTALL_DRIFT_MISSING = {
  ok: true,
  slug: FIXTURE_SLUG,
};

/**
 * A drifted install resolution whose `archive.version` is the wrong type (a
 * number, not a string). The resolver fails loud on the Zod type mismatch.
 */
export const FIXTURE_INSTALL_DRIFT_WRONGTYPE = {
  ok: true,
  slug: FIXTURE_SLUG,
  installKind: "archive",
  archive: {
    version: 123,
    downloadUrl: FIXTURE_DOWNLOAD_URL,
  },
};

// ---------------------------------------------------------------------------
// Verify-verdict fixtures
// ---------------------------------------------------------------------------

/** A clean verify verdict — scan clean, moderation approved, not blocked. */
export const FIXTURE_VERIFY_CLEAN: ClawHubVerifyFixture = {
  ok: true,
  decision: "pass",
  reasons: [],
  security: {
    scanStatus: "clean",
    moderationState: "approved",
    blockedFromDownload: false,
  },
};

/**
 * A clean verify verdict carrying unknown additive fields — an extra top-level
 * key AND an extra nested `security` key. The resolver tolerates both.
 */
export const FIXTURE_VERIFY_ADDITIVE = {
  ok: true,
  decision: "pass",
  reasons: [],
  publisherHandle: FIXTURE_OWNER,
  security: {
    scanStatus: "clean",
    moderationState: "approved",
    blockedFromDownload: false,
    scannedAt: "2026-07-06T00:00:00Z",
  },
};

/**
 * A drifted verify verdict missing the required `decision`. The resolver fails
 * loud naming the registry.
 */
export const FIXTURE_VERIFY_DRIFT = {
  ok: true,
  reasons: [],
};
