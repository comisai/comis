// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the custom Codex Responses image transport (codex-images-transport.ts).
 *
 * The transport is a pi-ai `ImagesApiFunction` that POSTs the hosted
 * `image_generation` tool to the ChatGPT-backend Codex Responses endpoint and
 * parses the image SSE to base64. Every test mocks at the `fetch` /
 * `Response.body` boundary (a `ReadableStream` of SSE bytes) — NEVER the
 * network, NEVER a real ChatGPT login (Assumption A1: the live round-trip is
 * operator-opt-in UAT, deferred to Plan 02's `it.skipIf`).
 *
 * Covers CDX-02 (CF headers + Authorization), CDX-03 (body + partial/completed
 * SSE → base64; empty/failed/non-2xx/no-bearer → stopReason:"error"), and the
 * SEC-03 subset (no bearer / account-id / headers object in any log payload).
 * @module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai";
import { makeMockLogger } from "../../../../test/support/mock-logger.js";
import {
  generateImagesCodex,
  buildCodexImageHeaders,
  CODEX_UA_VERSION,
} from "./codex-images-transport.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** The hand-built codex image model the adapter (Plan 02) will pass. */
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
 * bearer string itself is a SECRET — Test 7 asserts it never reaches a log.
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
// Task 1 — CDX-03: request body
// ---------------------------------------------------------------------------

describe("generateImagesCodex — request body (CDX-03)", () => {
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
  });
});

// ---------------------------------------------------------------------------
// Task 1 — CDX-03: SSE partial + completed → base64
// ---------------------------------------------------------------------------

describe("generateImagesCodex — SSE base64 extraction (CDX-03)", () => {
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
// Task 1 — CDX-03: empty / failed → error
// ---------------------------------------------------------------------------

describe("generateImagesCodex — empty/failed stream (CDX-03)", () => {
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
});

// ---------------------------------------------------------------------------
// Task 1 — CDX-03: non-2xx / no body / thrown fetch / no bearer
// ---------------------------------------------------------------------------

describe("generateImagesCodex — failure branches (CDX-03)", () => {
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
// Task 1 — CDX-02: headers reach the request
// ---------------------------------------------------------------------------

describe("generateImagesCodex — headers (CDX-02)", () => {
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
  });
});

// ---------------------------------------------------------------------------
// buildCodexImageHeaders — CDX-02 unit
// ---------------------------------------------------------------------------

describe("buildCodexImageHeaders (CDX-02)", () => {
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
// Task 1 — SEC-03 subset: no secret in any log payload
// ---------------------------------------------------------------------------

describe("generateImagesCodex — secret-logging discipline (SEC-03 subset)", () => {
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
});
