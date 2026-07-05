// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createGoogleChatResolver,
  type GoogleChatResolverDeps,
} from "./googlechat-resolver.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real 1×1 PNG (magic bytes recognized by file-type), used to prove MIME sniff. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A representative uploaded-content resource name (media.download addresses these). */
const RESOURCE_NAME = "spaces/AAA/attachments/CCC";

/** The one URL a valid resolve must fetch: the app-auth media.download endpoint. */
const EXPECTED_URL =
  "https://chat.googleapis.com/v1/media/spaces/AAA/attachments/CCC?alt=media";

const SA_TOKEN = "SA_TOKEN";

function mockDeps(overrides: Partial<GoogleChatResolverDeps> = {}): GoogleChatResolverDeps {
  return {
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({
          buffer: PNG_1X1,
          mimeType: "image/png",
          sizeBytes: PNG_1X1.length,
        }),
      ),
    },
    getToken: vi.fn().mockResolvedValue(ok(SA_TOKEN)),
    maxBytes: 10 * 1024 * 1024,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function makeAttachment(url: string): Attachment {
  return { type: "image", url };
}

/** Wrap a resource name exactly as the message mapper does — proves decode is the inverse of encode. */
function attachmentUrl(resourceName: string): string {
  return `googlechat-attachment://${encodeURIComponent(resourceName)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("googlechat-resolver / createGoogleChatResolver", () => {
  it("declares schemes = ['googlechat-attachment'] and never claims the https scheme", () => {
    const resolver = createGoogleChatResolver(mockDeps());
    expect(resolver.schemes).toEqual(["googlechat-attachment"]);
    expect(resolver.schemes).not.toContain("https");
  });

  it("decodes the ref, builds the media.download URL, and fetches it with the SA Bearer pinned to the single host", async () => {
    const deps = mockDeps();
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(PNG_1X1);
      expect(result.value.sizeBytes).toBe(PNG_1X1.length);
    }

    // Exactly one fetch, to the media.download URL, with the Bearer pinned to the
    // single Chat media host (no config escape hatch).
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      EXPECTED_URL,
      expect.objectContaining({
        authHeader: `Bearer ${SA_TOKEN}`,
        authAllowHosts: ["chat.googleapis.com"],
      }),
    );
  });

  it("returns the sniffed MIME type, overriding a mislabeled declared content-type", async () => {
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({
            buffer: PNG_1X1,
            mimeType: "application/octet-stream",
            sizeBytes: PNG_1X1.length,
          }),
        ),
      },
    });
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sniffed image/png wins over the declared application/octet-stream.
      expect(result.value.mimeType).toBe("image/png");
    }
  });

  it("passes the fetched bytes and size straight through on the ok result (no envelope added)", async () => {
    const raw = Buffer.from("raw external media bytes");
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: raw, mimeType: "application/octet-stream", sizeBytes: raw.length }),
        ),
      },
    });
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer.equals(raw)).toBe(true);
      expect(result.value.sizeBytes).toBe(raw.length);
    }
  });

  // -------------------------------------------------------------------------
  // Validation guards: a malformed / empty / injection-bearing ref is rejected
  // BEFORE any token mint or fetch.
  // -------------------------------------------------------------------------

  it("returns err WITHOUT fetching when the payload is not valid percent-encoding", async () => {
    const deps = mockDeps();
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment("googlechat-attachment://%E0%A4%A"));

    expect(result.ok).toBe(false);
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "googlechat",
        errorKind: "validation",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it("returns err WITHOUT fetching when the decoded ref is empty", async () => {
    const deps = mockDeps();
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment("googlechat-attachment://"));

    expect(result.ok).toBe(false);
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
    expect(deps.getToken).not.toHaveBeenCalled();
  });

  it.each([
    ["query metacharacter (?)", "x?alt=evil"],
    ["fragment metacharacter (#)", "x#frag"],
    ["ampersand metacharacter (&)", "x&y=z"],
    ["whitespace", "a b"],
    ["control char", "a\u0001b"],
    ["DEL char", "a\u007fb"],
  ])(
    "rejects an injection-bearing resource name (%s) BEFORE any mint or fetch",
    async (_label, resourceName) => {
      const deps = mockDeps();
      const resolver = createGoogleChatResolver(deps);

      const result = await resolver.resolve(makeAttachment(attachmentUrl(resourceName)));

      expect(result.ok).toBe(false);
      // Rejected before the Bearer is minted AND before the guarded fetch runs.
      expect(deps.getToken).not.toHaveBeenCalled();
      expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
      const validationWarn = vi
        .mocked(deps.logger.warn)
        .mock.calls.map((c) => c[0])
        .find((p) => (p as { errorKind?: string }).errorKind === "validation");
      expect(validationWarn).toBeDefined();
    },
  );

  it.each([
    ["shallow traversal", "spaces/AAA/../BBB"],
    ["deep traversal that escapes /v1/media/", "spaces/AAA/../../../../etc"],
  ])(
    "rejects a path-traversal resource name (%s) before any fetch (off-path guard)",
    async (_label, resourceName) => {
      const deps = mockDeps();
      const resolver = createGoogleChatResolver(deps);

      const result = await resolver.resolve(makeAttachment(attachmentUrl(resourceName)));

      expect(result.ok).toBe(false);
      expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
      const validationWarn = vi
        .mocked(deps.logger.warn)
        .mock.calls.map((c) => c[0])
        .find((p) => (p as { errorKind?: string }).errorKind === "validation");
      expect(validationWarn).toBeDefined();
    },
  );

  it("RESOLVES an opaque base64/token resource name — no charset allowlist drops it", async () => {
    const deps = mockDeps();
    const resolver = createGoogleChatResolver(deps);
    // Token/base64 chars (+, =, ~) and multiple segments — a strict [A-Za-z0-9._/-]
    // message-name allowlist would wrongly drop this; the host + path assertion must not.
    const opaque = "spaces/AAA/attachments/CiQ+tok=b64~xyz/abc";

    const result = await resolver.resolve(makeAttachment(attachmentUrl(opaque)));

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledTimes(1);

    const firstArg = (deps.ssrfFetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = new URL(firstArg);
    expect(parsed.hostname).toBe("chat.googleapis.com");
    expect(parsed.pathname.startsWith("/v1/media/")).toBe(true);
    // The raw token chars survive into the path (proving no charset allowlist ran).
    expect(parsed.pathname).toContain("+");
    expect(parsed.pathname).toContain("=");
    expect(parsed.pathname).toContain("~");
    expect(parsed.pathname).toContain("/attachments/");
    // The only query is the pinned alt=media.
    expect(parsed.searchParams.get("alt")).toBe("media");
    expect([...parsed.searchParams.keys()]).toEqual(["alt"]);
  });

  it("never fetches the attachment's browser download link — only the media.download URL", async () => {
    const deps = mockDeps();
    const resolver = createGoogleChatResolver(deps);
    const DOWNLOAD_URI =
      "https://chat.google.com/api/get_attachment_url?url_type=DOWNLOAD_URL&attachment_id=xyz";
    // A fixture that ALSO carries a browser download link the resolver must ignore.
    const attachment = {
      ...makeAttachment(attachmentUrl(RESOURCE_NAME)),
      downloadUri: DOWNLOAD_URI,
    } as unknown as Attachment;

    const result = await resolver.resolve(attachment);

    expect(result.ok).toBe(true);
    const firstArg = (deps.ssrfFetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstArg).toBe(EXPECTED_URL);
    expect(firstArg).not.toBe(DOWNLOAD_URI);
    expect(firstArg).not.toContain("get_attachment_url");
  });

  // -------------------------------------------------------------------------
  // Failure branches.
  // -------------------------------------------------------------------------

  it("treats a token-mint failure as fatal — returns err and never fetches header-less", async () => {
    const deps = mockDeps({
      getToken: vi.fn().mockResolvedValue(err(new Error("token mint failed"))),
    });
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(false);
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("returns err and emits a platform WARN with durationMs + hint when the guarded fetch fails", async () => {
    const deps = mockDeps({
      ssrfFetcher: { fetch: vi.fn().mockResolvedValue(err(new Error("SSRF blocked"))) },
    });
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "googlechat",
        errorKind: "platform",
        durationMs: expect.any(Number),
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it("rejects an over-size body with a precondition WARN", async () => {
    const deps = mockDeps({
      maxBytes: 10,
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: Buffer.alloc(8), mimeType: "image/png", sizeBytes: 20 * 1024 * 1024 }),
        ),
      },
    });
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "googlechat",
        errorKind: "precondition",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it("never places the SA token or the constructed URL in a log field or the returned error", async () => {
    const token = "SA_TOKEN_SUPERSECRET";
    const deps = mockDeps({
      getToken: vi.fn().mockResolvedValue(ok(token)),
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          err(new Error(`fetch failed for ${EXPECTED_URL} using Bearer ${token}: HTTP 500`)),
        ),
      },
    });
    const resolver = createGoogleChatResolver(deps);

    const result = await resolver.resolve(makeAttachment(attachmentUrl(RESOURCE_NAME)));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(token);
      expect(result.error.message).not.toContain(EXPECTED_URL);
    }

    // No warn/debug log call carries the token or the constructed URL in any field.
    const allLogArgs = [
      ...vi.mocked(deps.logger.warn).mock.calls,
      ...vi.mocked(deps.logger.debug).mock.calls,
    ]
      .map((call) => JSON.stringify(call))
      .join(" ");
    expect(allLogArgs).not.toContain(token);
    expect(allLogArgs).not.toContain(EXPECTED_URL);
  });
});
