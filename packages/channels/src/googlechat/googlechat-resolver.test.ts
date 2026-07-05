// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { ok } from "@comis/shared";
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
});
