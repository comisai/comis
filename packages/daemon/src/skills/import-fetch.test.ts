// SPDX-License-Identifier: Apache-2.0
/**
 * Remote skill fetch security contract: validate, DNS-pin, revalidate
 * redirects, and bound bytes before a source resolver sees them.
 */
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import {
  fetchSkillImportResponse,
  readSkillImportBytes,
  type SkillImportFetchDeps,
  type SkillImportResponse,
} from "./import-fetch.js";

function response(overrides: Partial<SkillImportResponse> = {}): SkillImportResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: null,
    ...overrides,
  };
}

function deps(overrides: Partial<SkillImportFetchDeps> = {}): SkillImportFetchDeps {
  return {
    validate: vi.fn(async (url: string) =>
      ok({ hostname: new URL(url).hostname, ip: "203.0.113.10", url: new URL(url) }),
    ),
    fetchPinned: vi.fn(async () => response()),
    ...overrides,
  };
}

describe("fetchSkillImportResponse", () => {
  it("refuses an SSRF-blocked URL before the pinned fetch can run", async () => {
    const fetchPinned = vi.fn();
    const result = await fetchSkillImportResponse("http://127.0.0.1/private", {
      ...deps(),
      validate: vi.fn(async () => err(new Error("Blocked: loopback range"))),
      fetchPinned,
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ message: expect.stringContaining("loopback") }) });
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("pins the request to the IP returned by URL validation", async () => {
    const fetchPinned = vi.fn(async () => response());
    const result = await fetchSkillImportResponse("https://example.com/skill", {
      ...deps(),
      validate: vi.fn(async () =>
        ok({ hostname: "example.com", ip: "198.51.100.8", url: new URL("https://example.com/skill") }),
      ),
      fetchPinned,
    });

    expect(result.ok).toBe(true);
    expect(fetchPinned).toHaveBeenCalledWith(
      "https://example.com/skill",
      "198.51.100.8",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("revalidates a redirect target before issuing the next request", async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce(
        ok({ hostname: "one.example", ip: "198.51.100.1", url: new URL("https://one.example/a") }),
      )
      .mockResolvedValueOnce(
        ok({ hostname: "two.example", ip: "198.51.100.2", url: new URL("https://two.example/b") }),
      );
    const fetchPinned = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ok: false, status: 302, statusText: "Found", headers: new Headers({ location: "https://two.example/b" }) }),
      )
      .mockResolvedValueOnce(response());

    const result = await fetchSkillImportResponse("https://one.example/a", {
      validate,
      fetchPinned,
    });

    expect(result.ok).toBe(true);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(fetchPinned).toHaveBeenNthCalledWith(
      2,
      "https://two.example/b",
      "198.51.100.2",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});

describe("readSkillImportBytes", () => {
  it("rejects an oversized declared content length without reading the body", async () => {
    const iterator = vi.fn();
    const result = await readSkillImportBytes(
      response({
        headers: new Headers({ "content-length": "101" }),
        body: { [Symbol.asyncIterator]: iterator },
      }),
      100,
      "skills.import.maxArchiveBytes",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("skills.import.maxArchiveBytes=100");
    expect(iterator).not.toHaveBeenCalled();
  });

  it("rejects streamed bytes as soon as the actual cap is crossed", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([1, 2, 3]);
      yield Uint8Array.from([4, 5, 6]);
    }
    const result = await readSkillImportBytes(
      response({ body: chunks() }),
      5,
      "skills.installVetting.maxEntryBytes",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("actual bytes 6 exceed");
  });
});
