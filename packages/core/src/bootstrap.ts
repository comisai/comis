// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import os from "node:os";
import path from "node:path";
import type { AppConfig, ConfigError } from "./config/types.js";
import type { SecretManager } from "./security/index.js";
import type { PluginRegistry } from "./hooks/plugin-registry.js";
import type { HookRunner } from "./hooks/hook-runner.js";
import { loadLayered } from "./config/layered.js";
import { buildGatewayEnvLayer } from "./config/env-layer.js";
import { TypedEventBus } from "./event-bus/index.js";
import { createSecretManager, safePath } from "./security/index.js";
import { createPluginRegistry } from "./hooks/plugin-registry.js";
import { createHookRunner } from "./hooks/hook-runner.js";

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
function resolveConfigPaths(
  config: AppConfig,
  env: Record<string, string | undefined>,
): AppConfig {
  const dataDir = config.dataDir || env["COMIS_DATA_DIR"] || DEFAULT_DATA_DIR;
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
 * Extract the per-agent RAW (pre-Zod-default) `rag.rerank.enabled` from the
 * merged-but-unvalidated config tree. Reads `agents.<id>.rag.rerank.enabled`
 * defensively (any level may be absent), coercing only genuine booleans — any
 * non-boolean (string, number, null) is treated as "unset" (`undefined`), which
 * is the safe default-off posture; the subsequent Zod parse is what would reject
 * a malformed value with a precise error. The returned map preserves the
 * tri-state the parsed config destroys (see AppContainer.rawAgentRerankEnabled).
 */
function deriveRawAgentRerankEnabled(
  rawMerged: Record<string, unknown> | undefined,
): Map<string, boolean | undefined> {
  const out = new Map<string, boolean | undefined>();
  const agents = rawMerged?.["agents"];
  if (agents === null || typeof agents !== "object" || Array.isArray(agents)) {
    return out;
  }
  for (const [agentId, agentRaw] of Object.entries(agents as Record<string, unknown>)) {
    if (agentRaw === null || typeof agentRaw !== "object") {
      out.set(agentId, undefined);
      continue;
    }
    const rag = (agentRaw as Record<string, unknown>)["rag"];
    const rerank =
      rag !== null && typeof rag === "object"
        ? (rag as Record<string, unknown>)["rerank"]
        : undefined;
    const enabled =
      rerank !== null && typeof rerank === "object"
        ? (rerank as Record<string, unknown>)["enabled"]
        : undefined;
    out.set(agentId, typeof enabled === "boolean" ? enabled : undefined);
  }
  return out;
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
  /**
   * Per-agent RAW (pre-Zod-default) `rag.rerank.enabled` signal, keyed by
   * agentId. `true`/`false` = the operator set it explicitly; `undefined` (or a
   * missing key) = the operator left it UNSET. The reranker activation logic
   * needs this because the parsed `config.agents.<id>.rag.rerank.enabled` always carries a
   * concrete boolean (`RagConfigSchema.rerank.enabled` has `.default(false)`),
   * which erases the unset signal — so auto-on (unset + model present) could
   * never be distinguished from explicit-off. Both the daemon's per-agent
   * effective-rerank precedence (setup-agents-runtime) AND the reranker build
   * gate (setup-memory) read THIS one map, so the two gates can never disagree
   * on what "explicitly on" means (no parsed-vs-raw drift). Optional because
   * non-bootstrap AppContainer constructions (CLI sub-commands, tests) may not
   * populate it — absent maps degrade to "no raw signal" (treated as unset).
   */
  readonly rawAgentRerankEnabled?: ReadonlyMap<string, boolean | undefined>;
  /** Typed inter-module event bus */
  readonly eventBus: TypedEventBus;
  /** Centralized credential access */
  readonly secretManager: SecretManager;
  /**
   * Names of secrets referenced by the daemon config (`${VAR}` substitutions).
   * These are platform-managed — the exec tool's `secretRefs` parameter
   * refuses them so agents can't exfiltrate credentials the daemon itself
   * uses to talk to providers (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, etc.).
   * User-stored secrets NOT in this set are user-task and flow through.
   */
  readonly platformSecretNames: ReadonlySet<string>;
  /** Plugin registration and hook storage */
  readonly pluginRegistry: PluginRegistry;
  /** Lifecycle hook execution engine */
  readonly hookRunner: HookRunner;
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
  // Wrap getSecret to record every name referenced by the config — the set
  // becomes container.platformSecretNames and is used by the exec tool to
  // refuse secretRefs access to platform-managed credentials.
  // envLayer projects operational env vars (COMIS_GATEWAY_HOST/PORT) into
  // the config layer stack at lower priority than YAML files, so explicit
  // user config wins over env — see config/env-layer.ts.
  const referencedNames = new Set<string>();
  // Platform-managed secrets that are NOT config `${VAR}` references but must
  // still be on the deny surface (never resolvable via user-facing secret-ref
  // tools). The interactive-callback signing secret backs every signed channel.
  referencedNames.add(INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME);
  // Capture the merged RAW config (pre-Zod) so the genuine per-agent
  // rag.rerank.enabled tri-state survives — the parsed config below defaults
  // unset to a concrete `false` and erases it.
  const rawMergedOut: { value?: Record<string, unknown> } = {};
  const configResult = loadLayered(options.configPaths, {
    getSecret: (key) => {
      referencedNames.add(key);
      return secretManager.get(key);
    },
    envLayer: buildGatewayEnvLayer(env),
    rawMergedOut,
  });
  if (!configResult.ok) {
    return err(configResult.error);
  }

  // Resolve runtime paths
  const config = resolveConfigPaths(configResult.value, env);

  // Derive the raw per-agent rerank signal once, from the captured merged tree.
  const rawAgentRerankEnabled = deriveRawAgentRerankEnabled(rawMergedOut.value);

  // 3. Create event bus
  const eventBus = new TypedEventBus();

  // 3b. Create plugin infrastructure
  const pluginRegistry = createPluginRegistry();
  const hookRunner = createHookRunner(pluginRegistry, { eventBus, catchErrors: true });

  // 4. Return container
  const container: AppContainer = {
    config,
    rawAgentRerankEnabled,
    eventBus,
    secretManager,
    platformSecretNames: referencedNames,
    pluginRegistry,
    hookRunner,
    shutdown: async () => {
      await pluginRegistry.deactivateAll();
      eventBus.removeAllListeners();
    },
  };

  return ok(container);
}
