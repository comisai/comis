// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger, PluginRegistryApi } from "@comis/core";
import { generateKeyPair, exportPKCS8 } from "jose";
import { createGoogleChatPlugin } from "./googlechat-plugin.js";
import type { GoogleChatAdapterDeps } from "./googlechat-adapter.js";
import type { PubSubSource } from "./pubsub-source.js";

const SA_EMAIL = "comis-bot@my-project.iam.gserviceaccount.com";
const MINTED_TOKEN = "ya29.minted-access-token-xyz";
const SUBSCRIPTION = "projects/my-project/subscriptions/comis-sub";
const NOW = 1_000_000;

/** A silent logger — the plugin surface under test emits nothing on the happy path. */
function makeLogger(): ComisLogger {
  const noop = vi.fn();
  return {
    level: "debug",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
}

/**
 * A real RS256 service-account key JSON an operator would supply — the mint and
 * the credential validator parse it for `client_email` + `private_key`, so
 * start() (and therefore activate()) succeeds.
 */
async function makeServiceAccountKey(clientEmail = SA_EMAIL) {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  return JSON.stringify({
    type: "service_account",
    client_email: clientEmail,
    private_key: privateKeyPem,
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

/** A fetch stub returning a successful token exchange so no network is touched. */
function makeTokenFetch(token = MINTED_TOKEN) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: 3600 }),
  })) as unknown as typeof fetch;
}

/** A fake pull-loop source recording start/stop so lifecycle is testable loop-free. */
function makeFakeSource(over: Partial<PubSubSource> = {}) {
  const start = vi.fn();
  const stop = vi.fn(async () => {});
  const pollOnce = vi.fn(async () => ({
    receivedCount: 0,
    ackedCount: 0,
    skippedCount: 0,
    pullFailed: false,
  }));
  const source: PubSubSource = {
    start,
    stop,
    pollOnce,
    lastError: undefined,
    running: false,
    ...over,
  };
  return { source, start, stop };
}

/** Build plugin/adapter deps with an injected logger, SA key, token fetch, and a fake source. */
async function makeDeps(overrides: Partial<GoogleChatAdapterDeps> = {}) {
  const serviceAccountKey = await makeServiceAccountKey();
  const fake = makeFakeSource();
  const deps: GoogleChatAdapterDeps = {
    serviceAccountKey,
    subscriptionName: SUBSCRIPTION,
    allowFrom: [],
    allowMode: "allowlist",
    logger: makeLogger(),
    fetchImpl: makeTokenFetch(),
    now: () => NOW,
    createSource: () => fake.source,
    ...overrides,
  };
  return { deps, fake };
}

describe("createGoogleChatPlugin — identity + adapter wrap", () => {
  it("wraps the adapter as a ChannelPluginPort with the googlechat identity", async () => {
    const { deps } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);

    expect(plugin.id).toBe("channel-googlechat");
    expect(plugin.name).toBe("Google Chat Channel Plugin");
    expect(plugin.channelType).toBe("googlechat");
    expect(plugin.adapter.channelType).toBe("googlechat");
    // The wrapped adapter is a real googlechat adapter handle (it carries the
    // pull-loop dispatch createGoogleChatAdapter exposes).
    expect(
      typeof (plugin.adapter as { handleChatEvent?: unknown }).handleChatEvent,
    ).toBe("function");
  });

  it("register(api) returns ok(undefined)", async () => {
    const { deps } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);

    const result = plugin.register({} as unknown as PluginRegistryApi);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe("createGoogleChatPlugin — honest text-only interim CAPABILITIES", () => {
  it("declares the exact text-only feature matrix (deep-equal)", async () => {
    const { deps } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);

    // Deep-equal on the DECLARED literal (not a schema-parsed shape): every
    // optional feature is off and there is no button surface.
    expect(plugin.capabilities.features).toEqual({
      reactions: false,
      editMessages: false,
      deleteMessages: false,
      fetchHistory: false,
      attachments: false,
      typing: false,
      threads: false,
      buttons: "none",
    });
  });

  it("bounds outbound at maxMessageChars 4000 and pins replyToMetaKey", async () => {
    const { deps } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);

    expect(plugin.capabilities.limits.maxMessageChars).toBe(4000);
    expect(plugin.capabilities.replyToMetaKey).toBe("googlechatMessageName");
  });
});

describe("createGoogleChatPlugin — capability parity (every false flag omits its method)", () => {
  it("OMITS the adapter method behind every false/none capability flag", async () => {
    const { deps } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);
    const adapter = plugin.adapter as Record<string, unknown>;

    // For a text-only app these capabilities are advertised false AND their
    // adapter methods are omitted, so the daemon capability gate (requireMethod)
    // blocks the call rather than reaching an unimplemented path. editMessage now
    // ships as a function with editMessages still false: method-present/flag-false
    // is gate-safe (assertCapability blocks the false-flag RPC before requireMethod
    // is reached), so it is not listed here.
    const omittedForFalseFlag: Record<string, string> = {
      deleteMessage: "deleteMessages:false",
      reactToMessage: "reactions:false",
      removeReaction: "reactions:false",
      onReaction: "reactions:false",
      fetchMessages: "fetchHistory:false",
      sendAttachment: "attachments:false",
    };
    for (const method of Object.keys(omittedForFalseFlag)) {
      expect(typeof adapter[method]).toBe("undefined");
    }
  });
});

describe("createGoogleChatPlugin — lifecycle delegation", () => {
  it("activate() delegates to adapter.start() (opens the pull-loop source)", async () => {
    const { deps, fake } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);

    const result = await plugin.activate();

    expect(result.ok).toBe(true);
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("deactivate() delegates to adapter.stop() (stops the source)", async () => {
    const { deps, fake } = await makeDeps();
    const plugin = createGoogleChatPlugin(deps);
    await plugin.activate();

    const result = await plugin.deactivate();

    expect(result.ok).toBe(true);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});
