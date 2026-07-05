// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary suite for the import acquire step. Every `archiveUrl` fetch must go
 * through the SSRF guard (a loopback / cloud-metadata target rejects before a
 * connection is opened) and be byte-capped at maxArchiveBytes (an over-declared
 * Content-Length rejects pre-stream; an under-declared body rejects mid-stream).
 * An `archiveBytes` input is size-capped before decode; a `fileSet` passes
 * through untouched with no fetch at all (the retrofit + resolver seam).
 *
 * The SSRF-rejection cases use the real guard (a loopback/metadata IP literal
 * needs no network); the cap cases inject the validator + fetch seams so the
 * cap is exercised deterministically off-network.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import {
  acquire,
  type ArchiveHttpResponse,
  type ArchiveResponseBody,
} from "./acquire.js";

// ---------------------------------------------------------------------------
// Response stub helpers (a minimal web-stream body the capped reader consumes)
// ---------------------------------------------------------------------------

function streamOf(chunks: readonly Uint8Array[]): ArchiveResponseBody {
  let index = 0;
  let cancelled = false;
  return {
    getReader() {
      return {
        async read() {
          if (cancelled || index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++]! };
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
    async cancel() {
      cancelled = true;
    },
  };
}

function stubResponse(opts: {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  chunks?: readonly Uint8Array[];
  noBody?: boolean;
}): ArchiveHttpResponse {
  const headers = new Map<string, string>();
  if (opts.contentLength != null) headers.set("content-length", opts.contentLength);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: opts.noBody === true ? null : streamOf(opts.chunks ?? []),
  };
}

const okValidator = vi.fn(async () => ok({ hostname: "example.invalid", ip: "203.0.113.10" }));

describe("acquire — archiveUrl SSRF + byte-cap", () => {
  it("rejects a loopback archiveUrl through the SSRF guard before fetching", async () => {
    const result = await acquire(
      { kind: "archiveUrl", url: "http://127.0.0.1:9/skill.zip" },
      { caps: { maxArchiveBytes: 1000 } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
    expect(result.error.message.toLowerCase()).toContain("ssrf");
  });

  it("rejects a cloud-metadata archiveUrl through the SSRF guard", async () => {
    const result = await acquire(
      { kind: "archiveUrl", url: "http://169.254.169.254/latest/meta-data/" },
      { caps: { maxArchiveBytes: 1000 } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("validation");
  });

  it("rejects an over-declared Content-Length body naming the maxArchiveBytes cap", async () => {
    const fetchImpl = vi.fn(async () => stubResponse({ contentLength: "999999" }));
    const result = await acquire(
      { kind: "archiveUrl", url: "https://example.invalid/skill.zip" },
      { caps: { maxArchiveBytes: 1000 }, validate: okValidator, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message + result.error.hint).toContain("maxArchiveBytes");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a body that exceeds maxArchiveBytes mid-stream when Content-Length is absent", async () => {
    const big = new Uint8Array(700);
    const fetchImpl = vi.fn(async () =>
      stubResponse({ contentLength: null, chunks: [big, big, big] }),
    );
    const result = await acquire(
      { kind: "archiveUrl", url: "https://example.invalid/skill.zip" },
      { caps: { maxArchiveBytes: 1000 }, validate: okValidator, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message + result.error.hint).toContain("maxArchiveBytes");
  });

  it("returns the fetched bytes for an archiveUrl body within the cap", async () => {
    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const fetchImpl = vi.fn(async () => stubResponse({ chunks: [payload] }));
    const result = await acquire(
      { kind: "archiveUrl", url: "https://example.invalid/skill.zip" },
      { caps: { maxArchiveBytes: 1000 }, validate: okValidator, fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("archive");
    if (result.value.kind !== "archive") return;
    expect(Buffer.from(result.value.bytes).equals(Buffer.from(payload))).toBe(true);
  });

  it("rejects an HTTP error status from the archiveUrl host", async () => {
    const fetchImpl = vi.fn(async () => stubResponse({ ok: false, status: 404 }));
    const result = await acquire(
      { kind: "archiveUrl", url: "https://example.invalid/skill.zip" },
      { caps: { maxArchiveBytes: 1000 }, validate: okValidator, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("network");
  });

  it("rejects with a network error when the pinned fetch itself throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await acquire(
      { kind: "archiveUrl", url: "https://example.invalid/skill.zip" },
      { caps: { maxArchiveBytes: 1000 }, validate: okValidator, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("network");
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("rejects an archiveUrl response that carries no body", async () => {
    const fetchImpl = vi.fn(async () => stubResponse({ noBody: true }));
    const result = await acquire(
      { kind: "archiveUrl", url: "https://example.invalid/skill.zip" },
      { caps: { maxArchiveBytes: 1000 }, validate: okValidator, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("network");
  });
});

describe("acquire — archiveBytes size-cap + decode", () => {
  it("rejects an over-cap base64 archive before decoding it, naming the cap", async () => {
    const oversized = Buffer.alloc(2000, 0x41).toString("base64");
    const result = await acquire(
      { kind: "archiveBytes", base64: oversized },
      { caps: { maxArchiveBytes: 1000 } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorKind).toBe("resource");
    expect(result.error.message + result.error.hint).toContain("maxArchiveBytes");
  });

  it("decodes an archiveBytes base64 payload that is within the cap", async () => {
    const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99]);
    const result = await acquire(
      { kind: "archiveBytes", base64: raw.toString("base64") },
      { caps: { maxArchiveBytes: 1000 } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== "archive") return;
    expect(result.value.bytes.equals(raw)).toBe(true);
  });
});

describe("acquire — fileSet pass-through", () => {
  it("passes a file set through unchanged without opening a network connection", async () => {
    const fetchImpl = vi.fn(async () => stubResponse({}));
    const validate = vi.fn(async () => ok({ hostname: "x", ip: "203.0.113.1" }));
    const files = [
      { path: "SKILL.md", content: "# skill" },
      { path: "references/guide.md", content: "guide" },
    ];
    const result = await acquire(
      { kind: "fileSet", files },
      { caps: { maxArchiveBytes: 1000 }, validate, fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("fileSet");
    if (result.value.kind !== "fileSet") return;
    expect(result.value.files).toEqual(files);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
});
