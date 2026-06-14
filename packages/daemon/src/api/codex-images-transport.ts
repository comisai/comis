// SPDX-License-Identifier: Apache-2.0
/**
 * Custom Codex Responses image transport (CDX-02 + CDX-03).
 *
 * pi-ai ships only the built-in `openrouter-images` transport. The Codex
 * (ChatGPT-login) image path is genuinely custom: it POSTs the Responses-API
 * hosted `image_generation` tool to the ChatGPT-backend Codex endpoint
 * (`https://chatgpt.com/backend-api/codex/responses`), sends the first-party
 * Cloudflare headers the official Codex CLI uses, and parses the image SSE to
 * base64. It is registered into pi-ai's module-level registry (PI-02 seam,
 * Plan 02) under the `openai-codex-images` api and dispatched through the ONE
 * `generateImages()` call site.
 *
 * Design boundaries:
 *   - `generateImagesCodex` is an `ImagesApiFunction` (pi-ai contract). It
 *     reads the bearer from `options.apiKey` and the CF headers from
 *     `options.headers` (both supplied by the per-call adapter — Plan 02).
 *   - It NEVER throws out of the transport: any miss (no bearer, non-2xx, empty
 *     SSE, malformed body, thrown fetch) returns `stopReason:"error"` (or
 *     `"aborted"`) with an `errorMessage` the SHIPPED `classifyImageError`
 *     (`pi-image-adapter.ts`) maps (`401|403|auth` → `auth_required`, else
 *     → `empty_response`). So this file needs NO `@allow-throw`.
 *   - SEC-03 (Pitfall 3): NEVER log the `headers` object, the bearer, or the
 *     `ChatGPT-Account-ID` (the account-id is NOT in the redaction set). If a
 *     logger is threaded for diagnostics, log only `{ step, errorKind }`.
 *
 * The header VALUES are the load-bearing compatibility shim (CONTEXT
 * §security-framing): `originator: "codex_cli_rs"` is the first-party
 * whitelist value (pi-ai's `originator:"pi"` 403s — pi-mono #1828; Comis's own
 * login-flow `ORIGINATOR="comis"` is a different concern). This is authorized
 * reuse of the operator's OWN ChatGPT/Codex OAuth credentials against the SAME
 * endpoint the official client uses — NOT detection evasion.
 *
 * @module
 */
import { type AssistantImages, type ImagesApiFunction } from "@earendil-works/pi-ai";
import { decodeCodexJwtPayload } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import os from "node:os";

/**
 * Cosmetic version string in the codex `User-Agent`. Cloudflare gates on the
 * `codex_cli_rs` PREFIX, not the exact version (pi-mono #1828), so this is a
 * stable constant; bump only if a future gate tightens on the UA version.
 */
export const CODEX_UA_VERSION = "0.0.1";

/** The Codex Responses claim path carrying the ChatGPT account id. */
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Build the first-party Codex Cloudflare headers from the freshly-resolved
 * access-token JWT (CDX-02).
 *
 * The account-id is decoded from the SAME bearer used for the request (one JWT
 * → its own `chatgpt_account_id`, so the identity can never diverge from the
 * credential — T-184-05). The `Authorization: Bearer <token>` header is set by
 * the transport from `options.apiKey`; it is deliberately NOT set here.
 *
 * @param bearer - The Codex OAuth access token (a JWT). Never logged.
 * @returns The CF header map (the adapter passes it via `ImagesOptions.headers`).
 */
export function buildCodexImageHeaders(bearer: string): Record<string, string> {
  const payload = decodeCodexJwtPayload(bearer); // REUSE @comis/core — do not hand-roll
  const auth = payload?.[CODEX_AUTH_CLAIM] as { chatgpt_account_id?: string } | undefined;
  const headers: Record<string, string> = {
    // FIRST-PARTY whitelist value — NOT "pi" (403s, #1828), NOT "comis" (login flow).
    originator: "codex_cli_rs",
    "User-Agent": `codex_cli_rs/${CODEX_UA_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
  };
  // PascalCase per codex-rs; critical for 401/403 avoidance. Omitted (not empty)
  // when the JWT carries no account claim.
  if (auth?.chatgpt_account_id) headers["ChatGPT-Account-ID"] = auth.chatgpt_account_id;
  return headers;
}

/** Extract the first text prompt from the pi-ai `ImagesContext.input`. */
function extractPrompt(input: readonly { type: string; text?: string }[]): string {
  const textItem = input.find((c) => c.type === "text");
  return textItem?.text ?? "";
}

/** Build the Responses `image_generation` request body (CDX-03). */
function buildRequestBody(modelId: string, prompt: string): string {
  return JSON.stringify({
    model: modelId,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" }, // REQUIRED — force the hosted tool
    stream: true,
  });
}

/**
 * Tolerantly parse the Codex image SSE stream to a base64 image (CDX-03).
 *
 * Read-loop / line-buffer / blank-line-boundary mechanics copied from the only
 * in-repo SSE reader (`signal-client.ts:266-309`); the event handling is codex
 * image-specific. Per-line `JSON.parse` is wrapped in try/catch so a malformed
 * `data:` line is skipped, never thrown (T-184-04). Accumulation rules:
 *   - `response.image_generation_call.partial_image` → `partial_image_b64`,
 *     keyed by `partial_image_index` (highest index wins).
 *   - `response.image_generation_call.completed` → `b64_json` (PREFERRED final).
 *   - terminal `response.completed` whose `response.output[]` carries an
 *     `image_generation_call` item with `result`/`b64_json` — also tolerated.
 *
 * @returns The completed b64 if seen, else the highest-index partial, else
 *   `undefined` (no image bytes → the caller maps to `empty_response`).
 */
async function parseCodexImageSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: string | undefined;
  // Highest-index partial wins; track the index so a later lower-index frame
  // (out-of-order) does not clobber a better one.
  let bestPartialIndex = -1;
  let bestPartial: string | undefined;

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
    }
  };

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
    }
    // Flush any trailing buffered line (stream may end without a final newline).
    if (buffer !== "" && !buffer.startsWith(":")) consumeEvent(buffer);
  } finally {
    reader.releaseLock();
  }

  return completed ?? bestPartial;
}

/**
 * The custom `openai-codex-images` transport (CDX-03).
 *
 * Registered into pi-ai's registry (Plan 02) and dispatched through the single
 * `generateImages()` call site. Reads the bearer from `options.apiKey` and the
 * CF headers from `options.headers`; NEVER throws out (every failure → an
 * `AssistantImages` with `stopReason:"error"`/`"aborted"` the shipped
 * classifier maps).
 *
 * @param logger - Optional diagnostics logger. SEC-03: only `{ step, errorKind }`
 *   is ever logged — never the bearer, the account-id, or the headers object.
 */
export const generateImagesCodex: ImagesApiFunction = async (
  model,
  context,
  options,
  // pi-ai's contract is (model, context, options); Comis threads an optional
  // logger as a 4th positional arg from the adapter for diagnostics only.
  logger?: ComisLogger,
): Promise<AssistantImages> => {
  const out: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
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
      out.errorMessage = `codex ${resp.status}`;
      logger?.debug({ step: "codex_image_transport", errorKind: "http_status" }, "codex image request failed");
      return out;
    }

    const b64 = await parseCodexImageSse(resp.body, options?.signal);
    if (!b64) {
      out.stopReason = "error";
      out.errorMessage = "empty_response: no image in stream";
      logger?.debug({ step: "codex_image_transport", errorKind: "empty_response" }, "codex image stream had no image");
      return out;
    }

    out.output.push({ type: "image", data: b64, mimeType: "image/png" });
    return out;
  } catch (e) {
    // NEVER throw out of the transport — the shipped classifyImageError maps
    // the errorMessage substring. Aborted is distinguished for the timeout kind.
    out.stopReason = options?.signal?.aborted ? "aborted" : "error";
    out.errorMessage = e instanceof Error ? e.message : String(e);
    logger?.debug({ step: "codex_image_transport", errorKind: "exception" }, "codex image transport caught error");
    return out;
  }
};
