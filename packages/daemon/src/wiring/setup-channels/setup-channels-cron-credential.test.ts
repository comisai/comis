// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for background-job credential resolution (LEARN-01, live VPS 2026-06-19).
 *
 * The bug: an OAuth provider (openai-codex) resolved no API key and no keyless
 * sentinel → the job skipped, disabling the whole learning/memory layer. These
 * pin the OAuth branch + the byte-identical static/keyless paths.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveCronJobCredential,
  cronCredentialSkipHint,
} from "./setup-channels-cron-credential.js";
import type { AppContainer } from "@comis/core";

function makeContainer(opts: {
  secrets?: Record<string, string>;
  oauthProfiles?: Record<string, string>;
  apiKeyName?: string;
  entries?: Record<string, unknown>;
}): AppContainer {
  return {
    secretManager: { get: (k: string) => opts.secrets?.[k] },
    config: {
      providers: opts.entries
        ? { entries: opts.entries }
        : opts.apiKeyName
          ? { entries: { "some-provider": { apiKeyName: opts.apiKeyName } } }
          : undefined,
      agents: { default: { oauthProfiles: opts.oauthProfiles } },
    },
  } as unknown as AppContainer;
}

describe("resolveCronJobCredential", () => {
  it("LEARN-01: resolves the OAuth access token for an openai-codex agent (was skipped)", async () => {
    const container = makeContainer({
      secrets: {}, // no static API key (OAuth provider)
      oauthProfiles: { "openai-codex": "openai-codex:user@example.com" },
    });
    const resolver = vi.fn(async () => "oauth-access-token-xyz");

    const cred = await resolveCronJobCredential(container, "default", "openai-codex", resolver);

    expect(cred.source).toBe("oauth");
    expect(cred.apiKey).toBe("oauth-access-token-xyz"); // pi-ai uses this as the bearer
    expect(cred.hasOAuthProfile).toBe(true);
    expect(resolver).toHaveBeenCalledWith("default", "openai-codex");
  });

  it("PRE-FIX shape: no resolver → openai-codex yields no credential (the skip)", async () => {
    const container = makeContainer({
      secrets: {},
      oauthProfiles: { "openai-codex": "openai-codex:user@example.com" },
    });
    // No resolveAccessToken (the old behavior) → still empty → job would skip.
    const cred = await resolveCronJobCredential(container, "default", "openai-codex");
    expect(cred.apiKey).toBe("");
    expect(cred.source).toBe("none");
  });

  it("static API key path is unchanged (byte-identical for keyed providers)", async () => {
    const container = makeContainer({
      secrets: { ANTHROPIC_API_KEY: "sk-ant-123" },
    });
    const cred = await resolveCronJobCredential(container, "default", "anthropic");
    expect(cred.source).toBe("secret");
    expect(cred.apiKey).toBe("sk-ant-123");
  });

  it("keyless providers still get the sentinel (no OAuth needed)", async () => {
    const container = makeContainer({ secrets: {} });
    const cred = await resolveCronJobCredential(container, "default", "ollama");
    expect(cred.source).toBe("keyless");
    expect(cred.apiKey).toBeTruthy();
  });

  it("KEYLESS-CUSTOM-NAME: a custom-NAMED keyless entry (type: ollama) gets the sentinel by TYPE, not name", async () => {
    // package-delivery-20260628 (local qwen3.6:35b): the keyless check keyed off the provider NAME,
    // but KEYLESS_PROVIDER_TYPES holds TYPEs ("ollama"). A user-named ollama entry
    // (providers.entries["local-ollama"] = { type: "ollama" }) failed the check, so the
    // reflection/memory-review crons SKIPPED ("Skipping reflection -- no API key") on a local keyless
    // daemon — blocking the learning loop. The completion path keys off entry.type, so this gate must too.
    const container = makeContainer({
      secrets: {},
      entries: { "local-ollama": { type: "ollama", baseUrl: "http://localhost:11434" } },
    });
    const cred = await resolveCronJobCredential(container, "default", "local-ollama");
    expect(cred.source).toBe("keyless"); // PRE-FIX: "none" (apiKey "") → the silent skip
    expect(cred.apiKey).toBeTruthy();
  });

  it("a custom-NAMED non-keyless entry (type: anthropic) without a key still skips honestly (no over-broadening)", async () => {
    const container = makeContainer({
      secrets: {},
      entries: { "my-anthropic": { type: "anthropic" } },
    });
    const cred = await resolveCronJobCredential(container, "default", "my-anthropic");
    expect(cred.source).toBe("none");
    expect(cred.apiKey).toBe("");
  });

  it("OAuth resolver returning undefined (expired/no creds) → no credential, honest", async () => {
    const container = makeContainer({
      secrets: {},
      oauthProfiles: { "openai-codex": "openai-codex:user@example.com" },
    });
    const cred = await resolveCronJobCredential(container, "default", "openai-codex", async () => undefined);
    expect(cred.apiKey).toBe("");
    expect(cred.source).toBe("none");
    expect(cred.hasOAuthProfile).toBe(true);
  });
});

describe("cronCredentialSkipHint", () => {
  it("names the OAuth re-login knob for an OAuth provider, NOT a misleading API key", () => {
    const hint = cronCredentialSkipHint(
      { apiKey: "", apiKeyName: "OPENAI-CODEX_API_KEY", source: "none", hasOAuthProfile: true },
      "openai-codex",
      "skill synthesis",
    );
    expect(hint).toMatch(/comis auth login --provider openai-codex/);
    expect(hint).not.toMatch(/Set OPENAI-CODEX_API_KEY/);
  });

  it("names the API key knob for a non-OAuth provider", () => {
    const hint = cronCredentialSkipHint(
      { apiKey: "", apiKeyName: "ANTHROPIC_API_KEY", source: "none", hasOAuthProfile: false },
      "anthropic",
      "skill synthesis",
    );
    expect(hint).toMatch(/Set ANTHROPIC_API_KEY/);
  });
});
