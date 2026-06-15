// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createGrokVideoAdapter (GROK-01 / GROK-02 / SEC / job_timeout / OAuth).
 *
 * Grok has NO JS SDK — the adapter is raw `fetch` against `api.x.ai/v1/videos`.
 * Rather than mutate `globalThis.fetch`, the adapter accepts an INJECTED
 * `fetchImpl` (default `globalThis.fetch`) so each test drives a deterministic
 * `fetch` double with no global side effects (the cleaner variant of the
 * Phase-185 module-mock lesson).
 *
 * Observable oracles (deterministic, no real key, no network):
 *   - submit → POST /videos/generations → { request_id } becomes the jobId;
 *     the URL/method/Authorization/body are asserted.
 *   - poll → GET /videos/{request_id} → status pending|done|failed|expired
 *     mapped to the normalized VideoJobStatus (failed+expired → "failed").
 *   - fetchResult → status:done + video.url → Buffer (download-before-return,
 *     redirect:"error"); cost_in_usd_ticks/1e10 → costUsd, with the NaN/negative
 *     GUARD (a spoofed negative/NaN → undefined, never a cost-ceiling bypass).
 *   - status:failed/expired → classified VideoGenError (kind+hint).
 *   - job_timeout on a stuck pending poll.
 *   - the Bearer (key OR OAuth token) NEVER reaches the logger; the request_id
 *     jobId is opaque + secret-free (VPORT-03).
 *   - the DEFENSIVE OAuth branch (codex-shaped) resolves a per-call bearer.
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { createGrokVideoAdapter } from "./grok-adapter.js";

const API_KEY = "xai-k";
const XAI_BASE = "https://api.x.ai/v1";

/** A 200 fetch Response whose body streams the given bytes (the download leg). */
function okDownload(bytes: Buffer, contentType = "video/mp4"): Response {
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type"
          ? contentType
          : k.toLowerCase() === "content-length"
            ? String(bytes.byteLength)
            : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: new Uint8Array(bytes) };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
    arrayBuffer: async () => bytes,
  } as unknown as Response;
}

/** A JSON Response (for the submit POST + the poll/fetchResult GET). */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** A minimal OAuthTokenManager double (codex-shaped) — A1 defensive branch. */
function mockOauth(over: {
  hasCredentials?: (id: string) => boolean;
  getApiKey?: () => Promise<ReturnType<typeof ok<string>> | ReturnType<typeof err>>;
} = {}) {
  return {
    hasCredentials: over.hasCredentials ?? (() => true),
    getApiKey: over.getApiKey ?? (async () => ok("oauth.bearer")),
    getSupportedProviders: () => ["xai"],
  } as never;
}

describe("createGrokVideoAdapter", () => {
  it("id is 'grok' and isAvailable() reflects a present apiKey", () => {
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl: vi.fn() as never });
    expect(adapter.id).toBe("grok");
    expect(adapter.isAvailable()).toBe(true);
  });

  it("GROK-01 submit (key auth): request_id becomes the jobId; POST url/method/Authorization/body asserted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ request_id: "req_123" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });

    const r = await adapter.submit({ prompt: "a cat" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ jobId: "req_123", provider: "grok", model: "grok-imagine-video" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${XAI_BASE}/videos/generations`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "grok-imagine-video", prompt: "a cat" });
  });

  it("GROK-01 submit body mapping: duration is an INTEGER; absent fields omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ request_id: "req_b" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });

    await adapter.submit({ prompt: "p", durationSecs: 6, aspectRatio: "16:9", resolution: "720p" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      model: "grok-imagine-video",
      prompt: "p",
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "720p",
    });
    expect(body.duration).toBe(6);
    expect(typeof body.duration).toBe("number");
  });

  // IN-01: a referenceImage present adds `image` to the body (the {url} data-URI
  // form) on the SAME grok-imagine-video model (no endpoint swap, unlike FAL).
  it("IN-01: with a referenceImage, adds image {url:data-URI} to the body on the same model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ request_id: "req_i2v" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });

    await adapter.submit({
      prompt: "animate this",
      referenceImage: { data: "aGVsbG8=", mimeType: "image/png" },
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("grok-imagine-video"); // SAME model, no swap
    expect(body.image).toEqual({ url: "data:image/png;base64,aGVsbG8=" });
  });

  // IN-01 non-regression: WITHOUT a referenceImage there is NO image key.
  it("IN-01: without a referenceImage, the body carries no image key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ request_id: "req_noimg" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    await adapter.submit({ prompt: "p" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("image");
  });

  it("GROK-01 submit body: omits every field absent from the input (no undefined keys)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ request_id: "req_min" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    await adapter.submit({ prompt: "only prompt" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({ model: "grok-imagine-video", prompt: "only prompt" });
    expect(Object.keys(body)).not.toContain("duration");
    expect(Object.keys(body)).not.toContain("resolution");
  });

  it("GROK-01 submit non-2xx → err classified as auth_required (HTTP 401)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.submit({ prompt: "p" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("401");
  });

  it("GROK-01 submit: a missing request_id is an error (no orphan jobId)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.submit({ prompt: "p" });
    expect(r.ok).toBe(false);
  });

  it("GROK-01 poll: maps status pending|done|failed|expired to pending|done|failed", async () => {
    const adapter = (status: string) =>
      createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ status })) });
    const job = { jobId: "req_123", provider: "grok", model: "grok-imagine-video" };

    let r = await adapter("pending").poll(job);
    expect(r.ok && r.value.state).toBe("pending");
    r = await adapter("done").poll(job);
    expect(r.ok && r.value.state).toBe("done");
    r = await adapter("failed").poll(job);
    expect(r.ok && r.value.state).toBe("failed");
    r = await adapter("expired").poll(job);
    expect(r.ok && r.value.state).toBe("failed");
  });

  // WR-01 (Phase 190): the off-turn poller drives poll() (NOT execute()); poll()
  // must carry the CLASSIFIED kind+hint on a terminal failed/expired status so the
  // poller persists the right errorKind/hint instead of collapsing to
  // empty_response. RED on pre-fix code: poll() returned `{ state:"failed" }` only.
  it("WR-01 poll: a status:failed with a moderation error carries the classified errorKind + hint on the snapshot", async () => {
    const job = { jobId: "req_123", provider: "grok", model: "grok-imagine-video" };

    // status:failed + a moderation error payload → content_blocked.
    let adapter = createGrokVideoAdapter({
      apiKey: API_KEY,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({ status: "failed", error: { code: "x", message: "blocked by moderation" } }),
      ),
    });
    let r = await adapter.poll(job);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("failed");
    expect(r.value.errorKind).toBe("content_blocked");
    expect(r.value.hint?.toLowerCase()).toContain("moderation");

    // status:expired (no error payload) → empty_response with an "expired" hint.
    adapter = createGrokVideoAdapter({
      apiKey: API_KEY,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ status: "expired" })),
    });
    r = await adapter.poll(job);
    expect(r.ok && r.value.errorKind).toBe("empty_response");
    expect(r.ok && r.value.hint?.toLowerCase()).toContain("expired");

    // A pending/done poll carries NO errorKind/hint (additive — undefined).
    adapter = createGrokVideoAdapter({
      apiKey: API_KEY,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ status: "pending" })),
    });
    r = await adapter.poll(job);
    expect(r.ok && r.value.state).toBe("pending");
    expect(r.ok && r.value.errorKind).toBeUndefined();
    expect(r.ok && r.value.hint).toBeUndefined();
  });

  it("GROK-01 poll: GETs /videos/{request_id} with the Bearer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "pending" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    await adapter.poll({ jobId: "req_xyz", provider: "grok", model: "grok-imagine-video" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${XAI_BASE}/videos/req_xyz`);
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("GROK-01 fetchResult: status:done + video.url → Buffer; cost_in_usd_ticks/1e10 → 0.07; redirect:error", async () => {
    const bytes = Buffer.from("GROKVIDEO");
    const fetchImpl = vi
      .fn()
      // 1st call: the status GET (done, with url + cost)
      .mockResolvedValueOnce(
        jsonResponse({
          status: "done",
          video: { url: "https://cdn/v.mp4" },
          usage: { cost_in_usd_ticks: 700000000 },
        }),
      )
      // 2nd call: the CDN download
      .mockResolvedValueOnce(okDownload(bytes));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });

    const r = await adapter.fetchResult({ jobId: "req_123", provider: "grok", model: "grok-imagine-video" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.isBuffer(r.value.buffer)).toBe(true);
    expect(r.value.buffer.equals(bytes)).toBe(true);
    expect(r.value.mimeType).toBe("video/mp4");
    expect(r.value.provider).toBe("grok");
    expect(r.value.sourceUrl).toBe("https://cdn/v.mp4");
    expect(r.value.costUsd).toBe(0.07); // 700000000 / 1e10

    // the download leg used redirect:"error"
    const dlInit = fetchImpl.mock.calls[1][1];
    expect(dlInit).toMatchObject({ redirect: "error" });
  });

  it("GROK-02 cost reconcile guard (SEC): negative/NaN/absent cost_in_usd_ticks → costUsd undefined", async () => {
    const bytes = Buffer.from("X");
    const makeAdapter = (ticks: unknown) => {
      const usage = ticks === "ABSENT" ? {} : { cost_in_usd_ticks: ticks };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ status: "done", video: { url: "https://cdn/v.mp4" }, usage }))
        .mockResolvedValueOnce(okDownload(bytes));
      return createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    };

    for (const ticks of [-5, Number.NaN, "ABSENT", "700" as unknown, Infinity]) {
      const r = await makeAdapter(ticks).fetchResult({
        jobId: "req_123",
        provider: "grok",
        model: "grok-imagine-video",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // A negative/NaN/non-number/non-finite must NEVER produce a costUsd that
      // could under-report spend and bypass the cost ceiling.
      expect(r.value.costUsd).toBeUndefined();
    }
  });

  it("GROK-02 status:failed → classified VideoGenError via fetchResult", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "failed", error: { code: "x", message: "blocked by moderation" } }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.fetchResult({ jobId: "req_123", provider: "grok", model: "grok-imagine-video" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.name).toBe("VideoGenError");
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("content_blocked");
  });

  it("GROK-02 status:expired → classified VideoGenError (empty_response) via execute()", async () => {
    const fetchImpl = vi
      .fn()
      // submit
      .mockResolvedValueOnce(jsonResponse({ request_id: "req_exp" }))
      // poll → expired
      .mockResolvedValue(jsonResponse({ status: "expired" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.execute({ prompt: "p" }, { timeoutMs: 10_000, pollIntervalMs: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.name).toBe("VideoGenError");
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("empty_response");
    expect((r.error as { hint?: string }).hint?.toLowerCase()).toContain("expired");
  });

  it("GROK-02 done-but-no-url → empty_response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "done", video: {} }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.fetchResult({ jobId: "req_123", provider: "grok", model: "grok-imagine-video" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("empty_response");
  });

  it("GROK-02 download-before-return (DEL-01): the download fetch resolves before fetchResult resolves", async () => {
    const bytes = Buffer.from("ORDERED");
    const order: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "done", video: { url: "https://cdn/v.mp4" } }))
      .mockImplementationOnce(async () => {
        order.push("download-start");
        const res = okDownload(bytes);
        order.push("download-resolved");
        return res;
      });
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.fetchResult({ jobId: "req_123", provider: "grok", model: "grok-imagine-video" });
    order.push("fetchResult-resolved");
    expect(r.ok).toBe(true);
    expect(order.indexOf("download-resolved")).toBeLessThan(order.indexOf("fetchResult-resolved"));
  });

  it("SEC (bearer never logged): no log arg string-contains the bearer; jobId is secret-free", async () => {
    const bytes = Buffer.from("SEC");
    const fetchImpl = vi
      .fn()
      // submit
      .mockResolvedValueOnce(jsonResponse({ request_id: "req_secure" }))
      // fetchResult status GET
      .mockResolvedValueOnce(jsonResponse({ status: "done", video: { url: "https://cdn/v.mp4" } }))
      // download
      .mockResolvedValueOnce(okDownload(bytes));

    const logCalls: unknown[] = [];
    const record = (...args: unknown[]) => logCalls.push(...args);
    const logger = { debug: record, info: record, warn: record, error: record, child: () => logger };

    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, logger: logger as never, fetchImpl });
    const sub = await adapter.submit({ prompt: "p" });
    expect(sub.ok && sub.value.jobId).toBe("req_secure");
    expect(sub.ok && sub.value.jobId).not.toContain(API_KEY);
    await adapter.fetchResult({ jobId: "req_secure", provider: "grok", model: "grok-imagine-video" });

    const blob = JSON.stringify(logCalls);
    expect(blob).not.toContain(API_KEY);
  });

  it("job_timeout: a stuck pending poll yields a job_timeout error naming the jobId", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ request_id: "req_slow" }))
      .mockResolvedValue(jsonResponse({ status: "pending" }));
    const adapter = createGrokVideoAdapter({ apiKey: API_KEY, fetchImpl });
    const r = await adapter.execute({ prompt: "p" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("job_timeout");
    expect((r.error as { hint?: string }).hint).toContain("req_slow");
  });

  it("DEFENSIVE OAuth branch (A1): submit resolves a per-call bearer via getApiKey; isAvailable reflects hasCredentials", async () => {
    const getApiKey = vi.fn().mockResolvedValue(ok("oauth.bearer"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ request_id: "req_oauth" }));
    const adapter = createGrokVideoAdapter({
      oauthManager: mockOauth({ hasCredentials: () => true, getApiKey }),
      fetchImpl,
    });

    expect(adapter.isAvailable()).toBe(true);
    const r = await adapter.submit({ prompt: "p" });
    expect(r.ok).toBe(true);
    expect(getApiKey).toHaveBeenCalled();
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer oauth.bearer");
  });

  it("DEFENSIVE OAuth branch: a getApiKey !ok → an auth_required VideoGenError", async () => {
    const adapter = createGrokVideoAdapter({
      oauthManager: mockOauth({ getApiKey: async () => err({ code: "NO_CREDENTIALS" }) }),
      fetchImpl: vi.fn(),
    });
    const r = await adapter.submit({ prompt: "p" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("auth_required");
  });

  it("no auth source → isAvailable false and submit errs auth_required", async () => {
    const adapter = createGrokVideoAdapter({ fetchImpl: vi.fn() });
    expect(adapter.isAvailable()).toBe(false);
    const r = await adapter.submit({ prompt: "p" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("auth_required");
  });
});
