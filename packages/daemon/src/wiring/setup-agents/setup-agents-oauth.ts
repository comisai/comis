// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-side OAuth auth-provider wiring for a single agent runtime.
 *
 * Extracted from {@link setupSingleAgent} (setup-agents-runtime.ts) to keep
 * that file under the per-subdirectory size cap. Pure mechanical move — the
 * behavior (and its load-bearing closure-stability comment) is unchanged.
 *
 * Closes the unwired-OAuth gap — the `createAuthProvider` symbol was exported
 * by `@comis/agent` but never called by the daemon, so refreshed OAuth tokens
 * lived only in the in-memory cache and silently disappeared on restart.
 * `AuthProviderConfig.oauth` credentialStore + logger + dataDir are REQUIRED so
 * this wiring is type-checked at compile time — future regressions surface as
 * TS errors, not silent runtime failures.
 *
 * @module
 */

import { createAuthProvider, type AuthProvider, type AuthProviderConfig } from "@comis/agent";
import { safePath, type AppContainer, type CredentialStorageMode, type FileLockPort, type OAuthCredentialStorePort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** Inputs for {@link wireAuthProvider} — exactly the locals the OAuth block needs. */
export interface WireAuthProviderArgs {
  /** Agent being (re)built; keys the live oauthProfiles dereference. */
  agentId: string;
  /** Per-process daemon container (holds config.agents map + eventBus). */
  container: AppContainer;
  /** Agent-scoped secret manager for resolving API key values. */
  scopedManager: AuthProviderConfig["secretManager"];
  /** Daemon-level OAuth credential store handle (constructed once, threaded in). */
  oauthCredentialStore: OAuthCredentialStorePort;
  /** Canonical proper-lockfile FileLockPort instance (shared with the session adapter). */
  fileLock: FileLockPort;
  /** Resolved absolute data dir (defaults to ~/.comis upstream). */
  dataDirAbs: string;
  /** OAuth storage mode ("file" enables the auth-profiles.json watcher; "env"/"encrypted" → no watcher). */
  oauthStorageMode: CredentialStorageMode;
  /** Agent-scoped logger. */
  agentLogger: ComisLogger;
}

/**
 * Construct the per-agent OAuth-aware {@link AuthProvider}.
 *
 * All path constructions use `safePath` from `@comis/core` (NOT `path.join` —
 * required by the ESLint security rule). When storage === "encrypted", the
 * OAuth profile adapter SHARES the existing secretsDb handle (no dual-handle).
 */
export function wireAuthProvider(args: WireAuthProviderArgs): AuthProvider {
  const {
    agentId,
    container,
    scopedManager,
    oauthCredentialStore,
    fileLock,
    dataDirAbs,
    oauthStorageMode,
    agentLogger,
  } = args;

  const authProvider = createAuthProvider({
    secretManager: scopedManager,
    additionalProviderKeys: undefined,
    oauth: {
      eventBus: container.eventBus,
      credentialStore: oauthCredentialStore,
      logger: agentLogger.child({ submodule: "oauth-token-manager" }),
      dataDir: dataDirAbs,
      // Same canonical FileLockPort instance the OAuth credential store
      // was constructed with — both the file adapter and the token manager
      // need cross-process serialization on the same .locks/ directory.
      fileLock,
      keyPrefix: "OAUTH_",
      // Pass auth-profiles.json path when file adapter active so
      // OAuthTokenManager can register the chokidar watcher and pick up
      // CLI-written profiles within ~250ms without a daemon restart.
      // Encrypted-mode: undefined -> no watcher; documented limitation.
      watchPath:
        oauthStorageMode === "file"
          ? safePath(dataDirAbs, "auth-profiles.json")
          : undefined,
      // Closure-stability: the closure dereferences
      // container.config.agents[agentId]?.oauthProfiles on every call.
      // This is the only correct shape because:
      //   1. The `container.config.agents[agentId] = effectiveConfig`
      //      writeback in setupSingleAgent stores a NEW object built from
      //      { ...agentConfig, model, provider } into the daemon's map.
      //      The local `agentConfig` parameter diverges from the map
      //      immediately at startup — capturing it would observe the
      //      wrong value.
      //   2. agents.update at agent-handlers.ts:341 executes
      //      `deps.agents[agentId] = parsedConfig`, REPLACING the
      //      reference at that key with a new validated object. Capturing
      //      the local agentConfig parameter would miss this hot-update.
      //   3. daemon.ts confirms `deps.agents` and `container.config.agents`
      //      are THE SAME map object — search for
      //      `agents: container.config.agents` in the RpcDispatchDeps
      //      construction. The daemon holds a single per-process
      //      Container.config instance.
      // The map identity is stable; only the value at the agent key
      // changes. The closure-evaluated dereference observes (1) at
      // startup AND (2) on every agents.update without an event-bus
      // invalidation or daemon restart, allowing the agents_manage tool to
      // update without a daemon restart.
      getAgentOauthProfiles: () =>
        container.config.agents?.[agentId]?.oauthProfiles,
    },
  });

  // Encrypted-mode cache-invalidation subscription: auth:profile_added fires
  // from auth-handlers.ts auth.set after a CLI `comis auth login` writes a
  // new OAuth profile via daemon RPC. The file-mode chokidar watcher already
  // handles this for file mode (no change to that path). Encrypted mode has
  // no watcher (watchPath: undefined above), so we subscribe here instead.
  if (oauthStorageMode === "encrypted") {
    container.eventBus.on("auth:profile_added", () => {
      authProvider.oauth?.invalidate();
    });
  }

  agentLogger.debug(
    {
      agentId,
      oauthStorage: oauthStorageMode,
      dataDir: dataDirAbs,
      submodule: "setup-agents",
    },
    "OAuth credential store + auth provider + per-LLM-call dispatch wired",
  );

  return authProvider;
}
