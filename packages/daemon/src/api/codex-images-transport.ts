// SPDX-License-Identifier: Apache-2.0
/**
 * Custom Codex Responses image transport.
 *
 * pi-ai's IMAGES registry ships only the built-in `openrouter-images`
 * transport, so the Codex (ChatGPT-login) IMAGE path is custom: it POSTs the
 * Responses-API hosted `image_generation` tool to the ChatGPT-backend Codex
 * endpoint (`https://chatgpt.com/backend-api/codex/responses`), sends the
 * first-party Cloudflare request identity, and parses the image SSE to base64.
 * It is registered into pi-ai's module-level registry
 * under the `openai-codex-images` api and dispatched through the ONE
 * `generateImages()` call site.
 *
 * In-repo analog: pi-ai ALSO ships a Codex
 * *Responses* TEXT transport — `@earendil-works/pi-ai/.../openai-codex-responses.js`
 * (`buildBaseCodexHeaders`/`buildSSEHeaders`/`extractAccountId`) — against the
 * SAME endpoint. It is not an image transport (it parses message SSE, not
 * `image_generation_call` frames), but it IS the authority for the
 * header/JWT-account-id half of this file. The header set below is reconciled
 * against it (see `buildCodexImageHeaders`).
 *
 * Design boundaries:
 *   - `generateImagesCodex` is an `ImagesFunction` (pi-ai contract). It
 *     reads the bearer from `options.apiKey` and the CF headers from
 *     `options.headers` (both supplied by the per-call adapter).
 *   - It NEVER throws out of the transport: any miss (no bearer, non-2xx, empty
 *     SSE, malformed body, thrown fetch) returns `stopReason:"error"` (or
 *     `"aborted"`) with an `errorMessage` the SHIPPED `classifyImageError`
 *     (`pi-image-adapter.ts`) maps (`401|403|auth` → `auth_required`,
 *     content/quota → `content_blocked`/`quota_exceeded`, else
 *     → `empty_response`). So this file needs NO `@allow-throw`.
 *   - Secret-logging discipline: NEVER log the `headers` object, the bearer, or the
 *     `ChatGPT-Account-ID` (the account-id is NOT in the redaction set). If a
 *     logger is threaded for diagnostics, log only `{ step, errorKind }`.
 *
 * The header VALUES are an authorized compatibility shim, not detection
 * evasion: they reproduce the OFFICIAL `openai/codex` (codex-rs)
 * first-party CLI's wire identity using the operator's OWN ChatGPT/Codex OAuth
 * credentials against the SAME endpoint that client uses — NOT detection
 * evasion. `originator: "codex_cli_rs"` is the official codex-rs originator
 * (pi-mono #1828 documents that pi-ai's `originator:"pi"` is Cloudflare-403'd;
 * Comis's own login-flow `ORIGINATOR="comis"` is a different concern).
 *
 * LIVE-UNVERIFIED: the EXACT header set + values
 * for the codex-backend IMAGE round-trip can only be confirmed by an operator
 * UAT with a real ChatGPT login — the fetch-boundary mocks here cannot prove
 * Cloudflare accepts them. The values match the SDK's proven codex TEXT path
 * (`buildSSEHeaders`) and #1828's originator, but if a live UAT 403s, the
 * documented escape hatch is `provider:"openrouter"`.
 *
 * @module
 */
import { type AssistantImages, type ImagesFunction } from "@earendil-works/pi-ai";
import { decodeCodexJwtPayload, systemNowMs } from "@comis/core";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Cosmetic version string in the codex `User-Agent`. pi-mono #1828 indicates
 * Cloudflare gates on the `codex_cli_rs` originator/prefix; the exact UA
 * version is BELIEVED cosmetic (live-unverified),
 * so this is a stable constant. Bump only if a future gate tightens on the UA
 * version.
 */
export const CODEX_UA_VERSION = "0.0.1";

/** The Codex Responses claim path carrying the ChatGPT account id. */
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Cap the SSE line buffer so a hostile/huge no-newline
 * stream cannot grow memory without bound. A complete `response.completed`
 * event can legitimately carry a multi-MB base64 image inline, so the ceiling
 * is generous (32 MiB); past it the parser bails to `empty_response` (honest
 * degrade) instead of OOMing. The endpoint is a trusted first-party (ChatGPT),
 * so this is cheap defense-in-depth, not a hot path.
 */
export const CODEX_SSE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Build the first-party Codex Cloudflare/request headers from the freshly-
 * resolved access-token JWT, reconciled against the SDK's proven codex
 * Responses path (`openai-codex-responses.js` `buildSSEHeaders`).
 *
 * The account-id is decoded from the SAME bearer used for the request (one JWT
 * → its own `chatgpt_account_id`, so the identity can never diverge from the
 * credential). The `Authorization: Bearer <token>` header is set by
 * the transport from `options.apiKey`; it is deliberately NOT set here.
 *
 * Header values (LIVE-UNVERIFIED — see the module docstring):
 *   - `originator: "codex_cli_rs"` — the OFFICIAL `openai/codex` (codex-rs)
 *     originator (pi-mono #1828: the SDK's `originator:"pi"` is Cloudflare-
 *     403'd). NOT "comis" (that is Comis's OAuth login-flow originator).
 *   - `ChatGPT-Account-ID` — the casing is COSMETIC: HTTP header names are
 *     case-insensitive (RFC 7230 §3.2), and `fetch`/`new Headers()` lower-case
 *     them on the wire, so PascalCase vs lowercase is identical to Cloudflare.
 *     We use the PascalCase the codex-rs CLI emits purely for readability; the
 *     SDK uses lowercase `chatgpt-account-id` to the same effect. Omitted (not
 *     empty) when the JWT carries no account claim.
 *   - `session-id` + `x-client-request-id` — the SDK's `buildSSEHeaders` sends
 *     BOTH (equal) as part of the first-party SSE request identity, so this
 *     transport must too. One fresh UUID per request
 *     (mirrors the SDK's `createCodexRequestId()` → both headers).
 *
 * @param bearer - The Codex OAuth access token (a JWT). Never logged.
 * @returns The header map (the adapter passes it via `ImagesOptions.headers`).
 */
export function buildCodexImageHeaders(bearer: string): Record<string, string> {
  const payload = decodeCodexJwtPayload(bearer); // REUSE @comis/core — do not hand-roll
  const auth = payload?.[CODEX_AUTH_CLAIM] as { chatgpt_account_id?: string } | undefined;
  // One id per request, set on BOTH headers (SDK buildSSEHeaders parity).
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    originator: "codex_cli_rs",
    "User-Agent": `codex_cli_rs/${CODEX_UA_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
    "session-id": requestId,
    "x-client-request-id": requestId,
  };
  if (auth?.chatgpt_account_id) headers["ChatGPT-Account-ID"] = auth.chatgpt_account_id;
  return headers;
}

/** Extract the first text prompt from the pi-ai `ImagesContext.input`. */
function extractPrompt(input: readonly { type: string; text?: string }[]): string {
  const textItem = input.find((c) => c.type === "text");
  return textItem?.text ?? "";
}

/** Build the Responses `image_generation` request body. */
function buildRequestBody(modelId: string, prompt: string): string {
  // The body MIRRORS pi-ai's proven codex TEXT body (openai-codex-responses.js
  // buildRequestBody) for the fields the ChatGPT backend REQUIRES, plus the
  // image_generation tool. Each requirement was VERIFIED LIVE via the 400
  // `detail` (the codex backend validates required fields one at a time):
  //   - `instructions` (non-empty)        — 400 "Instructions are required"
  //   - `store: false` (not storable)     — 400 "Store must be set to false"
  // The user's request rides `input`; `tool_choice` forces the hosted tool.
  return JSON.stringify({
    model: modelId,
    store: false,
    stream: true,
    instructions:
      "You are an image generation assistant. Use the image_generation tool to create the image the user requests.",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" }, // REQUIRED — force the hosted tool
  });
}

/**
 * Tolerantly parse the Codex image SSE stream to a base64 image.
 *
 * Read-loop / line-buffer / blank-line-boundary mechanics copied from the only
 * in-repo SSE reader (`signal-client.ts:266-309`); the event handling is codex
 * image-specific. Per-line `JSON.parse` is wrapped in try/catch so a malformed
 * `data:` line is skipped, never thrown. Accumulation rules:
 *   - `response.image_generation_call.partial_image` → `partial_image_b64`,
 *     keyed by `partial_image_index` (highest index wins).
 *   - `response.image_generation_call.completed` → `b64_json` (PREFERRED final).
 *   - terminal `response.completed` whose `response.output[]` carries an
 *     `image_generation_call` item with `result`/`b64_json` — also tolerated.
 *
 * @returns A result carrying the completed b64 (else the highest-index
 *   partial, else `undefined`) plus any terminal `response.failed` cause
 *   message. The `failedMessage` lets the caller surface
 *   the REAL failure cause (quota / content policy / auth) to the shipped
 *   `classifyImageError` instead of collapsing everything to `empty_response`.
 *   It is NEVER logged — `classifyImageError` only scans it.
 */
interface CodexSseResult {
  /** The decoded image bytes (completed preferred, else highest-index partial). */
  b64?: string;
  /** The terminal `response.failed` cause message, if one arrived. */
  failedMessage?: string;
}

async function parseCodexImageSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<CodexSseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: string | undefined;
  // Highest-index partial wins; track the index so a later lower-index frame
  // (out-of-order) does not clobber a better one.
  let bestPartialIndex = -1;
  let bestPartial: string | undefined;
  // Capture the terminal failure cause so the caller can classify it.
  let failedMessage: string | undefined;

  const consumeEvent = (raw: string): void => {
    const data = raw.startsWith("data:") ? raw.slice("data:".length).trim() : raw.trim();
    if (data === "" || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // skip malformed line — never throw
    }
    const type = event.type;
    if (type === "response.image_generation_call.completed") {
      const b64 = event.b64_json;
      if (typeof b64 === "string" && b64.length > 0) completed = b64;
      return;
    }
    if (type === "response.image_generation_call.partial_image") {
      const b64 = event.partial_image_b64;
      const idx = typeof event.partial_image_index === "number" ? event.partial_image_index : 0;
      if (typeof b64 === "string" && b64.length > 0 && idx >= bestPartialIndex) {
        bestPartialIndex = idx;
        bestPartial = b64;
      }
      return;
    }
    if (type === "response.completed") {
      // Tolerate the terminal output item carrying the final bytes.
      const response = event.response as { output?: unknown } | undefined;
      const output = Array.isArray(response?.output) ? response.output : [];
      for (const item of output) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "image_generation_call") {
          const b64 = typeof obj.result === "string" ? obj.result : obj.b64_json;
          if (typeof b64 === "string" && b64.length > 0) completed = b64;
        }
      }
      return;
    }
    if (type === "response.failed") {
      // The Codex Responses API emits the real cause (quota / content
      // policy / auth / server error) in response.error.message. Capture it so
      // the caller surfaces it to classifyImageError (quota_exceeded /
      // content_blocked / auth_required) instead of the generic empty_response.
      // Never logged here — only the caller's classifier scans it.
      const response = event.response as { error?: { message?: unknown } } | undefined;
      const message = response?.error?.message;
      if (typeof message === "string" && message.length > 0) failedMessage = message;
    }
  };

  // Set when the un-drained buffer exceeds the cap — bail to a miss
  // (empty_response) rather than grow without bound on a no-newline stream.
  let oversized = false;
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf("\n");
      while (lineEnd !== -1) {
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line !== "" && !line.startsWith(":")) consumeEvent(line);
        lineEnd = buffer.indexOf("\n");
      }
      // After draining every complete line, the residue is one
      // unterminated line. If it alone exceeds the cap, the stream is sending
      // an unbounded no-newline body — stop reading and degrade honestly.
      if (buffer.length > CODEX_SSE_MAX_BUFFER_BYTES) {
        oversized = true;
        break;
      }
    }
    // Flush any trailing buffered line (stream may end without a final newline).
    // Skip the flush when we bailed on an oversized buffer.
    if (!oversized && buffer !== "" && !buffer.startsWith(":")) consumeEvent(buffer);
  } finally {
    reader.releaseLock();
  }

  return { b64: completed ?? bestPartial, failedMessage };
}

/**
 * The custom `openai-codex-images` transport.
 *
 * Registered into pi-ai's registry and dispatched through the single
 * `generateImages()` call site. Reads the bearer from `options.apiKey` and the
 * CF headers from `options.headers`; NEVER throws out (every failure → an
 * `AssistantImages` with `stopReason:"error"`/`"aborted"` the shipped
 * classifier maps).
 *
 * NOTE: pi-ai's `ImagesFunction` contract is `(model, context, options)` —
 * `generateImages()` NEVER passes a 4th arg, so a `logger` param here would be
 * permanently `undefined` (dead). The redacted failure CAUSE is logged by the
 * ADAPTER (`codex-image-adapter.ts`, which holds the real logger and WARNs
 * `res.errorMessage` on a non-image result) — never from this transport.
 */
export const generateImagesCodex: ImagesFunction = async (
  model,
  context,
  options,
): Promise<AssistantImages> => {
  const out: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    // systemNowMs (the globals-gate-sanctioned wall-clock read) — NOT Date.now,
    // which the production globals gate forbids outside bootstrap/adapter paths.
    timestamp: systemNowMs(),
  };

  try {
    const bearer = options?.apiKey;
    if (!bearer) {
      // No fetch issued. The message lets the shipped classifier map it
      // (→ auth_required). Never log the (absent) bearer.
      out.stopReason = "error";
      out.errorMessage = "No API key for provider: openai-codex";
      return out;
    }

    const url = `${model.baseUrl}/codex/responses`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        // CF headers ride options.headers (the adapter built them from the same
        // bearer's JWT). Authorization is set HERE from options.apiKey.
        ...(options?.headers ?? {}),
        Authorization: `Bearer ${bearer}`,
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: buildRequestBody(model.id, extractPrompt(context.input)),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!resp.ok || !resp.body) {
      out.stopReason = "error";
      // OBS: read the error body (truncated) so the REAL 4xx reason (e.g. an
      // invalid model or unsupported tool) reaches the caller — it was just
      // "codex <status>" with no reason, which the classifier collapsed into a
      // generic "non-image response" (a live HTTP 400 incident, where the cause —
      // the gpt-image-1 model id — was invisible). The body is the API error
      // description (no secret: the bearer/CF headers are request-side, never
      // echoed). Best-effort; a body read that throws degrades to the bare status.
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 300);
      } catch {
        /* ignore — fall back to the bare status */
      }
      out.errorMessage = detail ? `codex ${resp.status}: ${detail}` : `codex ${resp.status}`;
      return out;
    }

    const { b64, failedMessage } = await parseCodexImageSse(resp.body, options?.signal);
    if (!b64) {
      out.stopReason = "error";
      // Prefer the terminal response.failed cause (quota / content /
      // auth) so the shipped classifier maps the RIGHT kind; only a genuinely
      // empty/unparseable stream falls back to empty_response. The cause is
      // surfaced via errorMessage for classification (+ the adapter's WARN),
      // never echoed to the user.
      out.errorMessage = failedMessage ?? "empty_response: no image in stream";
      return out;
    }

    out.output.push({ type: "image", data: b64, mimeType: "image/png" });
    return out;
  } catch (e) {
    // NEVER throw out of the transport — the shipped classifyImageError maps
    // the errorMessage substring. Aborted is distinguished for the timeout kind.
    out.stopReason = options?.signal?.aborted ? "aborted" : "error";
    out.errorMessage = e instanceof Error ? e.message : String(e);
    return out;
  }
};
