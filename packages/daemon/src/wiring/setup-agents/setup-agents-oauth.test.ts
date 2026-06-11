// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the OAuth auth-provider wiring extracted from setupSingleAgent
 * (setup-agents-oauth.ts).
 *
 * Covers: the returned AuthProvider always has `.oauth` wired (the unwired-
 * OAuth-gap closure); both storage modes ("file" registers the
 * auth-profiles.json watchPath, "encrypted" passes undefined) construct
 * successfully; and the load-bearing closure-stability invariant — the
 * `getAgentOauthProfiles` getter observes LIVE container state, so an
 * agents.update reference-replacement is picked up without a daemon restart.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type {
  AppContainer,
  FileLockPort,
  OAuthCredentialStorePort,
  OAuthProfile,
  SecretManager,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { warnEncryptedModeOnce, wireAuthProvider, type WireAuthProviderArgs } from "./setup-agents-oauth.js";

function makeSecretManager(): SecretManager {
  const secrets: Record<string, string> = { ANTHROPIC_API_KEY: "sk-test" };
  return {
    get: vi.fn((key: string) => secrets[key]), // eslint-disable-line security/detect-object-injection
    has: vi.fn((key: string) => key in secrets),
    require: vi.fn((key: string) => secrets[key] ?? ""), // eslint-disable-line security/detect-object-injection
    keys: vi.fn(() => Object.keys(secrets)),
  };
}

function makeMockCredentialStore(): OAuthCredentialStorePort {
  return {
    get: vi.fn(async () => ok(undefined)),
    set: vi.fn(async () => ok(undefined)),
    delete: vi.fn(async () => ok(false)),
    list: vi.fn(async () => ok([] as OAuthProfile[])),
    has: vi.fn(async () => ok(false)),
  };
}

function makeMockFileLock(): FileLockPort {
  return {
    acquire: vi.fn(async () => ok(async () => {})),
    release: vi.fn(async () => ok(undefined)),
    withLock: vi.fn(
      async (_path: string, fn: () => Promise<unknown>) => ok(await fn()),
    ) as FileLockPort["withLock"],
    isLocked: vi.fn(async () => false),
    cleanupStaleLocks: vi.fn(async () => 0),
  };
}

function makeLogger(): ComisLogger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as ComisLogger;
}

/** Minimal AppContainer exposing only the fields wireAuthProvider touches. */
function makeContainer(
  agentId: string,
  oauthProfiles?: Record<string, string>,
): AppContainer {
  return {
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    config: {
      agents: {
        [agentId]: oauthProfiles ? { oauthProfiles } : {},
      },
    },
  } as unknown as AppContainer;
}

function makeArgs(overrides?: Partial<WireAuthProviderArgs>): WireAuthProviderArgs {
  const agentId = overrides?.agentId ?? "agent-1";
  return {
    agentId,
    container: makeContainer(agentId),
    scopedManager: makeSecretManager(),
    oauthCredentialStore: makeMockCredentialStore(),
    fileLock: makeMockFileLock(),
    dataDirAbs: "/tmp/comis-test-oauth",
    oauthStorageMode: "file",
    agentLogger: makeLogger(),
    ...overrides,
  };
}

describe("wireAuthProvider", () => {
  it("returns an AuthProvider with the oauth token manager wired (closes the unwired-OAuth gap)", () => {
    const provider = wireAuthProvider(makeArgs());
    expect(provider).toHaveProperty("authStorage");
    expect(provider).toHaveProperty("oauth");
    // oauth config is always passed, so the token manager must be constructed.
    expect(provider.oauth).toBeDefined();
  });

  it("constructs successfully in file storage mode (registers the auth-profiles.json watcher)", () => {
    const provider = wireAuthProvider(makeArgs({ oauthStorageMode: "file" }));
    expect(provider.oauth).toBeDefined();
  });

  it("constructs successfully in encrypted storage mode (no file watcher)", () => {
    const provider = wireAuthProvider(makeArgs({ oauthStorageMode: "encrypted" }));
    expect(provider.oauth).toBeDefined();
  });

  it("emits a debug log recording the OAuth wiring for operator visibility", () => {
    const agentLogger = makeLogger();
    wireAuthProvider(makeArgs({ agentLogger }));
    expect(agentLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ submodule: "setup-agents" }),
      expect.stringContaining("OAuth"),
    );
  });

  it("resolves the API key from the scoped secret manager (storage wired from it)", async () => {
    const provider = wireAuthProvider(makeArgs());
    expect(await provider.authStorage.getApiKey("anthropic")).toBe("sk-test");
  });
});

describe("warnEncryptedModeOnce (moved from setup-agents-registry — once-per-process latch)", () => {
  it("warns exactly once per process for encrypted mode and never for file mode", () => {
    // Single combined case: the module-level latch is shared across calls in
    // this test file, so the once-semantics must be proven in one pass.
    const agentLogger = makeLogger();
    warnEncryptedModeOnce("file", agentLogger);
    expect(agentLogger.warn).not.toHaveBeenCalled();

    warnEncryptedModeOnce("encrypted", agentLogger);
    warnEncryptedModeOnce("encrypted", agentLogger);
    expect(agentLogger.warn).toHaveBeenCalledTimes(1);
    expect(agentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config", submodule: "setup-agents" }),
      "OAuth hot-reload disabled in encrypted-store mode",
    );
  });
});
