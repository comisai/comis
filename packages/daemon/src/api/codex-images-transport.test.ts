// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the custom Codex Responses image transport (codex-images-transport.ts).
 *
 * The transport is a pi-ai `ImagesFunction` that POSTs the hosted
 * `image_generation` tool to the ChatGPT-backend Codex Responses endpoint and
 * parses the image SSE to base64. Every test mocks at the `fetch` /
 * `Response.body` boundary (a `ReadableStream` of SSE bytes) — NEVER the
 * network, NEVER a real ChatGPT login (the live round-trip is an
 * operator-opt-in UAT behind an `it.skipIf`).
 *
 * Covers the CF headers + Authorization, the request body + partial/completed
 * SSE → base64 (empty/failed/non-2xx/no-bearer → stopReason:"error"), and the
 * secret-logging discipline (no bearer / account-id / headers object in any log payload).
 * @module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai";
import { makeMockLogger } from "../../../../test/support/mock-logger.js";
import {
  generateImagesCodex,
  buildCodexImageHeaders,
  CODEX_UA_VERSION,
  CODEX_SSE_MAX_BUFFER_BYTES,
} from "./codex-images-transport.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** The hand-built codex image model the adapter (`codex-image-adapter.ts`) passes. */
function codexModel(): ImagesModel<"openai-codex-images"> {
  return {
    id: "gpt-image-1",
    name: "Codex Image (gpt-image-1)",
    api: "openai-codex-images",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text"],
    output: ["image", "text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * A codex JWT whose payload carries `chatgpt_account_id: "acct_123"` under the
 * `https://api.openai.com/auth` claim (base64url, header.payload.sig). The
 * bearer string itself is a SECRET — the secret-logging-discipline tests
 * below assert it never reaches a log.
 */
const ACCOUNT_ID = "acct_123";
const BEARER = (() => {
  const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64url({ alg: "none", typ: "JWT" });
  const body = b64url({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } });
  return `${header}.${body}.sig`;
})();

/** Build a `ReadableStream<Uint8Array>` carrying the given SSE text verbatim. */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A captured `fetch` call (url + init). */
interface CapturedFetch {
  url: string;
  init: RequestInit;
}

/**
 * Stub `global.fetch` to capture the request and return a canned Response.
 * `responseInit.body` is the SSE stream (or null); `ok`/`status` are derived
 * from `status` (default 200).
 */
function stubFetch(opts: {
  body: ReadableStream<Uint8Array> | null;
  status?: number;
  throws?: Error;
}): { captured: CapturedFetch[] } {
  const captured: CapturedFetch[] = [];
  const status = opts.status ?? 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      if (opts.throws) throw opts.throws;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        body: opts.body,
      } as unknown as Response;
    }),
  );
  return { captured };
}

/** Extract the parsed JSON body from a captured fetch init. */
function parseBody(c: CapturedFetch): Record<string, unknown> {
  return JSON.parse(String(c.init.body)) as Record<string, unknown>;
}

/** Extract the headers (lower/normalized lookups) from a captured fetch init. */
function headersOf(c: CapturedFetch): Record<string, string> {
  return (c.init.headers ?? {}) as Record<string, string>;
}

const textContext = (text: string) => ({ input: [{ type: "text" as const, text }] });
const opts = (over: Partial<ProviderImagesOptions> = {}): ProviderImagesOptions => ({
  apiKey: BEARER,
  ...over,
});

let logger: ReturnType<typeof makeMockLogger>;

beforeEach(() => {
  logger = makeMockLogger();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("generateImagesCodex — request body", () => {
  it("POSTs the hosted image_generation tool body to /codex/responses", async () => {
    const { captured } = stubFetch({
      body: sseStream(
        'data: {"type":"response.image_generation_call.completed","b64_json":"WFla"}\n\ndata: [DONE]\n\n',
      ),
    });

    await generateImagesCodex(codexModel(), textContext("a red cube"), opts());

    expect(captured).toHaveLength(1);
    const c = captured[0]!;
    expect(c.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(c.init.method).toBe("POST");
    const body = parseBody(c);
    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-image-1");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "a red cube" }] },
    ]);
    // The Codex Responses endpoint 400s ("Instructions are required" —
    // VERIFIED LIVE) without a non-empty `instructions`. The working text path
    // (pi-ai) always sends one; the image path must too.
    expect(typeof body.instructions).toBe("string");
    expect((body.instructions as string).length).toBeGreaterThan(0);
    // The endpoint 400s ("Store must be set to false" — VERIFIED LIVE)
    // unless store is explicitly false (the hosted-tool path is not storable).
    expect(body.store).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSE partial + completed → base64
// ---------------------------------------------------------------------------

describe("generateImagesCodex — SSE base64 extraction", () => {
  it("prefers the completed b64_json over the partial image", async () => {
    stubFetch({
      body: sseStream(
        'data: {"type":"response.image_generation_call.partial_image","partial_image_index":0,"partial_image_b64":"QUJD"}\n\n' +
          'data: {"type":"response.image_generation_call.completed","b64_json":"WFla"}\n\n' +
          "data: [DONE]\n\n",
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: "WFla", mimeType: "image/png" }]);
  });

  it("falls back to the highest-index partial when no completed event arrives", async () => {
    stubFetch({
      body: sseStream(
        'data: {"type":"response.image_generation_call.partial_image","partial_image_index":0,"partial_image_b64":"QUJD"}\n\n' +
          'data: {"type":"response.image_generation_call.partial_image","partial_image_index":1,"partial_image_b64":"WFla"}\n\n' +
          "data: [DONE]\n\n",
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: "WFla", mimeType: "image/png" }]);
  });

  it("skips malformed data: lines without throwing", async () => {
    stubFetch({
      body: sseStream(
        "data: {not valid json}\n\n" +
          'data: {"type":"response.image_generation_call.completed","b64_json":"WFla"}\n\n' +
          "data: [DONE]\n\n",
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output[0]).toMatchObject({ type: "image", data: "WFla" });
  });
});

// ---------------------------------------------------------------------------
// Empty / failed → error
// ---------------------------------------------------------------------------

describe("generateImagesCodex — empty/failed stream", () => {
  it("maps a stream with no image bytes to stopReason:error + empty_response", async () => {
    stubFetch({
      body: sseStream(
        'data: {"type":"response.completed","response":{"output":[]}}\n\ndata: [DONE]\n\n',
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("empty_response");
  });

  it("maps a response.failed event to stopReason:error", async () => {
    stubFetch({
      body: sseStream(
        'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\ndata: [DONE]\n\n',
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
  });

  // A response.failed event carries the REAL cause in
  // response.error.message (quota / content policy / auth). The transport must
  // surface that message (NOT discard it to the generic empty_response
  // fallback) so the shipped classifyImageError can map it to the right
  // ImageErrorKind. (The transport never LOGS the message — classifyImageError
  // only scans it.)
  it("surfaces the response.failed error.message for classification (not empty_response)", async () => {
    stubFetch({
      body: sseStream(
        'data: {"type":"response.failed","response":{"error":{"message":"Your prompt was rejected by the content policy"}}}\n\ndata: [DONE]\n\n',
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toBe("Your prompt was rejected by the content policy");
    expect(res.errorMessage).not.toContain("empty_response");
  });

  it("prefers a real image over a later response.failed (completed wins)", async () => {
    stubFetch({
      body: sseStream(
        'data: {"type":"response.image_generation_call.completed","b64_json":"WFla"}\n\n' +
          'data: {"type":"response.failed","response":{"error":{"message":"late error"}}}\n\n' +
          "data: [DONE]\n\n",
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: "WFla", mimeType: "image/png" }]);
  });

  it("falls back to empty_response when failed carries no message", async () => {
    stubFetch({
      body: sseStream('data: {"type":"response.failed","response":{}}\n\ndata: [DONE]\n\n'),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("empty_response");
  });

  it("surfaces the 4xx error BODY (not just the bare status) so the real cause is diagnosable (live HTTP 400 incident)", async () => {
    // A fast non-2xx (the live HTTP 400) — the transport must read the error
    // body so the REAL cause (e.g. an invalid model) reaches the caller's WARN,
    // not the bare "codex 400" the classifier collapsed to "non-image response".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: "",
        body: null,
        text: async () => '{"error":{"message":"Invalid model gpt-image-1"}}',
      })),
    );

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("codex 400");
    // The REAL cause (the body) is now visible — it was the obs gap behind the
    // "returned no image twice" incident.
    expect(res.errorMessage).toContain("Invalid model");
  });

  // A hostile/huge no-newline stream must not grow the SSE
  // line buffer without bound. Past CODEX_SSE_MAX_BUFFER_BYTES the parser bails
  // to empty_response (honest degrade) instead of OOMing.
  it("caps the SSE line buffer and bails to empty_response on an unbounded no-newline stream", async () => {
    // Stream chunks with NO newline so the line buffer never drains, just past
    // the cap — without materializing one giant string in the test.
    const chunk = "A".repeat(64 * 1024); // 64 KiB, no newline
    const chunks = Math.ceil(CODEX_SSE_MAX_BUFFER_BYTES / chunk.length) + 2;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (let i = 0; i < chunks; i++) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    stubFetch({ body });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("empty_response");
    // Higher timeout: pushing >1 MiB through the SSE parser to trip the buffer cap
    // is CPU-bound and exceeds the 5s default on slower (e.g. small-VPS) hosts.
  }, 20_000);

  it("exposes a sane positive SSE buffer cap constant", () => {
    expect(CODEX_SSE_MAX_BUFFER_BYTES).toBeGreaterThan(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// Non-2xx / no body / thrown fetch / no bearer
// ---------------------------------------------------------------------------

describe("generateImagesCodex — failure branches", () => {
  it("maps a non-2xx response to stopReason:error carrying the status", async () => {
    stubFetch({ body: null, status: 403 });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("403");
  });

  it("catches a thrown fetch (network) without rethrowing", async () => {
    stubFetch({ body: null, throws: new Error("ECONNREFUSED") });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("ECONNREFUSED");
  });

  it("reports aborted when the signal is already aborted on a thrown fetch", async () => {
    stubFetch({ body: null, throws: new Error("aborted") });
    const ac = new AbortController();
    ac.abort();

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts({ signal: ac.signal }));

    expect(res.stopReason).toBe("aborted");
  });

  it("maps a missing bearer to stopReason:error with the no-API-key message", async () => {
    // No fetch should be issued; assert via the unstubbed default (no stub set).
    const { captured } = stubFetch({ body: null });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts({ apiKey: undefined }));

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toBe("No API key for provider: openai-codex");
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Headers reach the request
// ---------------------------------------------------------------------------

describe("generateImagesCodex — headers", () => {
  it("merges options.headers through and adds Authorization + SSE/JSON/beta headers", async () => {
    const { captured } = stubFetch({
      body: sseStream(
        'data: {"type":"response.image_generation_call.completed","b64_json":"WFla"}\n\ndata: [DONE]\n\n',
      ),
    });
    const cfHeaders = buildCodexImageHeaders(BEARER);

    await generateImagesCodex(codexModel(), textContext("x"), opts({ headers: cfHeaders }));

    const h = headersOf(captured[0]!);
    expect(h.Authorization).toBe(`Bearer ${BEARER}`);
    expect(h.accept).toBe("text/event-stream");
    expect(h["content-type"]).toBe("application/json");
    expect(h["OpenAI-Beta"]).toBe("responses=experimental");
    // CF headers (supplied by the adapter) pass through:
    expect(h.originator).toBe("codex_cli_rs");
    expect(h["ChatGPT-Account-ID"]).toBe(ACCOUNT_ID);
    expect(h["User-Agent"]).toMatch(/^codex_cli_rs\//);
    // The first-party SSE session headers ride options.headers through too.
    expect(h["session-id"]).toBe(cfHeaders["session-id"]);
    expect(h["x-client-request-id"]).toBe(cfHeaders["session-id"]);
  });
});

// ---------------------------------------------------------------------------
// buildCodexImageHeaders — unit
// ---------------------------------------------------------------------------

describe("buildCodexImageHeaders", () => {
  it("builds the first-party codex identity from the JWT account-id", () => {
    const h = buildCodexImageHeaders(BEARER);
    expect(h.originator).toBe("codex_cli_rs");
    expect(h["ChatGPT-Account-ID"]).toBe(ACCOUNT_ID);
    expect(h["User-Agent"]).toBe(
      `codex_cli_rs/${CODEX_UA_VERSION} (${process.platform} ${require("node:os").release()}; ${process.arch})`,
    );
    // Authorization is NOT set here — it rides ImagesOptions.apiKey.
    expect(h.Authorization).toBeUndefined();
  });

  // The SDK's proven Codex Responses SSE path sends
  // session-id + x-client-request-id (openai-codex-responses.js buildSSEHeaders)
  // as part of the first-party request identity.
  // Match the SDK: both present, equal, and a valid UUID.
  it("sets matching session-id + x-client-request-id (first-party SSE identity)", () => {
    const h = buildCodexImageHeaders(BEARER);
    const sessionId = h["session-id"];
    expect(sessionId).toBeDefined();
    expect(h["x-client-request-id"]).toBe(sessionId);
    // A v4-ish UUID (the SDK uses crypto.randomUUID()).
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("generates a fresh session-id per call (not a shared constant)", () => {
    const a = buildCodexImageHeaders(BEARER)["session-id"];
    const b = buildCodexImageHeaders(BEARER)["session-id"];
    expect(a).not.toBe(b);
  });

  it("omits ChatGPT-Account-ID when the JWT has no account claim", () => {
    const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const noAcct = `${b64url({ alg: "none" })}.${b64url({ sub: "u" })}.sig`;
    const h = buildCodexImageHeaders(noAcct);
    expect(h.originator).toBe("codex_cli_rs");
    expect(h["ChatGPT-Account-ID"]).toBeUndefined();
  });

  it("omits ChatGPT-Account-ID for a non-decodable bearer (never throws)", () => {
    const h = buildCodexImageHeaders("not-a-jwt");
    expect(h.originator).toBe("codex_cli_rs");
    expect(h["ChatGPT-Account-ID"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No secret in any log payload
// ---------------------------------------------------------------------------

describe("generateImagesCodex — secret-logging discipline", () => {
  it("never logs the bearer, the account-id, or a raw headers object on failure", async () => {
    stubFetch({ body: null, status: 403 });
    const cfHeaders = buildCodexImageHeaders(BEARER);

    await generateImagesCodex(codexModel(), textContext("x"), opts({ headers: cfHeaders }), logger as never);

    const serialized = JSON.stringify(logger._calls());
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(ACCOUNT_ID);
    expect(serialized).not.toContain("Bearer ");
  });

  it("never logs the bearer on the no-bearer branch", async () => {
    stubFetch({ body: null });

    await generateImagesCodex(codexModel(), textContext("x"), opts({ apiKey: undefined }), logger as never);

    const serialized = JSON.stringify(logger._calls());
    expect(serialized).not.toContain(BEARER);
  });

  // The transport surfaces response.failed.error.message as errorMessage for the
  // classifier — but that raw provider message must NOT appear in any log
  // payload (it could in principle echo request content). The DEBUG line on the
  // failed branch carries only a static errorKind literal.
  it("never logs the raw response.failed message (only a static errorKind)", async () => {
    const SECRET_ISH = "raw-provider-detail-should-not-be-logged";
    stubFetch({
      body: sseStream(
        `data: {"type":"response.failed","response":{"error":{"message":"${SECRET_ISH}"}}}\n\ndata: [DONE]\n\n`,
      ),
    });

    const res = await generateImagesCodex(codexModel(), textContext("x"), opts(), logger as never);

    // Surfaced on the result for classification…
    expect(res.errorMessage).toBe(SECRET_ISH);
    // …but never in a log payload.
    const serialized = JSON.stringify(logger._calls());
    expect(serialized).not.toContain(SECRET_ISH);
  });
});
