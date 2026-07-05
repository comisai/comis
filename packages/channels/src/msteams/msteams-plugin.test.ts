// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { Attachment, ComisLogger } from "@comis/core";
import { createMsTeamsPlugin } from "./msteams-plugin.js";
import type { MsTeamsAdapterDeps } from "./msteams-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

/**
 * A fetchImpl that mints a Connector token so getConnectorToken() resolves ok —
 * proving createResolver closes over the adapter's token getter (the Bearer that
 * rides the inbound media fetch).
 */
function makeTokenFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "TEST_CONNECTOR_TOKEN", expires_in: 3600 }),
  })) as unknown as typeof fetch;
}

function makeDeps(overrides: Partial<MsTeamsAdapterDeps> = {}): MsTeamsAdapterDeps {
  return {
    appId: "11111111-1111-1111-1111-111111111111",
    appPassword: "secret",
    tenantId: "22222222-2222-2222-2222-222222222222",
    allowFrom: [],
    allowMode: "allowlist",
    logger: makeLogger(),
    fetchImpl: makeTokenFetch(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMsTeamsPlugin", () => {
  it("declares attachments:true with sendAttachment present (capability parity)", () => {
    const plugin = createMsTeamsPlugin(makeDeps());

    // The advertised capability must be backed by the method: the daemon's
    // capability gate (requireMethod) throws when caps say yes but the adapter
    // omits sendAttachment. The flip and the method ship together.
    expect(plugin.capabilities.features.attachments).toBe(true);
    expect(
      typeof (plugin.adapter as { sendAttachment?: unknown }).sendAttachment,
    ).toBe("function");
  });

  it("createResolver returns the msteams-file media resolver", () => {
    const plugin = createMsTeamsPlugin(makeDeps());

    const resolver = plugin.createResolver({
      ssrfFetcher: { fetch: vi.fn() },
      maxBytes: 10_000_000,
      logger: makeLogger(),
      mediaAuthAllowHosts: [],
    });

    expect(resolver.schemes).toContain("msteams-file");
  });

  it("createResolver closes over getConnectorToken + the injected fetcher", async () => {
    // The injected fetcher records how the resolver drives it.
    const fetch = vi.fn(async () =>
      ok({ buffer: Buffer.from("img"), mimeType: "image/png", sizeBytes: 3 }),
    );
    const plugin = createMsTeamsPlugin(makeDeps());

    const resolver = plugin.createResolver({
      ssrfFetcher: { fetch },
      maxBytes: 10_000_000,
      logger: makeLogger(),
      mediaAuthAllowHosts: ["example.invalid"],
    });

    const realUrl = "https://smba.trafficmanager.net/amer/v3/attachments/1";
    await resolver.resolve({
      url: `msteams-file://${encodeURIComponent(realUrl)}`,
      type: "image",
    } as Attachment);

    // The SAME injected fetcher is driven with the DECODED url, the Bearer minted
    // via the adapter's getConnectorToken, and the config allowlist this resolver
    // was handed — never a bare fetch.
    expect(fetch).toHaveBeenCalledWith(realUrl, {
      authHeader: "Bearer TEST_CONNECTOR_TOKEN",
      authAllowHosts: ["example.invalid"],
    });
  });
});
