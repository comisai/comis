// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import os from "node:os";
import path from "node:path";
import type { AppConfig, ConfigError } from "./config/types.js";
import type { SecretManager } from "./security/index.js";
import type { PluginRegistry } from "./hooks/plugin-registry.js";
import type { HookRunner } from "./hooks/hook-runner.js";
import type { WorkspacePolicyPort } from "./ports/workspace-policy.js";
import type { PrincipalResolverPort } from "./ports/principal-resolver.js";
import { loadLayered } from "./config/layered.js";
import { buildGatewayEnvLayer } from "./config/env-layer.js";
import { TypedEventBus } from "./event-bus/index.js";
import { createSecretManager, safePath } from "./security/index.js";
import { createPluginRegistry } from "./hooks/plugin-registry.js";
import { createHookRunner } from "./hooks/hook-runner.js";
import { createPrincipalResolver } from "./domain/principal-resolver.js";

/** Default base directory: ~/.comis */
const DEFAULT_DATA_DIR = safePath(os.homedir(), ".comis");

/**
 * Name of the 32-byte HMAC secret backing every signed channel callback
 * (interactive approvals). It is generated/read at the daemon
 * composition root (via SecretStorePort, with an in-memory fallback when the
 * encrypted store is disabled) and is added unconditionally to
 * `platformSecretNames` so user-facing secret-ref tools can never resolve it.
 * NOT a config `${VAR}` reference — a platform-managed secret.
 */
export const INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME =
  "activity.interactiveCallbackSigningSecret";

/**
 * Resolve runtime paths in config.
 * - dataDir precedence: explicit config.dataDir > env COMIS_DATA_DIR > ~/.comis
 *   (matches the daemon boot resolution at daemon.ts and the CLI). The env
 *   var MUST be honored here: ignoring it splits the system in two — boot
 *   paths (.env, secrets.db, the data-dir singleton lock) would honor
 *   COMIS_DATA_DIR while config-derived paths (memory.dbPath, workspace,
 *   sessions) silently landed in the real ~/.comis (e.g. an isolated test
 *   daemon opening ~/.comis/test-memory-default.db despite COMIS_DATA_DIR
 *   pointing at a temp dir).
 * - memory.dbPath resolves relative to dataDir if not absolute
 */
export function resolveConfigRuntimePaths(
  config: AppConfig,
  env: Record<string, string | undefined>,
  defaultDataDir: string = DEFAULT_DATA_DIR,
): AppConfig {
  const dataDir = config.dataDir || env["COMIS_DATA_DIR"] || defaultDataDir;
  const dbPath = path.isAbsolute(config.memory.dbPath)
    ? config.memory.dbPath
    : safePath(dataDir, config.memory.dbPath);
  return {
    ...config,
    dataDir,
    memory: { ...config.memory, dbPath },
  };
}

/**
 * Options for bootstrapping the application container.
 */
export interface BootstrapOptions {
  /** Config file paths in layer priority order (later overrides earlier) */
  configPaths: string[];
  /** Environment variables to seed the SecretManager (required — no process.env fallback). */
  env: Record<string, string | undefined>;
  /**
   * Pre-constructed SecretManager to use instead of calling createSecretManager(env).
   * The daemon composition root injects the shared-backing-map manager so the mutable
   * handle and AppContainer.secretManager share one Map. Non-daemon callers omit this.
   */
  secretManager?: SecretManager;
  /** Runtime adapter factory supplied by the outer daemon composition root. */
  workspacePolicyPortFactory?: (config: AppConfig) => WorkspacePolicyPort;
}

/**
 * The application dependency container.
 *
 * Created by bootstrap(), this wires all services together
 * and provides a single shutdown() method for graceful cleanup.
 */
export interface AppContainer {
  /** Current application configuration */
  readonly config: AppConfig;
  /** Typed inter-module event bus */
  readonly eventBus: TypedEventBus;
  /** Centralized credential access */
  readonly secretManager: SecretManager;
  /**
   * Names of secrets used by the daemon config, including `${VAR}`
   * substitutions and provider `apiKeyName` references. These are
   * platform-managed — the exec tool's `secretRefs` parameter refuses them so
   * agents cannot exfiltrate credentials the daemon uses. User-task secrets
   * not in this set can still flow through the secret-ref boundary.
   */
  readonly platformSecretNames: ReadonlySet<string>;
  /** Plugin registration and hook storage */
  readonly pluginRegistry: PluginRegistry;
  /** Lifecycle hook execution engine */
  readonly hookRunner: HookRunner;
  /** Pure operator-configured platform-principal resolver used at ingress. */
  readonly principalResolver: PrincipalResolverPort;
  /** Immutable per-turn operator-policy loader, when the runtime supplies its filesystem adapter. */
  readonly workspacePolicyPort?: WorkspacePolicyPort;
  /** Graceful shutdown — cleans up resources */
  shutdown: () => Promise<void>;
}

/**
 * Bootstrap the application container.
 *
 * Composition root that:
 * 1. Creates a SecretManager from environment variables
 * 2. Loads layered config from file paths
 * 3. Creates the typed event bus
 * 4. Returns the wired AppContainer
 *
 * Returns Result<AppContainer, ConfigError> — does not throw.
 */
export function bootstrap(options: BootstrapOptions): Result<AppContainer, ConfigError> {
  // 1. Create SecretManager (or use the daemon-injected shared-map one)
  const env = options.env;
  const secretManager = options.secretManager ?? createSecretManager(env);

  // 2. Load layered config (with env var substitution via SecretManager).
  // Wrap getSecret to record every substitution referenced by the config. The
  // set also receives provider apiKeyName values after parsing, then becomes
  // container.platformSecretNames for secret-ref denial and env scrubbing.
  // envLayer projects operational env vars (COMIS_GATEWAY_HOST/PORT) into
  // the config layer stack at lower priority than YAML files, so explicit
  // user config wins over env — see config/env-layer.ts.
  const referencedNames = new Set<string>();
  // Platform-managed secrets that are NOT config `${VAR}` references but must
  // still be on the deny surface (never resolvable via user-facing secret-ref
  // tools). The interactive-callback signing secret backs every signed channel.
  referencedNames.add(INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME);
  const configResult = loadLayered(options.configPaths, {
    getSecret: (key) => {
      referencedNames.add(key);
      return secretManager.get(key);
    },
    envLayer: buildGatewayEnvLayer(env),
  });
  if (!configResult.ok) {
    return err(configResult.error);
  }

  // Resolve runtime paths
  const config = resolveConfigRuntimePaths(configResult.value, env);

  // Provider entries name secrets indirectly through apiKeyName rather than
  // `${VAR}` substitution. They are still platform credentials and must share
  // the same deny surface used by child-process inheritance and secret-ref
  // tools.
  for (const entry of Object.values(config.providers.entries)) {
    if (entry.apiKeyName.length > 0) referencedNames.add(entry.apiKeyName);
  }

  // 3. Create event bus
  const eventBus = new TypedEventBus();

  // 3b. Create plugin infrastructure
  const pluginRegistry = createPluginRegistry();
  const hookRunner = createHookRunner(pluginRegistry, { eventBus, catchErrors: true });
  const workspacePolicyPort = options.workspacePolicyPortFactory?.(config);
  const principalResolver = createPrincipalResolver(config.identity.principalMappings);
  if (!principalResolver.ok) {
    return err({
      code: "VALIDATION_ERROR",
      message: principalResolver.error.message,
      path: "identity.principalMappings",
    });
  }

  // 4. Return container
  const container: AppContainer = {
    config,
    eventBus,
    secretManager,
    platformSecretNames: referencedNames,
    pluginRegistry,
    hookRunner,
    principalResolver: principalResolver.value,
    ...(workspacePolicyPort !== undefined ? { workspacePolicyPort } : {}),
    shutdown: async () => {
      await pluginRegistry.deactivateAll();
      eventBus.removeAllListeners();
    },
  };

  return ok(container);
}
