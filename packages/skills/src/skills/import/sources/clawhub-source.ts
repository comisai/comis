// SPDX-License-Identifier: Apache-2.0
/**
 * clawhub install-resolver.
 *
 * Given a scoped `@owner/slug` skill name, this pure module resolves a release
 * through the community hub's install-resolver API: it fetches the install
 * decision (which carries the release `archive.downloadUrl`), then fetches the
 * verify verdict (the scan / moderation decision), EVALUATES that verdict, and
 * ONLY on a non-blocking verdict downloads the release artifact — so a blocked
 * or malicious release never gets downloaded. The downloaded bytes are returned
 * base64-encoded for the staged-import pipeline's archive-bytes seam.
 *
 * Every fetch — the install decision, the verify verdict, AND the artifact —
 * goes through the SSRF guard: the URL is DNS-resolved + classified, the socket
 * is pinned to that IP (closing the DNS-rebind window), redirects are refused,
 * and the body is byte-capped against both the declared Content-Length and the
 * streamed size. There is no fixed-host exception — the index-derived
 * `downloadUrl` is re-validated like any other. The validate/fetch seams are
 * injected (defaults wire the real SSRF primitives) so the resolver is fully
 * off-network unit-testable.
 *
 * Fail-closed throughout. A drifted install / verify shape, a structured install
 * block, a blocking verdict, a non-archive install kind, or a present-but-wrong
 * server artifact hash each refuse the WHOLE resolution with a hint naming the
 * registry (or the verdict). The API is undocumented, so every response is
 * Zod-validated (additive fields tolerated, a missing / wrong-typed required
 * field fails loud) rather than trusted.
 *
 * The returned identifier is the stable `@owner/slug` — a later re-import with
 * changed bytes diverges from the pinned content hash (computed downstream over
 * the INSTALLED set) rather than presenting as a foreign source.
 *
 * @module
 */
import { createHash } from "node:crypto";
import type { Result } from "@comis/shared";
import { ok, err, suppressError } from "@comis/shared";
import { validateUrl, systemNowMs, type ErrorKind } from "@comis/core";
import { fetchPinned } from "../../../tools/integrations/pinned-fetch.js";
import type { ArchiveUrlValidator, PinnedArchiveFetch, ArchiveHttpResponse } from "../acquire.js";
import type { ImportLogger } from "../import-pipeline.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The two byte bounds the resolver enforces on its fetches. */
export interface ClawHubCaps {
  /** Per-fetch byte cap for the install / verify JSON responses. */
  readonly maxResponseBytes: number;
  /** Byte cap for the downloaded release artifact. */
  readonly maxArchiveBytes: number;
}

/** Dependencies for {@link resolveClawHub}. */
export interface ClawHubResolveDeps {
  readonly caps: ClawHubCaps;
  /** Test seam: URL validator. Default = the core SSRF `validateUrl`. */
  readonly validate?: ArchiveUrlValidator;
  /** Test seam: the IP-pinned fetch. Default = `fetchPinned`. */
  readonly fetchImpl?: PinnedArchiveFetch;
  /** Optional object-first logger for per-stage + outcome instrumentation. */
  readonly logger?: ImportLogger;
}

/** A resolved release: its base64 bytes + a stable identifier + the publisher signal. */
export interface ClawHubResolved {
  /** The release archive, base64-encoded, for the archive-bytes pipeline seam. */
  readonly archiveBytes: string;
  /** Stable per-skill identifier: `@owner/slug`. */
  readonly identifier: string;
  /** The registry origin token — always the literal `clawhub`. */
  readonly registryOrigin: string;
  /** Whether the publisher is official (isOfficial / the official channel). */
  readonly officialPublisher: boolean;
}

/** A typed resolve reject carrying an operator hint + a closed-union kind. */
export interface ClawHubResolveError {
  readonly message: string;
  readonly hint: string;
  readonly errorKind: ErrorKind;
}

/** The derived trust signal the blocking predicate is evaluated over. */
export interface ClawHubTrust {
  readonly scanStatus?: string | undefined;
  readonly moderationState?: string | undefined;
  readonly blockedFromDownload: boolean;
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Constants + response shapes
// ---------------------------------------------------------------------------

/** The community hub's versioned API base. */
const CLAWHUB_API_BASE = "https://clawhub.ai/api/v1";
/** The registry origin token used in provenance + hints. */
const REGISTRY_LABEL = "clawhub";

// A structured block is a refusal body served at one of these HTTP statuses; the
// resolver reads + refuses on the body rather than treating it as a generic
// network fault, and any OTHER non-2xx stays a network reject.
const STRUCTURED_BLOCK_STATUSES: readonly number[] = [403, 409, 410, 423];

// A scoped skill name: `@owner/slug`, with no whitespace or extra path segments.
const SCOPED_NAME_RE = /^@([^/\s]+)\/([^/\s]+)$/;

// The install / verify shapes are validated with NON-strict objects: the known
// fields are enforced (a missing / wrong-typed required field fails loud naming
// the registry) while unknown additive fields — a published hub may grow them —
// are tolerated rather than failing loud. The loosely-typed `security` sub-object
// passes unknown keys through so a scan/moderation field the hub adds is not
// silently dropped when the trust signal is derived.
const ClawHubInstallResponseSchema = z.object({
  ok: z.boolean(),
  slug: z.string().optional(),
  channel: z.string().nullish(),
  isOfficial: z.boolean().nullish(),
  installKind: z.string().optional(),
  archive: z
    .object({
      version: z.string(),
      downloadUrl: z.string(),
      channel: z.string().nullish(),
      isOfficial: z.boolean().nullish(),
    })
    .optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  status: z.number().optional(),
});

const ClawHubVerifyResponseSchema = z.object({
  ok: z.boolean(),
  decision: z.string(),
  reasons: z.array(z.string()).default([]),
  security: z
    .object({
      scanStatus: z.string().optional(),
      moderationState: z.string().optional(),
      blockedFromDownload: z.boolean().optional(),
      status: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

// ---------------------------------------------------------------------------
// Fetch helpers (SSRF-pinned + byte-capped) — mirror the acquire step
// ---------------------------------------------------------------------------

function mkErr(errorKind: ErrorKind, message: string, hint: string): ClawHubResolveError {
  return { errorKind, message, hint };
}

function overCapError(maxBytes: number, what: string, capName: string): ClawHubResolveError {
  return mkErr(
    "resource",
    `${what} from the ${REGISTRY_LABEL} registry exceeds its ${maxBytes}-byte cap`,
    `raise ${capName} or reduce the published size`,
  );
}

/** A structured install block — refused pre-download, never overridable. */
function structuredBlockError(owner: string, slug: string, reason: string): ClawHubResolveError {
  return mkErr(
    "precondition",
    `the ${REGISTRY_LABEL} registry refused the install of '@${owner}/${slug}': ${reason}`,
    "the registry blocked this skill from installation; this refusal is not overridable",
  );
}

/** The status + headers surfaced alongside the capped body. */
interface CappedResponse {
  readonly bytes: Buffer;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
}

/**
 * Stream a response body into a Buffer, enforcing `maxBytes` against BOTH the
 * declared Content-Length (pre-stream) and the streamed size (a server may
 * under-declare). The cap key is named in the reject hint.
 *
 * The read loop is wrapped so a body error AFTER the headers arrive — a
 * connection reset mid-body, or the per-fetch 30s streaming timeout firing
 * during `read()` — returns a TYPED reject naming the registry, never an uncaught
 * throw, keeping the resolver's "never throws" contract + its WARN + hint intact.
 */
async function readCappedBody(
  response: ArchiveHttpResponse,
  maxBytes: number,
  what: string,
  capName: string,
): Promise<Result<Buffer, ClawHubResolveError>> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      await response.body?.cancel();
      return err(overCapError(maxBytes, what, capName));
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return err(
      mkErr("network", `${what} carried no response body`, "the registry returned an empty response; verify it is reachable"),
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return err(overCapError(maxBytes, what, capName));
      }
      chunks.push(value);
    }
  } catch (e) {
    suppressError(reader.cancel(), "cancel body reader after a mid-stream read error");
    // The only AbortSignal on the pinned fetch is AbortSignal.timeout(30_000),
    // so a Timeout/Abort raised during read() IS the streaming-timeout branch;
    // any other rejection is an unresponsive-registry dependency failure.
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return err(
        mkErr(
          "timeout",
          `reading ${what} from the ${REGISTRY_LABEL} registry timed out mid-stream (the 30s per-fetch cap fired while the body was streaming)`,
          "the registry sent headers then stalled the body; verify it responds fully within 30s",
        ),
      );
    }
    return err(
      mkErr(
        "dependency",
        `reading ${what} from the ${REGISTRY_LABEL} registry failed mid-stream: ${e instanceof Error ? e.message : String(e)}`,
        "verify the registry is reachable and responsive; the fetch is pinned to the SSRF-validated IP and aborts after 30s",
      ),
    );
  }
  return ok(Buffer.concat(chunks));
}

/**
 * SSRF-validate → IP-pinned fetch → byte-capped read. Every fetch (install,
 * verify, artifact) funnels here. A non-2xx status rejects as a network error
 * UNLESS it is in `allowStatuses` — the caller passes the structured-block
 * statuses there so it can read + refuse on the block body rather than treating
 * it as a generic network fault.
 */
async function fetchCapped(
  url: string,
  what: string,
  maxBytes: number,
  capName: string,
  validate: ArchiveUrlValidator,
  fetchImpl: PinnedArchiveFetch,
  opts?: { readonly allowStatuses?: readonly number[] },
): Promise<Result<CappedResponse, ClawHubResolveError>> {
  const validated = await validate(url);
  if (!validated.ok) {
    return err(
      mkErr(
        "validation",
        `${what} URL for the ${REGISTRY_LABEL} registry was blocked by the SSRF guard: ${validated.error.message}`,
        "the registry must be a public, non-loopback, non-metadata host; the fetch is DNS-pinned and refuses internal targets",
      ),
    );
  }

  let response: ArchiveHttpResponse;
  try {
    response = await fetchImpl(url, validated.value.ip, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return err(
      mkErr(
        "network",
        `fetching ${what} from the ${REGISTRY_LABEL} registry failed: ${e instanceof Error ? e.message : String(e)}`,
        "verify the registry is reachable; the connection is pinned to the SSRF-validated IP",
      ),
    );
  }

  const allowed = opts?.allowStatuses ?? [];
  if (!response.ok && !allowed.includes(response.status)) {
    return err(
      mkErr(
        "network",
        `the ${REGISTRY_LABEL} registry returned HTTP ${response.status} for ${what}`,
        "verify the skill exists on the registry and the install-resolver API is reachable",
      ),
    );
  }

  const body = await readCappedBody(response, maxBytes, what, capName);
  if (!body.ok) return body;
  return ok({ bytes: body.value, status: response.status, headers: response.headers });
}

// ---------------------------------------------------------------------------
// Verdict evaluation
// ---------------------------------------------------------------------------

/** Moderation states that block a release regardless of the scan status. */
const BLOCKING_MODERATION_STATES = new Set(["blocked", "quarantined", "revoked"]);

/**
 * The pure blocking predicate over the derived trust signal. A release is
 * blocked when ANY of: it is flagged blocked-from-download, the artifact scan
 * status is malicious, the moderation state is a blocking one, or a verdict
 * reason matches a malicious / malware / `*_blocked` / `*.blocked` / `blocked`
 * pattern. A clean / pending / not-run verdict with no flags is NOT blocked. The
 * returned reasons are human-readable and drive the refusal hint.
 */
export function evaluateVerdict(trust: ClawHubTrust): { blocked: boolean; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (trust.blockedFromDownload === true) {
    reasons.push("the release is blocked from download");
  }
  if (trust.scanStatus === "malicious") {
    reasons.push("the artifact scan status is malicious");
  }
  if (trust.moderationState !== undefined && BLOCKING_MODERATION_STATES.has(trust.moderationState)) {
    reasons.push(`the moderation state is ${trust.moderationState}`);
  }
  for (const r of trust.reasons) {
    const lower = r.toLowerCase();
    if (
      lower.includes("malicious") ||
      lower.includes("malware") ||
      lower.endsWith("_blocked") ||
      lower.endsWith(".blocked") ||
      lower === "blocked"
    ) {
      reasons.push(`the registry verdict flags: ${r}`);
    }
  }
  return { blocked: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

async function resolveInner(
  input: { name: string },
  deps: ClawHubResolveDeps,
): Promise<Result<ClawHubResolved, ClawHubResolveError>> {
  const { caps } = deps;
  const validate: ArchiveUrlValidator = deps.validate ?? validateUrl;
  // The cast adapts the real IP-pinned fetch (an undici Response) to the narrow
  // seam shape used here; tests inject a conforming stub.
  const fetchImpl: PinnedArchiveFetch = deps.fetchImpl ?? (fetchPinned as unknown as PinnedArchiveFetch);

  // 1. Parse the scoped `@owner/slug` name.
  const match = SCOPED_NAME_RE.exec(input.name.trim());
  if (match === null) {
    return err(
      mkErr(
        "validation",
        `the skill name "${input.name}" is not a scoped ${REGISTRY_LABEL} name`,
        "supply the skill as @owner/slug",
      ),
    );
  }
  const owner = match[1]!;
  const slug = match[2]!;

  // 2. Fetch the install decision (carries the release downloadUrl).
  const installUrl = `${CLAWHUB_API_BASE}/skills/${slug}/install?ownerHandle=${encodeURIComponent(owner)}`;
  deps.logger?.debug({ step: "install", slug }, "clawhub resolve: fetching the install decision");
  const installFetch = await fetchCapped(
    installUrl,
    "the install decision",
    caps.maxResponseBytes,
    "the maximum registry-response size",
    validate,
    fetchImpl,
    { allowStatuses: STRUCTURED_BLOCK_STATUSES },
  );
  if (!installFetch.ok) return installFetch;
  const installStatus = installFetch.value.status;

  let installJson: unknown;
  try {
    installJson = JSON.parse(installFetch.value.bytes.toString("utf-8"));
  } catch {
    // A block status with a non-JSON body is still a block; a 2xx non-JSON is drift.
    if (STRUCTURED_BLOCK_STATUSES.includes(installStatus)) {
      return err(structuredBlockError(owner, slug, `HTTP ${installStatus}`));
    }
    return err(
      mkErr(
        "validation",
        `the install decision for '@${owner}/${slug}' from the ${REGISTRY_LABEL} registry is not valid JSON`,
        `verify ${CLAWHUB_API_BASE}/skills/${slug}/install returns a JSON install resolution`,
      ),
    );
  }
  const installParsed = ClawHubInstallResponseSchema.safeParse(installJson);
  if (!installParsed.success) {
    if (STRUCTURED_BLOCK_STATUSES.includes(installStatus)) {
      return err(structuredBlockError(owner, slug, `HTTP ${installStatus}`));
    }
    return err(
      mkErr(
        "validation",
        `the install decision for '@${owner}/${slug}' from the ${REGISTRY_LABEL} registry did not match the expected shape`,
        `verify ${CLAWHUB_API_BASE} publishes an install resolution with { ok, installKind, archive:{ version, downloadUrl } }`,
      ),
    );
  }
  const install = installParsed.data;

  // A structured block — a block HTTP status OR an `ok:false` body — refuses
  // BEFORE the verify + artifact fetches, and is never overridable.
  if (STRUCTURED_BLOCK_STATUSES.includes(installStatus) || install.ok !== true) {
    const reason = install.reason ?? install.message ?? `HTTP ${installStatus}`;
    return err(structuredBlockError(owner, slug, reason));
  }
  // A non-archive install kind (e.g. github) is handled by a separate import
  // source — refuse clearly rather than trying to download a release zip.
  if (install.installKind !== undefined && install.installKind !== "archive") {
    return err(
      mkErr(
        "precondition",
        `'@${owner}/${slug}' resolves to a ${install.installKind} install, which this import source does not handle`,
        "import a GitHub-sourced skill via the github import source instead",
      ),
    );
  }
  // An install with no archive to download is drift.
  if (install.archive === undefined) {
    return err(
      mkErr(
        "validation",
        `the install decision for '@${owner}/${slug}' from the ${REGISTRY_LABEL} registry did not resolve to an archive to download`,
        `verify ${CLAWHUB_API_BASE}/skills/${slug}/install resolves to an archive install`,
      ),
    );
  }
  const version = install.archive.version;
  const downloadUrl = install.archive.downloadUrl;

  // 3. Fetch the verify verdict for the resolved version.
  const verifyUrl = `${CLAWHUB_API_BASE}/skills/${slug}/verify?version=${encodeURIComponent(version)}`;
  deps.logger?.debug({ step: "verify", slug, version }, "clawhub resolve: fetching the verify verdict");
  const verifyFetch = await fetchCapped(
    verifyUrl,
    "the verify verdict",
    caps.maxResponseBytes,
    "the maximum registry-response size",
    validate,
    fetchImpl,
  );
  if (!verifyFetch.ok) return verifyFetch;

  let verifyJson: unknown;
  try {
    verifyJson = JSON.parse(verifyFetch.value.bytes.toString("utf-8"));
  } catch {
    return err(
      mkErr(
        "validation",
        `the verify verdict for '@${owner}/${slug}' from the ${REGISTRY_LABEL} registry is not valid JSON`,
        `verify ${CLAWHUB_API_BASE}/skills/${slug}/verify returns a JSON verdict`,
      ),
    );
  }
  const verifyParsed = ClawHubVerifyResponseSchema.safeParse(verifyJson);
  if (!verifyParsed.success) {
    return err(
      mkErr(
        "validation",
        `the verify verdict for '@${owner}/${slug}' from the ${REGISTRY_LABEL} registry did not match the expected shape`,
        `verify ${CLAWHUB_API_BASE}/skills/${slug}/verify publishes { ok, decision, reasons, security? }`,
      ),
    );
  }
  const verify = verifyParsed.data;
  const security = verify.security;
  const trust: ClawHubTrust = {
    scanStatus: security?.scanStatus ?? security?.status,
    moderationState: security?.moderationState,
    blockedFromDownload: security?.blockedFromDownload ?? false,
    reasons: verify.reasons,
  };

  // 4. Evaluate the verdict BEFORE the download — a blocking verdict refuses here,
  //    so the artifact fetch never runs.
  const verdict = evaluateVerdict(trust);
  if (verdict.blocked) {
    return err(
      mkErr(
        "precondition",
        `the release for '@${owner}/${slug}' is blocked by the ${REGISTRY_LABEL} registry: ${verdict.reasons.join("; ")}`,
        "this verdict is not overridable — the release will not be downloaded",
      ),
    );
  }

  // 5. Derive the publisher signal (feeds the commit-time acknowledgement, not a
  //    refuse here — a non-official publisher is a warnable class, not a block).
  const officialPublisher =
    install.isOfficial === true ||
    install.channel === "official" ||
    install.archive.isOfficial === true ||
    install.archive.channel === "official";

  // 6. Download the release artifact (SSRF-pinned + capped at the archive bound).
  deps.logger?.debug({ step: "artifact", slug, version }, "clawhub resolve: downloading the release artifact");
  const artifactFetch = await fetchCapped(
    downloadUrl,
    "the release artifact",
    caps.maxArchiveBytes,
    "skills.import.maxArchiveBytes",
    validate,
    fetchImpl,
  );
  if (!artifactFetch.ok) return artifactFetch;
  const bytes = artifactFetch.value.bytes;

  // 6a. Verify the server-provided artifact sha256 WHEN PRESENT. Absence is fine
  //     — no release carries one today, and the pipeline's self-computed pin over
  //     the INSTALLED set is the always-present integrity floor. A present-but-
  //     wrong hash means a tampered / swapped artifact and refuses the download.
  const headerHash =
    artifactFetch.value.headers.get("X-ClawHub-Artifact-Sha256") ??
    artifactFetch.value.headers.get("X-ClawHub-ClawPack-Sha256");
  if (headerHash !== null) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (headerHash.trim().toLowerCase() !== actual.toLowerCase()) {
      return err(
        mkErr(
          "validation",
          `the release artifact for '@${owner}/${slug}' failed its server-provided sha256 check`,
          "the download does not match the registry's published hash — refusing the tampered artifact",
        ),
      );
    }
  }

  // 7. Return the base64 bytes + the stable identifier + the publisher signal.
  return ok({
    archiveBytes: bytes.toString("base64"),
    identifier: `@${owner}/${slug}`,
    registryOrigin: REGISTRY_LABEL,
    officialPublisher,
  });
}

/**
 * Resolve a `{ name: "@owner/slug" }` to its release archive bytes, SSRF-pinned
 * and byte-capped on every fetch, with the install decision + verdict evaluated
 * BEFORE the download. Never throws — a reject is a typed
 * {@link ClawHubResolveError}. Emits an object-first outcome line (an INFO on
 * success, a WARN naming the reject kind + hint otherwise).
 */
export async function resolveClawHub(
  input: { name: string },
  deps: ClawHubResolveDeps,
): Promise<Result<ClawHubResolved, ClawHubResolveError>> {
  const startedMs = systemNowMs();
  let result: Result<ClawHubResolved, ClawHubResolveError>;
  try {
    result = await resolveInner(input, deps);
  } catch (e) {
    // The contract is "never throws" — a reject is always a typed
    // ClawHubResolveError. This catch-all guarantees it even for an unforeseen
    // fault, so the typed-Result seam and the WARN below always hold.
    result = err(
      mkErr(
        "internal",
        `clawhub resolve threw unexpectedly: ${e instanceof Error ? e.message : String(e)}`,
        "an internal resolver fault; inspect the daemon log for the stack trace",
      ),
    );
  }
  const durationMs = systemNowMs() - startedMs;
  if (result.ok) {
    deps.logger?.info(
      { identifier: result.value.identifier, officialPublisher: result.value.officialPublisher, durationMs },
      "clawhub resolve: resolved release artifact",
    );
  } else {
    deps.logger?.warn(
      { errorKind: result.error.errorKind, hint: result.error.hint, durationMs },
      `clawhub resolve: ${result.error.message}`,
    );
  }
  return result;
}
