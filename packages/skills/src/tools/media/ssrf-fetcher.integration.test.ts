// SPDX-License-Identifier: Apache-2.0
/**
 * Real-network integration test for the SSRF-guarded fetcher.
 *
 * The whole point of this file is to catch dispatcher/handler ABI mismatches
 * (and similar runtime regressions) by exercising the REAL `undici.fetch` +
 * REAL `undici.Agent` against a REAL local HTTP server.
 *
 * Therefore: we DO NOT mock `undici`, `globalThis.fetch`, or `node:http`.
 * The ONLY mock is `validateUrl` from `@comis/core`, because the real SSRF
 * validator (correctly) rejects loopback IPs.
 *
 * On the pre-fix code path (`globalThis.fetch + new undici@8.Agent()`), the
 * happy-path test below FAILS with `InvalidArgumentError: invalid
 * onRequestStart method` — that is the regression signal we wanted.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import http, { type Server } from "node:http";
import { ok } from "@comis/shared";
import { createSsrfGuardedFetcher } from "./ssrf-fetcher.js";
import type { ValidatedUrl } from "@comis/core";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { validateUrl } from "@comis/core";

// Mock ONLY validateUrl from @comis/core (real validator rejects loopback).
vi.mock("@comis/core", () => ({
  validateUrl: vi.fn(),
}));

const mockValidateUrl = vi.mocked(validateUrl);

function makeLocalValidatedUrl(urlStr: string): ValidatedUrl {
  const url = new URL(urlStr);
  return { hostname: url.hostname, ip: "127.0.0.1", url };
}

describe("createSsrfGuardedFetcher (integration)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((errClose) => (errClose ? reject(errClose) : resolve())),
      );
      server = undefined;
    }
    vi.restoreAllMocks();
  });

  it("fetches a real 4KB image body over loopback (real undici fetch + Agent)", async () => {
    const body = Buffer.alloc(4096, 0xab);

    const handler: http.RequestListener = (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(body.length),
      });
      res.end(body);
    };

    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no server address");
    }
    const port = address.port;

    const url = "http://127.0.0.1:" + port + "/img.png";
    mockValidateUrl.mockResolvedValue(ok(makeLocalValidatedUrl(url)));

    const fetcher = createSsrfGuardedFetcher(
      { maxBytes: 1024 * 1024 },
      createMockLogger(),
    );

    const result = await fetcher.fetch(url);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toBeInstanceOf(Buffer);
      expect(result.value.buffer.length).toBe(4096);
      expect(result.value.buffer[0]).toBe(0xab);
      expect(result.value.buffer[4095]).toBe(0xab);
      expect(result.value.sizeBytes).toBe(4096);
      expect(result.value.mimeType).toBe("image/png");
      expect(result.value.resolvedIp).toBe("127.0.0.1");
    }
  });

  it("classifies HTTP 500 from a real server as a non-ok result", async () => {
    const handler: http.RequestListener = (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
    };

    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no server address");
    }
    const port = address.port;

    const url = "http://127.0.0.1:" + port + "/boom";
    mockValidateUrl.mockResolvedValue(ok(makeLocalValidatedUrl(url)));

    const fetcher = createSsrfGuardedFetcher(
      { maxBytes: 1024 * 1024 },
      createMockLogger(),
    );

    const result = await fetcher.fetch(url);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("HTTP 500");
    }
  });
});
