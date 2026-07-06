// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createMatrixResolver, type MatrixResolverDeps } from "../matrix-resolver.js";
import { encryptAttachment } from "../media-handler.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// The resolver never bare-fetches: every byte rides the injected SSRF-guarded
// fetcher, which is faked here (record the opts it is called with, return
// ok/err on command). The authed download URL is built by the client
// (mxcUrlToHttp with useAuthentication) — the fake client returns a fixed URL,
// so the test proves the fetcher receives the CLIENT-built URL, never a
// hand-assembled one. The E2EE key side-channel (getEncryptedFile) is a stub;
// the encrypt/decrypt cases use the REAL codec to make a matching cipher+record.
// ---------------------------------------------------------------------------

/** A real 1×1 PNG (magic bytes recognized by file-type), used to prove MIME sniff. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const MXC = "mxc://example.org/abc123";
const HOMESERVER_HOST = "hs.test";
/** The authenticated media download URL the client builds for {@link MXC}. */
const AUTHED_URL = `https://${HOMESERVER_HOST}/_matrix/client/v1/media/download/example.org/abc123?allow_redirect=true`;
const TOKEN = "syt-secret-access-token-value";

// The WASM engine loads on first codec use; give the encrypt/decrypt cases headroom.
const CRYPTO_TIMEOUT_MS = 30_000;

type MediaClient = NonNullable<ReturnType<MatrixResolverDeps["getMediaClient"]>>;

function makeMediaClient(over: Partial<MediaClient> = {}): MediaClient {
  return {
    mxcUrlToHttp: vi.fn().mockReturnValue(AUTHED_URL),
    getAccessToken: vi.fn().mockReturnValue(TOKEN),
    homeserverHost: HOMESERVER_HOST,
    ...over,
  };
}

function makeAttachment(url: string = MXC): Attachment {
  return { type: "image", url };
}

/**
 * Build resolver deps with a happy-path fake fetcher (returns a PNG). Pass
 * `media` undefined to model the pre-start state (getMediaClient → undefined).
 */
function baseDeps(
  media: MediaClient | undefined,
  over: Partial<MatrixResolverDeps> = {},
): MatrixResolverDeps {
  return {
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({ buffer: PNG_1X1, mimeType: "image/png", sizeBytes: PNG_1X1.length, resolvedIp: "1.2.3.4" }),
      ),
    },
    maxBytes: 10 * 1024 * 1024,
    logger: { debug: vi.fn(), warn: vi.fn() },
    getMediaClient: () => media,
    getEncryptedFile: () => undefined,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("matrix-resolver / createMatrixResolver", () => {
  it("declares schemes = ['mxc'] and claims no other scheme", () => {
    const resolver = createMatrixResolver(baseDeps(makeMediaClient()));
    expect(resolver.schemes).toEqual(["mxc"]);
    expect(resolver.schemes).not.toContain("https");
  });

  it("builds the authenticated download URL from the client and fetches it through the injected guarded fetcher with the homeserver-scoped bearer", async () => {
    const media = makeMediaClient();
    const deps = baseDeps(media);
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve(makeAttachment());

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sniffed from the returned bytes; size is the resolved buffer length.
      expect(result.value.mimeType).toBe("image/png");
      expect(result.value.sizeBytes).toBe(PNG_1X1.length);
      expect(result.value.buffer.equals(PNG_1X1)).toBe(true);
    }

    // The URL comes from the client with useAuthentication enabled (7th arg true),
    // never a hand-built path.
    expect(vi.mocked(media.mxcUrlToHttp)).toHaveBeenCalledWith(
      MXC,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );

    // The CLIENT-built authed URL reaches the guarded fetcher, with the bearer
    // scoped to the homeserver host only (dropped on a cross-host redirect by the fetcher).
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      AUTHED_URL,
      expect.objectContaining({
        authHeader: `Bearer ${TOKEN}`,
        authAllowHosts: [HOMESERVER_HOST],
      }),
    );
    // The mxc:// value itself is never handed to the fetcher.
    const fetchedUrl = (deps.ssrfFetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(fetchedUrl).toBe(AUTHED_URL);
    expect(fetchedUrl).not.toBe(MXC);
  });

  it(
    "decrypts an encrypted attachment to byte-identical plaintext before resolving",
    async () => {
      // Produce a real cipher + matching encrypted-file record with the codec.
      const { ciphertext, info } = await encryptAttachment(PNG_1X1);
      const record = { ...info, url: MXC };

      const media = makeMediaClient();
      const getEncryptedFile = vi.fn().mockReturnValue(record);
      const deps = baseDeps(media, {
        getEncryptedFile,
        ssrfFetcher: {
          // The fetched body is the CIPHERTEXT; the resolver must decrypt it.
          fetch: vi.fn().mockResolvedValue(
            ok({
              buffer: ciphertext,
              mimeType: "application/octet-stream",
              sizeBytes: ciphertext.length,
              resolvedIp: "1.2.3.4",
            }),
          ),
        },
      });
      const resolver = createMatrixResolver(deps);

      const result = await resolver.resolve(makeAttachment());

      // Keyed by the mxc (the attachment url).
      expect(getEncryptedFile).toHaveBeenCalledWith(MXC);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Resolved bytes are the decrypted plaintext, and the MIME is sniffed from
        // the DECRYPTED bytes (not the ciphertext's octet-stream header).
        expect(result.value.buffer.equals(PNG_1X1)).toBe(true);
        expect(result.value.mimeType).toBe("image/png");
        expect(result.value.sizeBytes).toBe(PNG_1X1.length);
      }
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "fails closed on a tampered ciphertext and leaks neither the url nor the token",
    async () => {
      const { ciphertext, info } = await encryptAttachment(PNG_1X1);
      const tampered = Buffer.from(ciphertext);
      tampered[0] ^= 0xff; // flip a byte → SHA-256 integrity check must reject

      const record = { ...info, url: MXC };
      const media = makeMediaClient();
      const deps = baseDeps(media, {
        getEncryptedFile: vi.fn().mockReturnValue(record),
        ssrfFetcher: {
          fetch: vi.fn().mockResolvedValue(
            ok({
              buffer: tampered,
              mimeType: "application/octet-stream",
              sizeBytes: tampered.length,
              resolvedIp: "1.2.3.4",
            }),
          ),
        },
      });
      const resolver = createMatrixResolver(deps);

      const result = await resolver.resolve(makeAttachment());

      // No partial plaintext: the decrypt throw is caught and returned as a clean err.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain(AUTHED_URL);
        expect(result.error.message).not.toContain(TOKEN);
      }
    },
    CRYPTO_TIMEOUT_MS,
  );

  it("fails closed when an attachment marked encrypted has no cached key, never returning the ciphertext as plaintext", async () => {
    // The inbound event indicated E2EE (content.file present) so the attachment is
    // marked encrypted, but the key record is absent (getEncryptedFile → undefined):
    // evicted from the bounded cache under a media flood, or a structurally-incomplete
    // record. The resolver must NOT fall into the plaintext branch and hand back the
    // undecryptable ciphertext as if it were the media.
    const ciphertext = Buffer.from("random-ciphertext-bytes-that-are-not-media-0123456789");
    const media = makeMediaClient();
    const deps = baseDeps(media, {
      getEncryptedFile: () => undefined, // MISS for an attachment that WAS encrypted
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({
            buffer: ciphertext,
            mimeType: "application/octet-stream",
            sizeBytes: ciphertext.length,
            resolvedIp: "1.2.3.4",
          }),
        ),
      },
    });
    const resolver = createMatrixResolver(deps);

    const encryptedAttachment: Attachment = { type: "image", url: MXC, encrypted: true };
    const result = await resolver.resolve(encryptedAttachment);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/key unavailable|encrypted/i);
      // The ciphertext is never returned as if it were resolved media.
      expect(result.error.message).not.toContain(ciphertext.toString());
    }
  });

  it("resolves a plaintext attachment (not marked encrypted) on a cache miss as before", async () => {
    // Contrast with the fail-closed case: a genuinely-plaintext attachment carries no
    // encryption indicator, so a cache miss is the normal plaintext path, not a failure.
    const media = makeMediaClient();
    const deps = baseDeps(media, { getEncryptedFile: () => undefined });
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve({ type: "image", url: MXC }); // no `encrypted`

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.buffer.equals(PNG_1X1)).toBe(true);
  });

  it("rejects a resolved body that exceeds the configured byte cap", async () => {
    const oversized = Buffer.alloc(32);
    const media = makeMediaClient();
    const deps = baseDeps(media, {
      maxBytes: 16,
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: oversized, mimeType: "image/png", sizeBytes: oversized.length, resolvedIp: "1.2.3.4" }),
        ),
      },
    });
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve(makeAttachment());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/i);
    }
  });

  it("returns the sniffed MIME type, overriding a mislabeled declared content-type", async () => {
    const media = makeMediaClient();
    const deps = baseDeps(media, {
      ssrfFetcher: {
        // The header lies (octet-stream) but the bytes are a PNG.
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: PNG_1X1, mimeType: "application/octet-stream", sizeBytes: PNG_1X1.length, resolvedIp: "1.2.3.4" }),
        ),
      },
    });
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve(makeAttachment());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("image/png");
    }
  });

  it("returns a clean error without fetching when the mxc cannot be turned into a download URL", async () => {
    const media = makeMediaClient({ mxcUrlToHttp: vi.fn().mockReturnValue(null) });
    const deps = baseDeps(media);
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve(makeAttachment("mxc://bad"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/mxc/i);
    }
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("returns a clean error without fetching when the media client has not started", async () => {
    const deps = baseDeps(undefined); // getMediaClient() → undefined (pre-start)
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve(makeAttachment());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not started|client/i);
    }
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("never places the download URL or the access token in the returned error or any log field", async () => {
    const media = makeMediaClient();
    const deps = baseDeps(media, {
      ssrfFetcher: {
        // The transport error text embeds BOTH the url and the bearer — the classic leak.
        fetch: vi.fn().mockResolvedValue(
          err(new Error(`fetch failed for ${AUTHED_URL} using Bearer ${TOKEN}: HTTP 500`)),
        ),
      },
    });
    const resolver = createMatrixResolver(deps);

    const result = await resolver.resolve(makeAttachment());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(AUTHED_URL);
      expect(result.error.message).not.toContain(TOKEN);
    }

    // The failure branch WARNs with an actionable errorKind + a platform-specific hint.
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "matrix",
        errorKind: "platform",
        hint: expect.stringContaining("Matrix media"),
      }),
      expect.any(String),
    );

    // No warn/debug log call carries the url or the token in any field.
    const allLogArgs = [
      ...vi.mocked(deps.logger.warn).mock.calls,
      ...vi.mocked(deps.logger.debug).mock.calls,
    ]
      .map((call) => JSON.stringify(call))
      .join(" ");
    expect(allLogArgs).not.toContain(AUTHED_URL);
    expect(allLogArgs).not.toContain(TOKEN);
  });
});
