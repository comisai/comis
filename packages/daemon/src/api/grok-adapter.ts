// SPDX-License-Identifier: Apache-2.0
// @allow-throw: integration/REST boundary wrapper; throws caught by fromPromise at the port boundary.
/**
 * xAI Grok Imagine video adapter (GROK-01 / GROK-02).
 *
 * A `VideoGenerationPort` over the xAI REST video API. Unlike the FAL adapter
 * (an SDK queue) and the Veo adapter (an SDK LRO), xAI ships NO JS SDK for video
 * — this adapter is RAW `fetch` against `api.x.ai/v1/videos`:
 *   - submit:  `POST /v1/videos/generations { model, prompt, ... }` → the REST
 *              `request_id` is the durable, secret-free jobId (VPORT-03) —
 *              DIFFERS from Veo's `operation.name`.
 *   - poll:    `GET /v1/videos/{request_id}` → a `status` STRING union
 *              `pending | done | failed | expired`. The `failed`+`expired`
 *              terminals DIFFER from FAL (no failed status) and Veo (an
 *              `operation.error` object) — both map to the normalized `"failed"`.
 *   - fetch:   `status:"done"` → `video.url` fetched → a Buffer (DEL-01:
 *              download BEFORE return so the expiring CDN URL can never orphan
 *              the job); `usage.cost_in_usd_ticks / 1e10` → the ACTUAL cost.
 *
 * WIRE-ENCODING DIFFERENCES (vs FAL/Veo): `duration` is an INTEGER seconds value
 * (NOT the FAL `${n}s` string, NOT Veo's `durationSeconds`); resolution is
 * `480p`/`720p` ONLY (the corrected live-doc drift — NOT 1080p; validated
 * upstream by the Phase 191 VIDEO_MODELS matrix, passed through here). The model
 * default is `grok-imagine-video` — the ONLY documented GA id; gate any
 * `-preview` behind config.
 *
 * COST (GROK-02): `reconcileTicksToUsd` converts `cost_in_usd_ticks` to USD
 * (1 USD = 1e10 ticks, CITED docs.x.ai) and GUARDS against a non-number / NaN /
 * non-finite / NEGATIVE value — a spoofed-negative `cost_in_usd_ticks` must NOT
 * produce a negative `costUsd` that under-reports spend and bypasses the SHIPPED
 * cost ceiling (T-190-09). An invalid/absent value → `undefined`, so the handler
 * falls back to the pre-submit estimate.
 *
 * AUTH (A1 — key-primary, OAuth defensive): the `XAI_API_KEY` Bearer is the
 * WIRED/proven PRIMARY path. A SuperGrok OAuth branch is built DEFENSIVELY in the
 * codex-image-adapter per-call-bearer shape so CRED-01's key-or-OAuth contract
 * holds structurally — BUT there is NO xai/SuperGrok OAuth provider registered in
 * the codebase today (`oauthManager.getSupportedProviders()` returns only
 * `openai-codex`), so the OAuth branch is forward-looking: it activates when/if
 * pi-ai adds an xAI OAuth provider. Key-auth is the documented common case; GROK
 * is NOT blocked on OAuth. The static `XAI_API_KEY` is BOOT-BOUND (captured at
 * construction, rotation needs a daemon restart); only the defensive OAuth branch
 * is per-call-fresh (WR-03 — see `resolveBearer`).
 *
 * PLACEMENT: this adapter lives in `@comis/daemon/src/api/` (NOT `@comis/skills`,
 * where `fal-adapter.ts` lives). The OAuth path needs the daemon-side
 * `OAuthTokenManager`, and the daemon-side placement matches the codex/Veo
 * precedent — building it in skills would be a phantom-dep / cycles violation.
 * The bounded-download helpers are COPIED from `fal-adapter.ts` (private there)
 * rather than imported, to avoid a skills→daemon import edge (the FAL file's
 * comment directs this).
 *
 * SECURITY: the bearer (key OR OAuth token) flows ONLY into the `Authorization`
 * header — NEVER to a logger. The `request_id` jobId is opaque + secret-free
 * (safe to log — VPORT-03). If `opts.logger` is used, only `{ model, jobId, step }`
 * shapes are logged.
 *
 * @module
 */
import type {
  OAuthTokenManager,
  VideoGenerationPort,
  VideoGenInput,
  VideoGenJob,
  VideoJobStatus,
  VideoGenOutput,
} from "@comis/core";
import { VideoGenError, createPollDeadline, pollUntilDone } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { err, fromPromise, ok } from "@comis/shared";
import { classifyGrokVideoError } from "./classify-grok-video-error.js";

/** xAI REST video API base (re-verified 2026-06-15; drifts ~monthly). */
const XAI_VIDEO_BASE = "https://api.x.ai/v1";

/**
 * Default Grok video model — the ONLY documented GA id (re-verified 2026-06-15;
 * `grok-imagine-video-1.5-preview` from the design §15 sketch is NOT in live
 * docs). LOCK: a `-preview` id is config-only, never the default.
 */
const DEFAULT_GROK_MODEL = "grok-imagine-video";

/**
 * The ASSUMED SuperGrok OAuth provider id (A1 — UNVERIFIED/forward-looking). No
 * xai OAuth provider is registered in the codebase today; this id is used only by
 * the defensive OAuth branch and activates when/if pi-ai adds one.
 *
 * IN-02 (Phase 190): EXPORTED as the single source of truth — the boot selector
 * (setup-video-provider.ts) gates `oauthManager.hasCredentials(...)` on this SAME
 * constant rather than a bare `"xai"` literal, so the selector's credsAvailable
 * gate can never drift from what the adapter actually resolves if a future xai
 * OAuth provider registers under a different id.
 */
export const XAI_OAUTH_PROVIDER_ID = "xai";

/**
 * WR-01: hard fallback timeout for the result download when the caller threads no
 * AbortSignal (a standalone `fetchResult` from Phase 189's poller). Bounds a hung
 * CDN on the download leg. Copied from fal-adapter.ts.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * WR-01: default streamed byte ceiling for the result download (a Content-Length
 * pre-check + a streamed running total → OOM guard). 200 MB matches
 * VIDEO_PERSIST_MAX_BYTES. Copied from fal-adapter.ts.
 */
const DEFAULT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** Options bounding the result download (WR-01). Copied from fal-adapter.ts. */
export interface VideoFetchResultOpts {
  signal?: AbortSignal;
  maxBytes?: number;
}

/** The xAI `GET /v1/videos/{request_id}` status payload (the untrusted poll body). */
interface GrokVideoStatus {
  status: string;
  progress?: number;
  video?: { url?: string };
  usage?: { cost_in_usd_ticks?: number };
  error?: { code?: string; message?: string };
}

/**
 * Create an xAI Grok Imagine video-generation adapter over the REST video API.
 *
 * @param opts.apiKey       - The `XAI_API_KEY` Bearer (the PRIMARY, wired path;
 *   flows ONLY into the `Authorization` header, never logged). Exactly one of
 *   `apiKey`/`oauthManager` is the auth source; the key wins when present.
 * @param opts.oauthManager - The DEFENSIVE SuperGrok OAuth manager (A1 —
 *   forward-looking; no xai OAuth provider registered today). Its `getApiKey`
 *   refreshes inside on expiry; `hasCredentials` backs `isAvailable`.
 * @param opts.oauthProfiles - The agent's `Record<provider, profileId>` map,
 *   passed to `getApiKey` for per-agent profile preference.
 * @param opts.model        - Optional override of {@link DEFAULT_GROK_MODEL}.
 * @param opts.logger       - Logger for the `{ model, jobId, step }` debug shapes only.
 * @param opts.fetchImpl    - Injectable `fetch` (default `globalThis.fetch`) so
 *   the adapter is deterministically testable without mutating globals.
 */
export function createGrokVideoAdapter(opts: {
  apiKey?: string;
  oauthManager?: OAuthTokenManager;
  oauthProfiles?: Record<string, string>;
  model?: string;
  logger?: ComisLogger;
  fetchImpl?: typeof fetch;
}): VideoGenerationPort {
  const model = opts.model ?? DEFAULT_GROK_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;

  /**
   * Resolve the Bearer on each submit/poll/fetchResult call. The two auth sources
   * differ in freshness (WR-03 — the comment matches the behavior):
   *   - STATIC KEY (the proven primary): `opts.apiKey` is captured by this closure
   *     at construction and returned verbatim — it is BOOT-BOUND, NOT re-read from
   *     the secret store per call, so a key rotation requires a daemon restart to
   *     take effect (parity with the Veo adapter's GoogleGenAI instance + the
   *     "key rotation requires a daemon restart" boot-built contract). A future
   *     per-call re-selection is the deferred multi-agent per-agent re-read.
   *   - DEFENSIVE OAUTH (A1, forward-looking): `getApiKey` IS per-call-fresh —
   *     it refreshes on expiry inside the manager (the codex per-call-bearer idiom).
   * The bearer flows ONLY into the `Authorization` header, never to a logger.
   */
  const resolveBearer = async (): Promise<string> => {
    if (opts.apiKey !== undefined) return opts.apiKey;
    if (opts.oauthManager) {
      const tok = await opts.oauthManager.getApiKey(XAI_OAUTH_PROVIDER_ID, {
        oauthProfiles: opts.oauthProfiles,
      });
      if (!tok.ok) {
        // ALL !ok OAuthError codes → honest auth_required + a key-or-login hint.
        throw new VideoGenError("xAI Grok video is not authenticated.", {
          videoErrorKind: "auth_required",
          hint: 'Set XAI_API_KEY, or run "comis auth login" for SuperGrok.',
        });
      }
      return tok.value;
    }
    throw new VideoGenError("xAI Grok video is not authenticated.", {
      videoErrorKind: "auth_required",
      hint: "Set the XAI_API_KEY secret (or authenticate SuperGrok via OAuth).",
    });
  };

  /** Build a classified VideoGenError from a terminal failed/expired status. */
  const classifiedError = (body: GrokVideoStatus): VideoGenError => {
    const c = classifyGrokVideoError(body.error, { status: body.status as "failed" | "expired" });
    return new VideoGenError(c.hint, c);
  };

  /** Build the empty_response VideoGenError (done-but-no-video.url). */
  const mapEmpty = (): VideoGenError => {
    const c = classifyGrokVideoError(null, { emptyResult: true });
    return new VideoGenError(c.hint, c);
  };

  return {
    id: "grok",
    // CRED-01: availability is a present key OR the (forward-looking) OAuth
    // manager reporting credentials for the xai provider (A1 — no-op today).
    isAvailable: () =>
      opts.apiKey !== undefined || (opts.oauthManager?.hasCredentials(XAI_OAUTH_PROVIDER_ID) ?? false),

    submit(input: VideoGenInput): Promise<Result<VideoGenJob, Error>> {
      return fromPromise(
        (async () => {
          // WR-03: the PER-REQUEST `input.model` (what the IN-02 handler validated
          // against, `params.model ?? config.model`) wins over the construction
          // default so validation and execution AGREE. poll()/fetchResult() key on
          // the request_id URL (not the model), so the effective model only matters
          // here at submit + on `job.model` (obs + the persisted row).
          const effectiveModel = input.model ?? model;
          const bearer = await resolveBearer();
          const res = await doFetch(`${XAI_VIDEO_BASE}/videos/generations`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
            body: JSON.stringify(buildGrokBody(input, effectiveModel)),
          });
          if (!res.ok) {
            throw new Error(`xai: submit HTTP ${res.status}`); // -> classifyGrokVideoError
          }
          const { request_id } = (await res.json()) as { request_id?: string };
          if (!request_id) {
            throw new Error("xai: submit returned no request_id");
          }
          const job: VideoGenJob = {
            jobId: request_id, // opaque, secret-free, stable across poll() (VPORT-03)
            provider: "grok",
            model: effectiveModel, // WR-03: the model that actually rendered
          };
          opts.logger?.debug(
            { model: effectiveModel, jobId: job.jobId, step: "video.submit" },
            "grok: submitted render",
          );
          return job;
        })(),
      );
    },

    poll(job: VideoGenJob): Promise<Result<VideoJobStatus, Error>> {
      return fromPromise(
        (async () => {
          const bearer = await resolveBearer();
          const res = await doFetch(`${XAI_VIDEO_BASE}/videos/${encodeURIComponent(job.jobId)}`, {
            headers: { Authorization: `Bearer ${bearer}` },
          });
          if (!res.ok) {
            throw new Error(`xai: poll HTTP ${res.status}`);
          }
          const body = (await res.json()) as GrokVideoStatus;
          // The status union DIFFERS from FAL/Veo: failed+expired are terminal
          // failures (both → "failed"); anything not done/failed/expired is pending.
          const state: VideoJobStatus["state"] =
            body.status === "done" ? "done" : body.status === "failed" || body.status === "expired" ? "failed" : "pending";
          // WR-01: on a terminal failed/expired, thread the SAME classified
          // kind+hint the execute() path emits onto the snapshot (reusing the
          // existing classifier — `body.status` is the failed|expired discriminant
          // here) so the off-turn poller persists the specific kind + actionable
          // hint instead of collapsing to empty_response. The hint is a FIXED
          // auth/quota/content string — never the raw error message/bearer.
          if (state === "failed") {
            const c = classifyGrokVideoError(body.error, { status: body.status as "failed" | "expired" });
            return { jobId: job.jobId, state, errorKind: c.videoErrorKind, hint: c.hint } satisfies VideoJobStatus;
          }
          return { jobId: job.jobId, state } satisfies VideoJobStatus;
        })(),
      );
    },

    fetchResult(job: VideoGenJob, fetchOpts?: VideoFetchResultOpts): Promise<Result<VideoGenOutput, Error>> {
      return fromPromise(
        (async () => {
          const bearer = await resolveBearer();
          const res = await doFetch(`${XAI_VIDEO_BASE}/videos/${encodeURIComponent(job.jobId)}`, {
            headers: { Authorization: `Bearer ${bearer}` },
          });
          if (!res.ok) {
            throw new Error(`xai: fetchResult HTTP ${res.status}`);
          }
          const body = (await res.json()) as GrokVideoStatus;
          if (body.status === "failed" || body.status === "expired") {
            throw classifiedError(body); // -> classified failed/expired
          }
          const url = body.video?.url;
          if (!url) {
            throw mapEmpty(); // -> empty_response (done-but-no-video.url)
          }
          // DEL-01: download the expiring CDN URL to a Buffer BEFORE returning.
          // The download leg uses the SAME injected `doFetch` as submit/poll, so
          // the adapter is deterministically testable without mutating globals.
          const { buffer, contentType } = await downloadVideoBytes(url, doFetch, fetchOpts);
          // GROK-02: reconcile the ACTUAL cost from cost_in_usd_ticks, GUARDED
          // against a spoofed negative/NaN (never a cost-ceiling bypass).
          const costUsd = reconcileTicksToUsd(body.usage?.cost_in_usd_ticks);
          // WR-03: the output model reflects what actually rendered — `job.model`
          // (set at submit from `input.model ?? construction model`; round-tripped
          // through the persisted row to the off-turn poller) when present, else
          // the construction default.
          const outModel = job.model || model;
          opts.logger?.debug({ model: outModel, jobId: job.jobId, step: "video.fetch" }, "grok: downloaded result");
          return {
            buffer,
            mimeType: deriveVideoMime(contentType, url),
            sourceUrl: url,
            model: outModel,
            provider: "grok",
            ...(costUsd !== undefined ? { costUsd } : {}),
          } satisfies VideoGenOutput;
        })(),
      );
    },

    async execute(
      input: VideoGenInput,
      runOpts: { timeoutMs: number; pollIntervalMs: number; signal?: AbortSignal },
    ): Promise<Result<VideoGenOutput, Error>> {
      const submitted = await this.submit(input);
      if (!submitted.ok) return mapThrownToErr(submitted.error);
      const job = submitted.value;

      const deadline = createPollDeadline(runOpts.timeoutMs);
      let lastErr: Error | undefined;
      const outcome = await pollUntilDone<VideoJobStatus>({
        poll: async () => {
          const p = await this.poll(job);
          if (!p.ok) {
            // A thrown HTTP error from the poll GET — capture it for
            // classification, then signal `failed` so the loop short-circuits.
            lastErr = p.error;
            return { jobId: job.jobId, state: "failed" };
          }
          if (p.value.state === "failed") {
            // A terminal failed/expired status — re-read the status payload so the
            // loop's failed branch yields the classified kind+hint (not "job failed").
            lastErr = await readStatusError(job, resolveBearer, doFetch);
          }
          return p.value;
        },
        isDone: (s) => s.state === "done",
        isFailed: (s) => s.state === "failed",
        deadline,
        pollIntervalMs: runOpts.pollIntervalMs,
        signal: runOpts.signal,
      });

      if (outcome.kind === "timeout") {
        const hint = `Video render exceeded ${runOpts.timeoutMs}ms (jobId=${job.jobId}).`;
        return err(new VideoGenError(hint, { videoErrorKind: "job_timeout", hint }));
      }
      if (outcome.kind === "failed") {
        return mapThrownToErr(lastErr ?? new Error("grok: job failed"));
      }

      const fetched = await this.fetchResult(job, runOpts.signal ? { signal: runOpts.signal } : undefined);
      if (!fetched.ok) {
        return mapThrownToErr(fetched.error);
      }
      // WR-05: when the provider reports no duration, fall back to the duration WE
      // requested so the handler's reconcile + delivery metadata is not empty.
      if (fetched.value.durationSecs === undefined && input.durationSecs !== undefined) {
        return ok({ ...fetched.value, durationSecs: input.durationSecs });
      }
      return fetched;
    },
  };
}

/**
 * Re-read the status payload of a terminal failed/expired Grok job and turn it
 * into a classified `VideoGenError`. The poll loop's `failed` branch maps this so
 * the caller gets the auth/content/quota/expired kind + hint (not a generic
 * "job failed"). A throw here (a network error on the re-read) is returned as-is.
 */
async function readStatusError(
  job: VideoGenJob,
  resolveBearer: () => Promise<string>,
  doFetch: typeof fetch,
): Promise<Error> {
  try {
    const bearer = await resolveBearer();
    const res = await doFetch(`${XAI_VIDEO_BASE}/videos/${encodeURIComponent(job.jobId)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return new Error(`xai: poll HTTP ${res.status}`);
    const body = (await res.json()) as GrokVideoStatus;
    const c = classifyGrokVideoError(body.error, { status: body.status as "failed" | "expired" });
    return new VideoGenError(c.hint, c);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * THE COST GUARD (GROK-02 / T-190-09 / SEC). Convert `cost_in_usd_ticks` to USD
 * (1 USD = 1e10 ticks — CITED docs.x.ai). Returns `undefined` for any
 * non-number / NaN / non-finite / NEGATIVE value: a spoofed-negative
 * `cost_in_usd_ticks` must NEVER produce a negative `costUsd` that under-reports
 * the spend and bypasses `maxCostPerHourUsd`. An invalid/absent value → undefined
 * (the handler falls back to the conservative pre-submit estimate).
 */
function reconcileTicksToUsd(ticks: unknown): number | undefined {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return undefined;
  return ticks / 1e10;
}

/**
 * Map a normalized `VideoGenInput` to the xAI request body (GROK-01). `duration`
 * is an INTEGER seconds value (NOT the FAL `${n}s` string, NOT Veo's
 * `durationSeconds`); resolution is validated to `480p`/`720p` upstream (the
 * Phase 191 VIDEO_MODELS matrix — passed through here). Omitted input fields are
 * ABSENT (the `...(x !== undefined ? {k:x} : {})` idiom — no `undefined` keys).
 *
 * IN-01 (Phase 191): when a first-frame `referenceImage` is present (i2v), add
 * `image` to the body — xAI accepts `{ url | file_id }`; we use the data-URI
 * `{ url }` form. SAME `grok-imagine-video` model id for t2v AND i2v (no endpoint
 * swap, unlike FAL). Only the SINGULAR referenceImage is consumed; the additive
 * `referenceImages` array (Grok `reference_images[]`) is a LOCKED fast-follow
 * deferral — not mapped here this phase.
 */
function buildGrokBody(input: VideoGenInput, model: string): Record<string, unknown> {
  return {
    model,
    prompt: input.prompt,
    ...(input.referenceImage
      ? { image: { url: `data:${input.referenceImage.mimeType};base64,${input.referenceImage.data}` } }
      : {}),
    ...(input.durationSecs !== undefined ? { duration: input.durationSecs } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
  };
}

/**
 * WR-07 (trust boundary): `url` is the xAI `video.url` — a PROVIDER-OWNED CDN
 * URL, NOT the agent-supplied i2v `image_url`. The input path is SSRF-guarded
 * elsewhere; this OUTPUT download trusts the xAI CDN by design and so does NOT
 * re-run the SSRF resolver — but it still hardens with `redirect:"error"` (never
 * silently follow a CDN open-redirect to an internal IP), a bounded signal
 * (CR-01/WR-01), and a streamed byte cap. COPIED from fal-adapter.ts (the FAL
 * file's comment directs Phase 190 to follow this shape), with one change: the
 * `doFetch` is passed in (the adapter's injected `fetchImpl`) rather than the
 * global `fetch`, so the download leg is deterministically testable.
 *
 * @returns the downloaded bytes plus the CDN `content-type` (for WR-06 MIME).
 * @throws on a non-2xx status (CR-01), an empty body, an over-cap body (WR-01),
 *   or an aborted signal — all caught by `fromPromise` at the call site and
 *   classified by `classifyGrokVideoError` into a typed `VideoGenError`.
 */
async function downloadVideoBytes(
  url: string,
  doFetch: typeof fetch,
  opts?: VideoFetchResultOpts,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  // WR-01: honor the caller's deadline signal; else a hard fallback timeout.
  const signal = opts?.signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await doFetch(url, { redirect: "error", signal });

  // CR-01: reject a non-2xx status BEFORE reading the body (an expired/4xx xAI
  // CDN URL returns a 403 error page; without this guard it flows out as a
  // "successful" mp4 — the orphan-on-expiry class DEL-01 closes).
  if (!response.ok) {
    throw new Error(`xai: failed to download video.url: HTTP ${response.status}`);
  }

  // WR-01: Content-Length pre-check — abort before buffering if the server
  // DECLARES a body over the cap (an OOM guard).
  const declared = parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`xai: video.url body exceeds the ${maxBytes}-byte cap (declared ${declared})`);
  }

  // WR-01: stream with a running byte cap when a body reader is available; fall
  // back to arrayBuffer otherwise.
  const reader = response.body?.getReader?.();
  let buffer: Buffer;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`xai: video.url body exceeds the ${maxBytes}-byte cap`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    buffer = Buffer.concat(chunks);
  } else {
    buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`xai: video.url body exceeds the ${maxBytes}-byte cap`);
    }
  }

  if (buffer.byteLength === 0) {
    throw new Error("xai: video.url returned an empty body");
  }
  return { buffer, contentType: response.headers.get("content-type") };
}

/** Known video MIME types for the URL-extension fallback (WR-06). Copied from fal-adapter.ts. */
const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/**
 * WR-06: derive the output MIME from the CDN `content-type` header when it is a
 * `video/*` type, else from the URL path extension, else fall back to mp4. The
 * `url` passed here is the (un-credentialed) `video.url`. Copied from fal-adapter.ts.
 */
function deriveVideoMime(contentType: string | null, url: string): string {
  const ct = contentType?.split(";")[0]?.trim().toLowerCase();
  if (ct && ct.startsWith("video/")) return ct;
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (ext && VIDEO_EXT_MIME[ext]) return VIDEO_EXT_MIME[ext];
  } catch {
    // Malformed URL — fall through to the default.
  }
  return "video/mp4";
}

/** Map a thrown error to a typed `VideoGenError` Result via `classifyGrokVideoError`. */
function mapThrownToErr(error: Error, opts?: { emptyResult?: boolean }): Result<VideoGenOutput, Error> {
  // A VideoGenError thrown inside fetchResult/execute already carries the kind/hint.
  if (error instanceof VideoGenError) return err(error);
  const c = classifyGrokVideoError(error, opts);
  return err(new VideoGenError(c.hint, c));
}
