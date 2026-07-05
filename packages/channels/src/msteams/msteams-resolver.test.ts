// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createMsTeamsResolver,
  DEFAULT_MEDIA_AUTH_ALLOW_HOSTS,
  DEFAULT_MEDIA_FETCH_ALLOW_HOSTS,
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

  // -------------------------------------------------------------------------
  // Hop-0 fetch-host allowlist: the INITIAL attachment host must be a known
  // Teams/SharePoint/Bot-Framework/Graph host BEFORE the guarded fetch runs. The
  // fetcher re-validates every hop for SSRF (private/metadata IPs) but does NOT
  // restrict arbitrary PUBLIC hosts, so without this gate an attacker-influenced
  // contentUrl drives a blind GET to any public host (egress-IP disclosure +
  // attacker-influenced bytes into the vision/STT pipeline). Redirects stay
  // unrestricted — only hop 0 is gated.
  // -------------------------------------------------------------------------

  it("exports a DEFAULT_MEDIA_FETCH_ALLOW_HOSTS that is a superset of the auth set (SharePoint/Graph fetch-allowed but token-excluded)", () => {
    // Every token-attach host must also be fetch-allowed.
    for (const h of DEFAULT_MEDIA_AUTH_ALLOW_HOSTS) {
      expect(DEFAULT_MEDIA_FETCH_ALLOW_HOSTS as readonly string[]).toContain(h);
    }
    // SharePoint + Graph download hosts are legitimate hop-0 targets but must NOT
    // be on the narrower token-attach list.
    expect(DEFAULT_MEDIA_FETCH_ALLOW_HOSTS as readonly string[]).toContain(".sharepoint.com");
    expect(DEFAULT_MEDIA_FETCH_ALLOW_HOSTS as readonly string[]).toContain("graph.microsoft.com");
    expect(DEFAULT_MEDIA_AUTH_ALLOW_HOSTS.join(",")).not.toContain("sharepoint");
    expect(DEFAULT_MEDIA_AUTH_ALLOW_HOSTS.join(",")).not.toContain("graph");
  });

  it("rejects an off-allowlist hop-0 fetch host BEFORE any fetch (closes the blind-public-SSRF residual)", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(
      makeAttachment(teamsFileUrl("https://attacker.example.com/collect?x=1")),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/host not permitted/i);
    }
    // The malicious host is dropped before the guarded fetcher is ever invoked.
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
    const validationWarn = vi
      .mocked(deps.logger.warn)
      .mock.calls.map((c) => c[0])
      .find((p) => (p as { errorKind?: string }).errorKind === "validation");
    expect(validationWarn).toBeDefined();
    expect((validationWarn as { hint?: string }).hint).toMatch(/host/i);
  });

  it("rejects a look-alike hop-0 host that only suffix-collides with a Teams host (anchored leading-dot match)", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);

    // `evilbotframework.com` must NOT satisfy `.botframework.com`.
    const result = await resolver.resolve(
      makeAttachment(teamsFileUrl("https://evilbotframework.com/x.png")),
    );

    expect(result.ok).toBe(false);
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("fetches a legitimate smba.trafficmanager.net hop-0 (Bot Framework hosted content)", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(BF_ATTACHMENT_URL)));

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(BF_ATTACHMENT_URL, expect.anything());
  });

  it("fetches a legitimate *.sharepoint.com hop-0 (the pre-authed downloadUrl entry point; the 302→blob hop is followed inside the fetcher)", async () => {
    const deps = mockDeps();
    const resolver = createMsTeamsResolver(deps);
    const spUrl =
      "https://contoso.sharepoint.com/sites/s/_layouts/15/download.aspx?SourceUrl=/a.png";

    const result = await resolver.resolve(makeAttachment(teamsFileUrl(spUrl)));

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(spUrl, expect.anything());
  });

  it("fetches a hop-0 host that is only on the operator-configured auth allowlist (self-hosted Connector)", async () => {
    // A host trusted enough to receive the bearer (configured mediaAuthAllowHosts)
    // is trusted enough to fetch from, so the fetch gate unions it in.
    const deps = mockDeps({ mediaAuthAllowHosts: ["private-connector.example.com"] });
    const resolver = createMsTeamsResolver(deps);

    const result = await resolver.resolve(
      makeAttachment(teamsFileUrl("https://private-connector.example.com/v3/attachments/x")),
    );

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalled();
  });
});
