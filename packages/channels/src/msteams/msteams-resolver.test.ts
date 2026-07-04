// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createMsTeamsResolver,
  DEFAULT_MEDIA_AUTH_ALLOW_HOSTS,
  type MsTeamsResolverDeps,
} from "./msteams-resolver.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real 1×1 PNG (magic bytes recognized by file-type), used to prove MIME sniff. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A representative Bot Framework hosted-content attachment URL. */
const BF_ATTACHMENT_URL =
  "https://smba.trafficmanager.net/amer/v3/attachments/att-id/views/original";

function mockDeps(overrides: Partial<MsTeamsResolverDeps> = {}): MsTeamsResolverDeps {
  return {
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({
          buffer: Buffer.from("teams-media"),
          mimeType: "image/png",
          sizeBytes: 11,
          resolvedIp: "1.2.3.4",
        }),
      ),
    },
    getToken: vi.fn().mockResolvedValue(ok("TOKEN")),
    mediaAuthAllowHosts: [],
    maxBytes: 10 * 1024 * 1024,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function makeAttachment(url: string): Attachment {
  return { type: "image", url };
}

/** Wrap a real URL exactly as the message mapper does — proves decode is the inverse of encode. */
function teamsFileUrl(realUrl: string): string {
  return `msteams-file://${encodeURIComponent(realUrl)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("msteams-resolver / createMsTeamsResolver", () => {
  it("declares schemes = ['msteams-file'] and never claims the https scheme", () => {
    const resolver = createMsTeamsResolver(mockDeps());
    expect(resolver.schemes).toEqual(["msteams-file"]);
    expect(resolver.schemes).not.toContain("https");
  });

  it("exports a tight DEFAULT_MEDIA_AUTH_ALLOW_HOSTS with Bot Framework hosts only (SharePoint + Graph excluded)", () => {
    expect(DEFAULT_MEDIA_AUTH_ALLOW_HOSTS).toEqual([
      "smba.trafficmanager.net",
      ".botframework.com",
    ]);
    const joined = DEFAULT_MEDIA_AUTH_ALLOW_HOSTS.join(",");
    expect(joined).not.toContain("sharepoint");
    expect(joined).not.toContain("graph.microsoft.com");
  });

  it("decodes the msteams-file URL and fetches via the injected guarded fetcher with the Connector Bearer + DEFAULT allowlist", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(Buffer.from("teams-media"));
      expect(result.value.mimeType).toBe("image/png");
      expect(result.value.sizeBytes).toBe(11);
    }

    // The DECODED https URL reaches the guarded fetcher (not the raw msteams-file:// scheme),
    // with the Bearer + the DEFAULT allowlist applied (config mediaAuthAllowHosts is empty).
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      BF_ATTACHMENT_URL,
      expect.objectContaining({
        authHeader: "Bearer TOKEN",
        authAllowHosts: DEFAULT_MEDIA_AUTH_ALLOW_HOSTS,
      }),
    );
  });

  it("round-trips a downloadUrl carrying reserved characters — decode is the exact inverse of the mapper encode", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);
    // A pre-authed SharePoint downloadUrl with spaces, '?', '&', ':', '/', '=' in the query.
    const realUrl =
      "https://contoso.sharepoint.com/sites/s/_layouts/15/download.aspx?SourceUrl=/sites/s/Shared Documents/a b.png&e=1:2/3&y";

    await resolver.resolve(makeAttachment(teamsFileUrl(realUrl)));

    const firstArg = (deps.ssrfFetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstArg).toBe(realUrl);
  });

  it("passes a non-empty config mediaAuthAllowHosts through verbatim rather than the default", async () => {
    const custom = ["private-connector.example.com"] as const;
    const deps = mockDeps({ mediaAuthAllowHosts: custom });
    const resolver = createMsTeamsResolver(deps);

    await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      BF_ATTACHMENT_URL,
      expect.objectContaining({ authAllowHosts: custom }),
    );
  });

  it("returns the sniffed MIME type, overriding a mislabeled declared content-type", async () => {
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: PNG_1X1, mimeType: "image/jpeg", sizeBytes: PNG_1X1.length, resolvedIp: "1.2.3.4" }),
        ),
      },
    });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sniffed image/png wins over the fetcher's declared image/jpeg.
      expect(result.value.mimeType).toBe("image/png");
    }
  });

  it("returns raw fetched bytes and does NOT wrap them in an external-content fence (the pipeline fences derived text)", async () => {
    const raw = Buffer.from("plain external bytes that must not be fenced by the resolver");
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: raw, mimeType: "application/octet-stream", sizeBytes: raw.length, resolvedIp: "1.2.3.4" }),
        ),
      },
    });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Byte-identical: no delimiter/envelope added around the media bytes.
      expect(result.value.buffer.equals(raw)).toBe(true);
      expect(result.value.buffer.toString("utf8")).toBe(
        "plain external bytes that must not be fenced by the resolver",
      );
    }
  });

  it("still fetches with no auth header when the Connector token mint fails (a pre-authed downloadUrl needs none)", async () => {
    const deps = mockDeps({
      getToken: vi.fn().mockResolvedValue(err(new Error("token mint failed"))),
    });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      BF_ATTACHMENT_URL,
      expect.objectContaining({ authHeader: undefined }),
    );
  });

  it("enforces the configured maxBytes size cap and rejects an over-limit body", async () => {
    const deps = mockDeps({
      maxBytes: 10 * 1024 * 1024,
      ssrfFetcher: {
        // sizeBytes over the cap even though the buffer sample is small (server under-declares body).
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: Buffer.alloc(8), mimeType: "image/png", sizeBytes: 20 * 1024 * 1024, resolvedIp: "1.2.3.4" }),
        ),
      },
    });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }
  });

  it("returns err and emits a WARN with hint + errorKind when the guarded fetch fails", async () => {
    const deps = mockDeps({
      ssrfFetcher: { fetch: vi.fn().mockResolvedValue(err(new Error("SSRF blocked"))) },
    });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "msteams",
        errorKind: "platform",
        hint: expect.stringContaining("Teams media fetch failed"),
      }),
      "Teams media fetch failed",
    );
  });

  it("never places the decoded URL or the Connector token in a log field or the returned error", async () => {
    const realUrl =
      "https://smba.trafficmanager.net/amer/v3/attachments/SECRET-ATT-ID/views/original";
    const token = "connector-bearer-SUPERSECRET-value";
    const deps = mockDeps({
      getToken: vi.fn().mockResolvedValue(ok(token)),
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          err(new Error(`fetch failed for ${realUrl} using Bearer ${token}: HTTP 500`)),
        ),
      },
    });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(realUrl)));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(realUrl);
      expect(result.error.message).not.toContain(token);
    }

    // No warn/debug log call carries the decoded URL or the token in any field.
    const allLogArgs = [
      ...vi.mocked(deps.logger.warn).mock.calls,
      ...vi.mocked(deps.logger.debug).mock.calls,
    ]
      .map((call) => JSON.stringify(call))
      .join(" ");
    expect(allLogArgs).not.toContain(realUrl);
    expect(allLogArgs).not.toContain(token);
  });

  it("returns err without fetching when the msteams-file payload is not valid percent-encoding", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment("msteams-file://%zz"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/malformed|Invalid/i);
    }
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });
});
