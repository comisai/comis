// SPDX-License-Identifier: Apache-2.0
/**
 * Acquire step for the staged skill import — the single entry point every
 * source funnels through before staging.
 *
 * Three source shapes converge here:
 *   - `archiveUrl`: fetched SSRF-pinned (`validateUrl` resolves + classifies the
 *     host, then the socket is pinned to that IP via `fetchPinned`, closing the
 *     DNS-rebinding window) and byte-capped at `maxArchiveBytes` against BOTH
 *     the declared Content-Length AND the actually-streamed bytes (a server may
 *     under-declare). A blocked / loopback / cloud-metadata target is rejected
 *     before any connection is opened.
 *   - `archiveBytes`: base64 that is size-capped BEFORE decode (an over-cap
 *     payload never materializes), then decoded.
 *   - `fileSet`: an already-resolved `{ path, content }[]` that passes through
 *     untouched (no fetch) — the clean seam the upload / GitHub retrofit and the
 *     later registry resolvers enter at.
 *
 * There is no fixed-host fetch exception in this module: every network fetch
 * goes through the SSRF guard. Result-typed throughout; no throws escape.
 *
 * @module
 */
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { validateUrl, type ErrorKind } from "@comis/core";
import { fetchPinned } from "../../tools/integrations/pinned-fetch.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One already-resolved file in a pass-through source. */
export interface FileSetFile {
  /** Skill-root-relative path (the manifest is `SKILL.md`). */
  readonly path: string;
  /** File content as text. */
  readonly content: string;
}

/** The discriminated input to {@link acquire}. */
export type AcquireInput =
  | { readonly kind: "archiveUrl"; readonly url: string }
  | { readonly kind: "archiveBytes"; readonly base64: string }
  | { readonly kind: "fileSet"; readonly files: readonly FileSetFile[] };

/** Fetched / decoded archive bytes, to be unpacked next. */
export interface AcquiredArchive {
  readonly kind: "archive";
  readonly bytes: Buffer;
}

/** A pass-through file set (no unpack needed). */
export interface AcquiredFileSet {
  readonly kind: "fileSet";
  readonly files: readonly FileSetFile[];
}

/** The acquire result union. */
export type Acquired = AcquiredArchive | AcquiredFileSet;

/** A typed acquire reject carrying an operator hint + a closed-union kind. */
export interface AcquireError {
  readonly message: string;
  readonly hint: string;
  readonly errorKind: ErrorKind;
}

/** The one cap the acquire step enforces (the compressed-fetch / decode bound). */
export interface AcquireCaps {
  readonly maxArchiveBytes: number;
}

// The archiveUrl fetch is expressed through two narrow seams so it is fully
// unit-testable off-network; the defaults wire the real SSRF-pinned primitives.

/** Read side of a fetch response body (a web ReadableStream reader). */
export interface ArchiveBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/** A fetch response body. */
export interface ArchiveResponseBody {
  getReader(): ArchiveBodyReader;
  cancel(reason?: unknown): Promise<void>;
}

/** The minimal fetch response shape the capped reader consumes. */
export interface ArchiveHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ArchiveResponseBody | null;
}

/** DNS-resolve + SSRF-classify a URL (defaults to the core `validateUrl`). */
export type ArchiveUrlValidator = (
  url: string,
) => Promise<Result<{ readonly hostname: string; readonly ip: string }, Error>>;

/** IP-pinned fetch (defaults to `fetchPinned`). */
export type PinnedArchiveFetch = (
  url: string,
  pinnedIp: string,
  init?: { redirect?: "error"; signal?: AbortSignal },
) => Promise<ArchiveHttpResponse>;

/** Dependencies for {@link acquire}. */
export interface AcquireDeps {
  readonly caps: AcquireCaps;
  /** Test seam: URL validator. Default = the core SSRF `validateUrl`. */
  readonly validate?: ArchiveUrlValidator;
  /** Test seam: the IP-pinned fetch. Default = `fetchPinned`. */
  readonly fetchImpl?: PinnedArchiveFetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkErr(errorKind: ErrorKind, message: string, hint: string): AcquireError {
  return { errorKind, message, hint };
}

function overCapError(maxArchiveBytes: number): AcquireError {
  return mkErr(
    "resource",
    `the archive exceeds the ${maxArchiveBytes}-byte maxArchiveBytes cap`,
    "raise skills.import.maxArchiveBytes or provide a smaller archive",
  );
}

/**
 * Stream a response body into a Buffer, enforcing `maxBytes` against BOTH the
 * declared Content-Length (pre-stream) and the streamed size (a server may
 * under-declare). Mirrors the shared SSRF fetcher's capped-read contract; the
 * cap key is named in the reject hint.
 */
async function readCappedBody(
  response: ArchiveHttpResponse,
  maxBytes: number,
): Promise<Result<Buffer, AcquireError>> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      await response.body?.cancel();
      return err(overCapError(maxBytes));
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return err(
      mkErr("network", "the archive response carried no body", "the remote host returned an empty response; verify the archive URL"),
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return err(overCapError(maxBytes));
    }
    chunks.push(value);
  }
  return ok(Buffer.concat(chunks));
}

async function acquireArchiveUrl(url: string, deps: AcquireDeps): Promise<Result<Acquired, AcquireError>> {
  const validate: ArchiveUrlValidator = deps.validate ?? validateUrl;
  const validated = await validate(url);
  if (!validated.ok) {
    return err(
      mkErr(
        "validation",
        `the archive URL was blocked by the SSRF guard: ${validated.error.message}`,
        "host the archive on a public, non-loopback, non-metadata address; the fetch is DNS-pinned and refuses internal targets",
      ),
    );
  }

  // The cast adapts the real IP-pinned fetch (an undici Response) to the narrow
  // seam shape used here; tests inject a conforming stub.
  const fetchImpl: PinnedArchiveFetch = deps.fetchImpl ?? (fetchPinned as unknown as PinnedArchiveFetch);

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
        `fetching the archive failed: ${e instanceof Error ? e.message : String(e)}`,
        "verify the archive URL is reachable; the connection is pinned to the SSRF-validated IP",
      ),
    );
  }

  if (!response.ok) {
    return err(
      mkErr(
        "network",
        `the archive host returned HTTP ${response.status}`,
        "verify the archive URL is correct and publicly reachable",
      ),
    );
  }

  const body = await readCappedBody(response, deps.caps.maxArchiveBytes);
  if (!body.ok) return body;
  return ok({ kind: "archive", bytes: body.value });
}

function acquireArchiveBytes(base64: string, deps: AcquireDeps): Result<Acquired, AcquireError> {
  // Upper-bound the decoded size from the base64 length and reject BEFORE
  // decoding, so an over-cap payload never materializes in memory.
  const estimated = Math.floor((base64.length * 3) / 4);
  if (estimated > deps.caps.maxArchiveBytes) {
    return err(overCapError(deps.caps.maxArchiveBytes));
  }
  // The estimate is a true upper bound on the decoded size (padding and ignored
  // whitespace only reduce it), so a payload that clears the pre-decode check is
  // within the cap once decoded.
  return ok({ kind: "archive", bytes: Buffer.from(base64, "base64") });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Acquire the raw skill bytes / files from one source. Every `archiveUrl` fetch
 * is SSRF-pinned and byte-capped; `archiveBytes` is size-capped before decode;
 * a `fileSet` passes through untouched. Never throws — a reject is a typed
 * {@link AcquireError}.
 */
export async function acquire(
  input: AcquireInput,
  deps: AcquireDeps,
): Promise<Result<Acquired, AcquireError>> {
  switch (input.kind) {
    case "archiveUrl":
      return acquireArchiveUrl(input.url, deps);
    case "archiveBytes":
      return acquireArchiveBytes(input.base64, deps);
    case "fileSet":
      return ok({ kind: "fileSet", files: input.files });
  }
}
