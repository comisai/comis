// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createVeoVideoAdapter (VEO-01 / VEO-02 / SEC / job_timeout).
 *
 * Mocks the `@google/genai` MODULE via the `vi.hoisted()` class-default idiom
 * (mirrors google-images-transport.test.ts:28-44 — the Phase-185 lesson: a plain
 * top-level const TDZs at hoist time). `generateVideos` / `getVideosOperation`
 * are controllable spies; global `fetch` is mocked for the URI download. NEVER a
 * real GOOGLE_API_KEY, NEVER the network.
 *
 * Observable oracles (deterministic): submit→op.name jobId; poll→.done/.error
 * map; fetchResult→Buffer (uri-with-key OR videoBytes base64); operation.error→
 * classified VideoGenError; download-before-return (DEL-01); the keyed URL +
 * apiKey never reach a logger (VPORT-03 + SEC); job_timeout on a stuck poll.
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @google/genai — class-based GoogleGenAI (mirrors google-images-transport
// .test.ts). `genVideos` = generateVideos spy; `getOp` = getVideosOperation spy;
// `ctor` records the { apiKey } constructor arg.
// ---------------------------------------------------------------------------
const { genVideos, getOp, ctor, MockGoogleGenAI } = vi.hoisted(() => {
  const genVideos = vi.fn();
  const getOp = vi.fn();
  const ctor = vi.fn();
  class MockGoogleGenAI {
    models = { generateVideos: genVideos };
    operations = { getVideosOperation: getOp };
    constructor(args: unknown) {
      ctor(args);
    }
  }
  return { genVideos, getOp, ctor, MockGoogleGenAI };
});

vi.mock("@google/genai", () => ({ GoogleGenAI: MockGoogleGenAI }));

import { createVeoVideoAdapter } from "./veo-adapter.js";

const API_KEY = "gk-test-key-123";

function makeAdapter(over: { model?: string; logger?: unknown } = {}) {
  return createVeoVideoAdapter({
    apiKey: API_KEY,
    ...(over.model ? { model: over.model } : {}),
    ...(over.logger ? { logger: over.logger as never } : {}),
  });
}

/** A 200 fetch Response whose body streams the given bytes. */
function okResponse(bytes: Buffer, contentType = "video/mp4"): Response {
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

beforeEach(() => {
  genVideos.mockReset();
  getOp.mockReset();
  ctor.mockReset();
  vi.restoreAllMocks();
});

describe("createVeoVideoAdapter", () => {
  it("VEO-01 submit: generateVideos op.name becomes the jobId; ctor gets { apiKey }", async () => {
    genVideos.mockResolvedValue({ name: "operations/abc123", done: false });
    const adapter = makeAdapter();

    const r = await adapter.submit({ prompt: "a cat" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ jobId: "operations/abc123", provider: "veo", model: expect.any(String) });

    expect(ctor).toHaveBeenCalledWith({ apiKey: API_KEY });
    const callArg = genVideos.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({ model: expect.any(String), prompt: "a cat" });
    expect(callArg).toHaveProperty("config");
  });

  it("VEO-01 submit: a missing op.name is an error (no orphan jobId)", async () => {
    genVideos.mockResolvedValue({ done: false }); // no name
    const adapter = makeAdapter();
    const r = await adapter.submit({ prompt: "x" });
    expect(r.ok).toBe(false);
  });

  it("VEO-01 poll: maps .done/.error to pending|done|failed", async () => {
    const adapter = makeAdapter();
    const job = { jobId: "operations/abc", provider: "veo", model: "m" };

    getOp.mockResolvedValueOnce({ done: false });
    let r = await adapter.poll(job);
    expect(r.ok && r.value.state).toBe("pending");

    getOp.mockResolvedValueOnce({ done: true, response: { generatedVideos: [] } });
    r = await adapter.poll(job);
    expect(r.ok && r.value.state).toBe("done");

    getOp.mockResolvedValueOnce({ done: true, error: { code: 3, message: "x" } });
    r = await adapter.poll(job);
    expect(r.ok && r.value.state).toBe("failed");

    // The polled operation is reconstructed from the jobId (the 189 poller only
    // has { jobId }) — assert the SDK got { operation: { name } }.
    expect(getOp).toHaveBeenLastCalledWith({ operation: { name: "operations/abc" } });
  });

  // WR-01 (Phase 190): the off-turn poller drives poll() (NOT execute()); poll()
  // must carry the CLASSIFIED kind+hint on a terminal operation.error so the
  // poller persists the right errorKind/hint instead of collapsing to
  // empty_response. RED on pre-fix code: poll() returned `{ state:"failed" }` only.
  it("WR-01 poll: a terminal operation.error carries the classified errorKind + hint on the snapshot", async () => {
    const adapter = makeAdapter();
    const job = { jobId: "operations/blocked", provider: "veo", model: "m" };

    // A responsible-AI / content-policy block.
    getOp.mockResolvedValueOnce({
      done: true,
      error: { code: 9, message: "blocked by responsible AI safety policy" },
    });
    let r = await adapter.poll(job);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("failed");
    expect(r.value.errorKind).toBe("content_blocked");
    expect(r.value.hint).toContain("safety");

    // A permission-denied → auth_required (a FIXED hint, never the raw message).
    getOp.mockResolvedValueOnce({ done: true, error: { code: 7, message: "permission denied" } });
    r = await adapter.poll(job);
    expect(r.ok && r.value.errorKind).toBe("auth_required");
    expect(r.ok && r.value.hint).toContain("GOOGLE_API_KEY");

    // A successful/pending poll carries NO errorKind/hint (additive — undefined).
    getOp.mockResolvedValueOnce({ done: false });
    r = await adapter.poll(job);
    expect(r.ok && r.value.state).toBe("pending");
    expect(r.ok && r.value.errorKind).toBeUndefined();
    expect(r.ok && r.value.hint).toBeUndefined();
  });

  it("VEO-01 fetchResult (uri path): downloads via fetch(uri + &key=) with redirect:error", async () => {
    const bytes = Buffer.from("VIDEOBYTES");
    getOp.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [{ video: { uri: "https://example/v.mp4", mimeType: "video/mp4" } }],
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(okResponse(bytes));
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = makeAdapter();
    const r = await adapter.fetchResult({ jobId: "operations/abc", provider: "veo", model: "m" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.isBuffer(r.value.buffer)).toBe(true);
    expect(r.value.buffer.equals(bytes)).toBe(true);
    expect(r.value.mimeType).toBe("video/mp4");
    expect(r.value.provider).toBe("veo");
    expect(r.value.sourceUrl).toBe("https://example/v.mp4");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url.endsWith(`&key=${API_KEY}`)).toBe(true);
    expect(url.startsWith("https://example/v.mp4")).toBe(true);
    expect(init).toMatchObject({ redirect: "error" });
  });

  it("VEO-01 fetchResult (videoBytes path): decodes base64 WITHOUT calling fetch", async () => {
    const bytes = Buffer.from("INLINEVIDEO");
    getOp.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [{ video: { videoBytes: bytes.toString("base64"), mimeType: "video/mp4" } }],
      },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = makeAdapter();
    const r = await adapter.fetchResult({ jobId: "operations/abc", provider: "veo", model: "m" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.buffer.equals(bytes)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("VEO-02 config: builds durationSeconds as a NUMBER and omits absent fields", async () => {
    genVideos.mockResolvedValue({ name: "operations/cfg", done: false });
    const adapter = makeAdapter();

    await adapter.submit({
      prompt: "p",
      durationSecs: 8,
      aspectRatio: "16:9",
      resolution: "720p",
      negativePrompt: "blur",
      audio: true,
      seed: 42,
    });
    const config = genVideos.mock.calls[0]?.[0]?.config;
    expect(config).toEqual({
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720p",
      negativePrompt: "blur",
      generateAudio: true,
      seed: 42,
    });
    // durationSeconds is the NUMBER 8, never the FAL "8s" string.
    expect(config.durationSeconds).toBe(8);
    expect(typeof config.durationSeconds).toBe("number");
  });

  it("VEO-02 config: omits every field absent from the input (no undefined keys)", async () => {
    genVideos.mockResolvedValue({ name: "operations/min", done: false });
    const adapter = makeAdapter();
    await adapter.submit({ prompt: "only prompt" });
    const config = genVideos.mock.calls[0]?.[0]?.config;
    expect(config).toEqual({});
    expect(Object.keys(config)).not.toContain("durationSeconds");
    expect(Object.keys(config)).not.toContain("seed");
  });

  it("VEO-02 operation.error → classified VideoGenError via execute()", async () => {
    genVideos.mockResolvedValue({ name: "operations/err", done: false });
    getOp.mockResolvedValue({ done: true, error: { code: 7, message: "permission denied" } });

    const adapter = makeAdapter();
    const r = await adapter.execute({ prompt: "p" }, { timeoutMs: 10_000, pollIntervalMs: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.name).toBe("VideoGenError");
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("auth_required");
    expect((r.error as { hint?: string }).hint).toContain("GOOGLE_API_KEY");
  });

  it("VEO-02 download-before-return (DEL-01): fetch resolves before fetchResult resolves", async () => {
    const bytes = Buffer.from("ORDERED");
    getOp.mockResolvedValue({
      done: true,
      response: { generatedVideos: [{ video: { uri: "https://example/v.mp4" } }] },
    });
    const order: string[] = [];
    const fetchSpy = vi.fn().mockImplementation(async () => {
      order.push("fetch-start");
      const res = okResponse(bytes);
      order.push("fetch-resolved");
      return res;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = makeAdapter();
    const r = await adapter.fetchResult({ jobId: "operations/abc", provider: "veo", model: "m" });
    order.push("fetchResult-resolved");
    expect(r.ok).toBe(true);
    // The download must have happened (and resolved) before the function returns.
    expect(order).toContain("fetch-resolved");
    expect(order.indexOf("fetch-resolved")).toBeLessThan(order.indexOf("fetchResult-resolved"));
  });

  it("SEC: jobId is op.name (opaque, no &key=) and the apiKey/keyed URL never reach the logger", async () => {
    genVideos.mockResolvedValue({ name: "operations/secure", done: false });
    getOp.mockResolvedValue({
      done: true,
      response: { generatedVideos: [{ video: { uri: "https://example/v.mp4" } }] },
    });
    const bytes = Buffer.from("SEC");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(bytes)));

    const logCalls: unknown[] = [];
    const record = (...args: unknown[]) => logCalls.push(...args);
    const logger = { debug: record, info: record, warn: record, error: record, child: () => logger };

    const adapter = makeAdapter({ logger });
    const sub = await adapter.submit({ prompt: "p" });
    expect(sub.ok && sub.value.jobId).toBe("operations/secure");
    expect(sub.ok && sub.value.jobId).not.toContain("&key=");
    await adapter.fetchResult({ jobId: "operations/secure", provider: "veo", model: "m" });

    const blob = JSON.stringify(logCalls);
    expect(blob).not.toContain(API_KEY);
    expect(blob).not.toContain("&key=");
  });

  it("job_timeout: a stuck pending poll yields a job_timeout error naming the jobId", async () => {
    genVideos.mockResolvedValue({ name: "operations/slow", done: false });
    getOp.mockResolvedValue({ done: false }); // never completes
    const adapter = makeAdapter();
    const r = await adapter.execute({ prompt: "p" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { videoErrorKind?: string }).videoErrorKind).toBe("job_timeout");
    expect((r.error as { hint?: string }).hint).toContain("operations/slow");
  });

  it("isAvailable() is true and id is 'veo'", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("veo");
    expect(adapter.isAvailable()).toBe(true);
  });
});
