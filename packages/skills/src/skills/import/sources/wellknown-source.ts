// SPDX-License-Identifier: Apache-2.0
/**
 * Well-known skill-registry resolver.
 *
 * Given a registry origin and a skill name, this pure module fetches the
 * registry's `/.well-known/skills/index.json`, validates its observed shape,
 * looks up the requested skill, validates every advertised skill-root-relative
 * path, then fetches each advertised file — producing the `{ path, content }[]`
 * file set the staged-import pipeline consumes at its file-set seam.
 *
 * Every fetch — the index AND each file — goes through the SSRF guard: the URL
 * is DNS-resolved + classified, the socket is pinned to that IP (closing the
 * DNS-rebind window), redirects are refused, and the body is byte-capped against
 * both the declared Content-Length and the streamed size. There is no fixed-host
 * exception. The validate/fetch/cache seams are injected (defaults wire the real
 * SSRF primitives) so the resolver is fully off-network unit-testable.
 *
 * Fail-closed throughout. A drifted index shape, an absent skill, one unsafe
 * advertised path, an advertised file count over the cap, an over-cap file, or a
 * missing `SKILL.md` manifest each refuse the WHOLE resolution with a hint that
 * names the registry (or the exact cap key). The index metadata — names + paths
 * only, never bodies — may be served from an injected cache; every file is
 * always re-fetched.
 *
 * The returned identifier is stable per (registry, name):
 * `<origin>/.well-known/skills/<name>/`. The content hash is NOT computed here —
 * the pipeline hashes the INSTALLED set (post-drop) downstream, so a later
 * re-import with changed bytes diverges from the pinned hash rather than
 * presenting as a foreign source.
 *
 * @module
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Result } from "@comis/shared";
import { ok, err, suppressError } from "@comis/shared";
import { validateUrl, safePath, systemNowMs, type ErrorKind } from "@comis/core";
import { fetchPinned } from "../../../tools/integrations/pinned-fetch.js";
import type {
  FileSetFile,
  ArchiveUrlValidator,
  PinnedArchiveFetch,
  ArchiveHttpResponse,
} from "../acquire.js";
import type { ImportLogger } from "../import-pipeline.js";
import type { SkillIndexCache, CachedIndexEntry } from "../skill-index-cache.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The two bounds the resolver enforces on the advertised fetch fan-out. */
export interface WellKnownCaps {
  /** Max advertised files per skill — bounded BEFORE any file is fetched. */
  readonly maxFileCount: number;
  /** Per-fetch byte cap (the index AND each file). */
  readonly maxFileBytes: number;
}

/** Dependencies for {@link resolveWellKnown}. */
export interface WellKnownResolveDeps {
  readonly caps: WellKnownCaps;
  /** Test seam: URL validator. Default = the core SSRF `validateUrl`. */
  readonly validate?: ArchiveUrlValidator;
  /** Test seam: the IP-pinned fetch. Default = `fetchPinned`. */
  readonly fetchImpl?: PinnedArchiveFetch;
  /** Optional index-metadata cache. Absent ⇒ the index is always fetched. */
  readonly cache?: SkillIndexCache;
  /** Optional object-first logger for per-stage + outcome instrumentation. */
  readonly logger?: ImportLogger;
}

/** A resolved skill: its file set + a stable identifier + the normalized origin. */
export interface WellKnownResolved {
  /** Skill-root-relative files (SKILL.md present), each with its fetched text. */
  readonly files: readonly FileSetFile[];
  /** Stable per-(registry,name) identifier: `<origin>/.well-known/skills/<name>/`. */
  readonly identifier: string;
  /** The normalized registry origin (`new URL(registry).origin`). */
  readonly registryOrigin: string;
}

/** A typed resolve reject carrying an operator hint + a closed-union kind. */
export interface WellKnownResolveError {
  readonly message: string;
  readonly hint: string;
  readonly errorKind: ErrorKind;
}

// ---------------------------------------------------------------------------
// Index shape + path validation
// ---------------------------------------------------------------------------

// The observed convention carries no integrity/version metadata, so the shape
// is validated with a NON-strict object: the required `skills` array and each
// entry's `name`/`description` are enforced, while unknown additive fields (a
// published index may grow them) are tolerated rather than failing loud.
const WellKnownIndexSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      files: z.array(z.string()).optional(),
    }),
  ),
});

// A synthetic, non-existent base used purely to validate advertised-path
// containment (`..`, null bytes, encoded traversal); never used for I/O.
const NOTIONAL_BASE = "/skill-import-notional-root";

/**
 * Validate one advertised skill-root-relative path against the same rule the
 * import pipeline applies to a file set (POSIX/Windows-absolute, backslash,
 * parent-directory, encoded/null-byte traversal all rejected). Returns the
 * validated (decoded) path — the EXACT form `safePath` approved — or
 * `undefined` when it is unsafe or resolves to the skill root itself.
 */
function normalizeAdvertisedPath(advertisedPath: string): string | undefined {
  const segs = advertisedPath.split("/").filter((s) => s.length > 0 && s !== ".");
  const unsafe =
    advertisedPath.startsWith("/") ||
    /^[A-Za-z]:/.test(advertisedPath) ||
    advertisedPath.includes("\\") ||
    segs.length === 0 ||
    segs.some((s) => s === "..");
  if (unsafe) return undefined;
  let resolved: string;
  try {
    resolved = safePath(NOTIONAL_BASE, ...segs);
  } catch {
    return undefined;
  }
  // Return the SAME containment-checked form safePath approved. It decodes
  // percent-encoding before validating, so deriving the rel-path from its
  // resolved result guarantees the value propagated to the fetch URL and the
  // on-disk path is exactly the value that was validated — never a still-encoded
  // string that only survives because a later layer re-decodes and re-checks it.
  const rel = path.relative(NOTIONAL_BASE, resolved);
  return rel.length > 0 ? rel.split(path.sep).join("/") : undefined;
}

// ---------------------------------------------------------------------------
// Fetch helpers (SSRF-pinned + byte-capped) — mirror the acquire step
// ---------------------------------------------------------------------------

function mkErr(errorKind: ErrorKind, message: string, hint: string): WellKnownResolveError {
  return { errorKind, message, hint };
}

function overCapError(maxBytes: number, what: string): WellKnownResolveError {
  return mkErr(
    "resource",
    `${what} exceeds the ${maxBytes}-byte skills.import.maxFileBytes cap`,
    "raise skills.import.maxFileBytes or reduce the published file size",
  );
}

/**
 * Stream a response body into a Buffer, enforcing `maxBytes` against BOTH the
 * declared Content-Length (pre-stream) and the streamed size (a server may
 * under-declare). The cap key is named in the reject hint.
 *
 * The stream read loop is wrapped so a body error AFTER the headers arrive — a
 * connection reset mid-body, or the per-fetch 30s streaming timeout firing
 * during `read()` (a slow/stalled registry) — returns a TYPED reject naming the
 * registry, never an uncaught throw. That keeps the resolver's "never throws"
 * contract and the §2.7 WARN + hint intact for this realistic failure branch.
 */
async function readCappedBody(
  response: ArchiveHttpResponse,
  maxBytes: number,
  what: string,
  registryOrigin: string,
): Promise<Result<Buffer, WellKnownResolveError>> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      await response.body?.cancel();
      return err(overCapError(maxBytes, what));
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
        return err(overCapError(maxBytes, what));
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
          `reading ${what} from ${registryOrigin} timed out mid-stream (the 30s per-fetch cap fired while the body was streaming)`,
          "the registry sent headers then stalled the body; verify it responds fully within 30s",
        ),
      );
    }
    return err(
      mkErr(
        "dependency",
        `reading ${what} from ${registryOrigin} failed mid-stream: ${e instanceof Error ? e.message : String(e)}`,
        "verify the registry is reachable and responsive; the fetch is pinned to the SSRF-validated IP and aborts after 30s",
      ),
    );
  }
  return ok(Buffer.concat(chunks));
}

/** SSRF-validate → IP-pinned fetch → byte-capped read. Every fetch funnels here. */
async function fetchCapped(
  url: string,
  what: string,
  registryOrigin: string,
  maxBytes: number,
  validate: ArchiveUrlValidator,
  fetchImpl: PinnedArchiveFetch,
): Promise<Result<Buffer, WellKnownResolveError>> {
  const validated = await validate(url);
  if (!validated.ok) {
    return err(
      mkErr(
        "validation",
        `${what} URL at ${registryOrigin} was blocked by the SSRF guard: ${validated.error.message}`,
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
        `fetching ${what} from ${registryOrigin} failed: ${e instanceof Error ? e.message : String(e)}`,
        "verify the registry is reachable; the connection is pinned to the SSRF-validated IP",
      ),
    );
  }

  if (!response.ok) {
    return err(
      mkErr(
        "network",
        `the registry ${registryOrigin} returned HTTP ${response.status} for ${what}`,
        "verify the registry publishes /.well-known/skills/index.json and the skill's advertised files",
      ),
    );
  }

  return readCappedBody(response, maxBytes, what, registryOrigin);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

async function resolveInner(
  input: { registry: string; name: string },
  deps: WellKnownResolveDeps,
): Promise<Result<WellKnownResolved, WellKnownResolveError>> {
  const { caps } = deps;
  const validate: ArchiveUrlValidator = deps.validate ?? validateUrl;
  // The cast adapts the real IP-pinned fetch (an undici Response) to the narrow
  // seam shape used here; tests inject a conforming stub.
  const fetchImpl: PinnedArchiveFetch = deps.fetchImpl ?? (fetchPinned as unknown as PinnedArchiveFetch);

  // 1. Normalize the registry to a port-preserving, exact origin. `new URL().origin`
  //    lowercases the host, keeps a non-default port, and omits a default one — so
  //    `example.com` never matches `evil-example.com`.
  let registryOrigin: string;
  try {
    registryOrigin = new URL(input.registry).origin;
  } catch {
    return err(
      mkErr("validation", `the registry "${input.registry}" is not a valid URL`, "supply the registry as an http(s) origin, e.g. https://registry.example"),
    );
  }
  if (!registryOrigin.startsWith("http://") && !registryOrigin.startsWith("https://")) {
    return err(
      mkErr("validation", `the registry "${input.registry}" is not an http(s) origin`, "supply the registry as an http(s) origin, e.g. https://registry.example"),
    );
  }

  // 2. Resolve the index — a cache hit short-circuits the fetch; a miss fetches,
  //    Zod-validates the observed shape, and caches names + paths only.
  const originKey = createHash("sha256").update(registryOrigin).digest("hex");
  let entries: readonly CachedIndexEntry[];
  const cached = deps.cache?.get(originKey);
  if (cached !== undefined) {
    entries = cached;
  } else {
    const indexUrl = `${registryOrigin}/.well-known/skills/index.json`;
    deps.logger?.debug({ step: "index", registryOrigin }, "well-known resolve: fetching index");
    const indexBody = await fetchCapped(indexUrl, "the well-known index", registryOrigin, caps.maxFileBytes, validate, fetchImpl);
    if (!indexBody.ok) return indexBody;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(indexBody.value.toString("utf-8"));
    } catch {
      return err(
        mkErr(
          "validation",
          `the well-known index at ${registryOrigin} is not valid JSON`,
          `verify ${registryOrigin}/.well-known/skills/index.json publishes {skills:[{name,description,files?}]}`,
        ),
      );
    }
    const shape = WellKnownIndexSchema.safeParse(parsedJson);
    if (!shape.success) {
      return err(
        mkErr(
          "validation",
          `the skill index at ${registryOrigin} did not match the expected shape`,
          `verify ${registryOrigin}/.well-known/skills/index.json publishes {skills:[{name,description,files?}]}`,
        ),
      );
    }
    entries = shape.data.skills.map((s) => ({ name: s.name, ...(s.files !== undefined && { files: s.files }) }));
    deps.cache?.put(originKey, entries);
  }

  // 3. Look up the requested skill in the resolved index.
  const skill = entries.find((e) => e.name === input.name);
  if (skill === undefined) {
    return err(
      mkErr(
        "validation",
        `the registry ${registryOrigin} does not advertise a skill named "${input.name}"`,
        `verify the skill name against ${registryOrigin}/.well-known/skills/index.json`,
      ),
    );
  }

  // 4. The advertised rel-paths — the manifest is the default when none are listed.
  const advertised = skill.files ?? ["SKILL.md"];

  // 5. Bound the advertised fan-out BEFORE fetching — a poisoned index cannot fan
  //    out into unbounded fetches (the pipeline does not bound a file set's count).
  if (advertised.length > caps.maxFileCount) {
    return err(
      mkErr(
        "validation",
        `the registry ${registryOrigin} advertises ${advertised.length} files for "${input.name}", over the ${caps.maxFileCount}-file skills.import.maxFileCount cap`,
        "raise skills.import.maxFileCount or trim the skill's advertised files",
      ),
    );
  }

  // 6. Validate EVERY advertised path BEFORE any fetch — one unsafe path refuses
  //    the whole skill (a traversal attempt never reaches the network).
  const relPaths: string[] = [];
  for (const advertisedPath of advertised) {
    const normalized = normalizeAdvertisedPath(advertisedPath);
    if (normalized === undefined) {
      return err(
        mkErr(
          "validation",
          `the registry ${registryOrigin} advertises an unsafe path "${advertisedPath}" for "${input.name}"; the whole skill is refused`,
          "advertised paths must be skill-root-relative with no absolute, backslash, or parent-directory segments",
        ),
      );
    }
    relPaths.push(normalized);
  }

  // 7. Fetch each advertised file — SSRF-pinned + byte-capped, same as the index.
  const files: FileSetFile[] = [];
  for (const rel of relPaths) {
    const fileUrl = `${registryOrigin}/.well-known/skills/${input.name}/${rel}`;
    deps.logger?.debug({ step: "file", registryOrigin, rel }, "well-known resolve: fetching file");
    const fileBody = await fetchCapped(fileUrl, `the file "${rel}"`, registryOrigin, caps.maxFileBytes, validate, fetchImpl);
    if (!fileBody.ok) return fileBody;
    files.push({ path: rel, content: fileBody.value.toString("utf-8") });
  }

  // 8. Require the SKILL.md manifest — a skill without one is refused loud (the
  //    convention places the manifest at the skill root).
  if (!files.some((f) => f.path === "SKILL.md")) {
    return err(
      mkErr(
        "validation",
        `the skill "${input.name}" at ${registryOrigin} does not include a SKILL.md manifest`,
        `verify ${registryOrigin}/.well-known/skills/${input.name}/ advertises a SKILL.md`,
      ),
    );
  }

  // 9. Build the stable per-(registry,name) identifier + return the file set. The
  //    contentHash is NOT computed here: the pipeline hashes the INSTALLED set
  //    (post-drop) downstream, so it reflects exactly what lands on disk.
  const identifier = `${registryOrigin}/.well-known/skills/${input.name}/`;
  return ok({ files, identifier, registryOrigin });
}

/**
 * Resolve a `{ registry, name }` pair to its skill file set, SSRF-pinned and
 * byte-capped on every fetch. Never throws — a reject is a typed
 * {@link WellKnownResolveError}. Emits an object-first outcome line (an INFO on
 * success, a WARN naming the registry on a reject).
 */
export async function resolveWellKnown(
  input: { registry: string; name: string },
  deps: WellKnownResolveDeps,
): Promise<Result<WellKnownResolved, WellKnownResolveError>> {
  const startedMs = systemNowMs();
  let result: Result<WellKnownResolved, WellKnownResolveError>;
  try {
    result = await resolveInner(input, deps);
  } catch (e) {
    // The contract is "never throws" — a reject is always a typed
    // WellKnownResolveError. This catch-all guarantees it even for an unforeseen
    // fault, so the typed-Result seam and the WARN below always hold.
    result = err(
      mkErr(
        "internal",
        `well-known resolve threw unexpectedly: ${e instanceof Error ? e.message : String(e)}`,
        "an internal resolver fault; inspect the daemon log for the stack trace",
      ),
    );
  }
  const durationMs = systemNowMs() - startedMs;
  if (result.ok) {
    deps.logger?.info(
      { registryOrigin: result.value.registryOrigin, fileCount: result.value.files.length, durationMs },
      "well-known resolve: resolved skill file set",
    );
  } else {
    deps.logger?.warn(
      { errorKind: result.error.errorKind, hint: result.error.hint, durationMs },
      `well-known resolve: ${result.error.message}`,
    );
  }
  return result;
}
