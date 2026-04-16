import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import os from "node:os";
import path from "node:path";
import type { AppConfig, ConfigError } from "./config/types.js";
import type { SecretManager } from "./security/index.js";
import type { PluginRegistry } from "./hooks/plugin-registry.js";
import type { HookRunner } from "./hooks/hook-runner.js";
import { loadLayered } from "./config/layered.js";
import { TypedEventBus } from "./event-bus/index.js";
import { createSecretManager, safePath } from "./security/index.js";
import { createPluginRegistry } from "./hooks/plugin-registry.js";
import { createHookRunner } from "./hooks/hook-runner.js";
import { setGlobalHookRunner, clearGlobalHookRunner } from "./hooks/hook-runner-global.js";

/** Default base directory: ~/.comis */
const DEFAULT_DATA_DIR = safePath(os.homedir(), ".comis");

/**
 * Resolve runtime paths in config.
 * - dataDir defaults to ~/.comis
 * - memory.dbPath resolves relative to dataDir if not absolute
 */
function resolveConfigPaths(config: AppConfig): AppConfig {
  const dataDir = config.dataDir || DEFAULT_DATA_DIR;
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
  /** Environment variables to seed the SecretManager (defaults to process.env) */
  env?: Record<string, string | undefined>;
}

/**
 * The application dependency container.
 *
 * Created by bootstrap(), this wires all Phase 1 services together
 * and provides a single shutdown() method for graceful cleanup.
 */
export interface AppContainer {
  /** Current application configuration */
  readonly config: AppConfig;
  /** Typed inter-module event bus */
  readonly eventBus: TypedEventBus;
  /** Centralized credential access */
  readonly secretManager: SecretManager;
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
  // 1. Create SecretManager
  const env = options.env ?? process.env;
  const secretManager = createSecretManager(env);

  // 2. Load layered config (with env var substitution via SecretManager)
  const configResult = loadLayered(options.configPaths, {
    getSecret: (key) => secretManager.get(key),
  });
  if (!configResult.ok) {
    return err(configResult.error);
  }

  // Resolve runtime paths
  const config = resolveConfigPaths(configResult.value);

  // 3. Create event bus
  const eventBus = new TypedEventBus();

  // 3b. Create plugin infrastructure
  const pluginRegistry = createPluginRegistry({ eventBus });
  const hookRunner = createHookRunner(pluginRegistry, { eventBus, catchErrors: true });

  // Set global hook runner for deliverToChannel() access
  setGlobalHookRunner(hookRunner);

  // 4. Return container
  const container: AppContainer = {
    config,
    eventBus,
    secretManager,
    pluginRegistry,
    hookRunner,
    shutdown: async () => {
      clearGlobalHookRunner();
      await pluginRegistry.deactivateAll();
      eventBus.removeAllListeners();
    },
  };

  return ok(container);
}
