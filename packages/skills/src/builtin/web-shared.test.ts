// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for web-shared utilities: readResponseText byte-streaming, clampMaxBytes.
 */

import { describe, expect, it } from "vitest";
import { clampMaxBytes, readResponseText, DEFAULT_MAX_RESPONSE_BYTES } from "./web-shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Response with a ReadableStream body from the given string content. */
function mockStreamResponse(content: string): Response {
  const bytes = new TextEncoder().encode(content);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Push in small chunks to exercise the streaming path
      const chunkSize = 64;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/** Create a mock Response that uses res.text() (no streaming body). */
function mockTextResponse(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/** Create a mock Response whose body/text throws an error. */
function mockFailingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("Network reset"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// clampMaxBytes
// ---------------------------------------------------------------------------

describe("clampMaxBytes", () => {
  it("clamps below floor to 32KB", () => {
    expect(clampMaxBytes(100)).toBe(32_000);
    expect(clampMaxBytes(0)).toBe(32_000);
    expect(clampMaxBytes(-1)).toBe(32_000);
  });

  it("clamps above ceiling to 5MB", () => {
    expect(clampMaxBytes(10_000_000)).toBe(5_000_000);
    expect(clampMaxBytes(999_999_999)).toBe(5_000_000);
  });

  it("passes through values within range", () => {
    expect(clampMaxBytes(100_000)).toBe(100_000);
    expect(clampMaxBytes(2_000_000)).toBe(2_000_000);
    expect(clampMaxBytes(5_000_000)).toBe(5_000_000);
    expect(clampMaxBytes(32_000)).toBe(32_000);
  });

  it("floors fractional values", () => {
    expect(clampMaxBytes(100_000.7)).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_MAX_RESPONSE_BYTES
// ---------------------------------------------------------------------------

describe("DEFAULT_MAX_RESPONSE_BYTES", () => {
  it("is 2MB", () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(2_000_000);
  });
});

// ---------------------------------------------------------------------------
// readResponseText — no options (backward-compatible)
// ---------------------------------------------------------------------------

describe("readResponseText without options", () => {
  it("returns full text with truncated=false and bytesRead", async () => {
    const content = "Hello, world!";
    const res = mockTextResponse(content);
    const result = await readResponseText(res);

    expect(result.text).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(Buffer.byteLength(content, "utf-8"));
  });

  it("returns empty result on error", async () => {
    const res = mockFailingResponse();
    const result = await readResponseText(res);

    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readResponseText — with maxBytes (streaming)
// ---------------------------------------------------------------------------

describe("readResponseText with maxBytes", () => {
  it("returns full text when maxBytes exceeds content size", async () => {
    const content = "Short content";
    const res = mockStreamResponse(content);
    const result = await readResponseText(res, { maxBytes: 1_000_000 });

    expect(result.text).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(Buffer.byteLength(content, "utf-8"));
  });

  it("truncates text when content exceeds maxBytes", async () => {
    // Create a 1000-byte ASCII string
    const content = "x".repeat(1000);
    const res = mockStreamResponse(content);
    const result = await readResponseText(res, { maxBytes: 200 });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBeLessThanOrEqual(200);
    // The returned text should be shorter than original
    expect(result.text.length).toBeLessThan(content.length);
  });

  it("returns bytesRead matching the actual bytes consumed", async () => {
    const content = "A".repeat(500);
    const res = mockStreamResponse(content);
    const result = await readResponseText(res, { maxBytes: 300 });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(300);
  });

  it("handles multi-byte UTF-8 content correctly", async () => {
    // Each emoji is 4 bytes in UTF-8
    const content = "\u{1F600}".repeat(100); // 400 bytes total
    const res = mockStreamResponse(content);
    const result = await readResponseText(res, { maxBytes: 100 });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBeLessThanOrEqual(100);
  });

  it("returns empty result on stream error", async () => {
    const res = mockFailingResponse();
    const result = await readResponseText(res, { maxBytes: 1000 });

    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(0);
  });

  it("falls back to res.text() when body is null", async () => {
    // Simulate a response with no body stream
    const content = "fallback content";
    const res = {
      body: null,
      text: async () => content,
    } as unknown as Response;

    const result = await readResponseText(res, { maxBytes: 1_000_000 });

    expect(result.text).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(Buffer.byteLength(content, "utf-8"));
  });
});
