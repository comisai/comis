// SPDX-License-Identifier: Apache-2.0
/**
 * Non-interactive mode for the init wizard.
 *
 * Enables CI/CD pipelines, Docker entrypoints, and automation scripts to
 * drive the init wizard via CLI flags without user interaction. The
 * NonInteractivePrompter implements WizardPrompter by resolving prompts
 * from a pre-built options object, while validateNonInteractiveOptions
 * and buildNonInteractiveState handle flag validation and state
 * construction respectively.
 *
 * Security: credentials are never logged or echoed to any output stream.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { safePath } from "@comis/core";
import { createModelCatalog } from "@comis/agent";
import type {
  WizardState,
  WizardStepId,
  ChannelConfig,
  GatewayConfig,
  ProviderConfig,
} from "./types.js";
import type {
  WizardPrompter,
  SelectOpts,
  MultiselectOpts,
  TextOpts,
  PasswordOpts,
  ConfirmOpts,
  Spinner,
} from "./prompter.js";
import { validatePort } from "./validators/port.js";
import { validateAgentName } from "./validators/agent-name.js";

// ---------- Types ----------

/**
 * All CLI flags available in non-interactive mode.
 *
 * Each field maps to a Commander option flag. Boolean flags default
 * to false/undefined when not specified.
 */
export type NonInteractiveOptions = {
  // Core
  nonInteractive: true;
  acceptRisk: boolean;
  provider?: string;
  apiKey?: string;
  agentName?: string;
  model?: string;
  // Gateway
  gatewayPort?: number;
  gatewayBind?: "loopback" | "lan" | "custom";
  gatewayAuth?: "token" | "password";
  gatewayToken?: string;
  gatewayPassword?: string;
  // Channels
  channels?: string[];
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  lineToken?: string;
  lineSecret?: string;
  // Paths
  dataDir?: string;
  configDir?: string;
  // Behavior
  startDaemon?: boolean;
  skipHealth?: boolean;
  skipValidation?: boolean;
  reset?: boolean;
  resetScope?: "config" | "config+creds" | "full";
  json?: boolean;
  quick?: boolean;
};

// ---------- Error ----------

/**
 * Validation error for non-interactive mode flag issues.
 *
 * Provides a `field` property identifying which flag is missing or
 * invalid, enabling programmatic error handling in CI/CD pipelines.
 * This is distinct from CancelError (user cancellation).
 */
export class NonInteractiveError extends Error {
  /** The flag/field that caused the validation failure. */
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "NonInteractiveError";
    this.field = field;
  }
}

// ---------- Validation ----------

/**
 * Validate non-interactive options before building state.
 *
 * Throws NonInteractiveError for missing required flags, invalid
 * combinations, or missing channel credentials. Returns void on
 * success.
 *
 * @param opts - The parsed CLI options
 * @throws NonInteractiveError with field-specific error details
 */
export function validateNonInteractiveOptions(
  opts: NonInteractiveOptions,
): void {
  // --accept-risk is mandatory
  if (!opts.acceptRisk) {
    throw new NonInteractiveError(
      "--accept-risk is required in non-interactive mode",
      "acceptRisk",
    );
  }

  // --provider is mandatory
  if (!opts.provider || opts.provider.trim().length === 0) {
    throw new NonInteractiveError(
      "--provider is required in non-interactive mode",
      "provider",
    );
  }

  // Soft validation: warn for unknown providers but do not throw.
  // Daemon-side guards (260501-2pz credential-resolver, 260501-gyy
  // builtin-provider-guard) catch genuinely-invalid providers downstream
  // when the agent attempts to use the config. This loosening enables
  // forward compat when a new pi-ai version adds a provider before
  // comis releases. The "custom" provider is always allowed (synthetic).
  if (opts.provider !== "custom") {
    try {
      const catalog = createModelCatalog();
      catalog.loadStatic();
      const known = new Set(catalog.getAll().map((e) => e.provider));
      if (!known.has(opts.provider)) {
        // Soft WARN to stderr -- do not throw, do not log credentials.
        // Note: this path runs in CLI bootstrap; we use console.warn
        // because this function may run before any prompter is wired.
        console.warn(`  WARN: provider "${opts.provider}" is not in the pi-ai catalog. Continuing for forward compatibility -- daemon-side validation will catch invalid providers.`);
      }
    } catch {
      // Catalog load failed (rare) -- skip the check entirely; let
      // downstream daemon-side guards catch invalid providers.
    }
  }

  // Validate gateway port if specified
  if (opts.gatewayPort !== undefined) {
    const portResult = validatePort(opts.gatewayPort);
    if (portResult) {
      throw new NonInteractiveError(
        portResult.message,
        "gatewayPort",
      );
    }
  }

  // Validate agent name if specified
  if (opts.agentName !== undefined) {
    const nameResult = validateAgentName(opts.agentName);
    if (nameResult) {
      throw new NonInteractiveError(
        nameResult.message,
        "agentName",
      );
    }
  }

  // Password auth requires a password
  if (opts.gatewayAuth === "password" && !opts.gatewayPassword) {
    throw new NonInteractiveError(
      "--gateway-password is required when --gateway-auth is 'password'",
      "gatewayPassword",
    );
  }

  // --reset-scope requires --reset
  if (opts.resetScope && !opts.reset) {
    throw new NonInteractiveError(
      "--reset-scope requires --reset to be set",
      "resetScope",
    );
  }

  // Validate channel credentials
  if (opts.channels && opts.channels.length > 0) {
    for (const channel of opts.channels) {
      switch (channel) {
        case "telegram":
          if (!opts.telegramToken) {
            throw new NonInteractiveError(
              "--telegram-token is required when telegram channel is enabled",
              "telegramToken",
            );
          }
          break;
        case "discord":
          if (!opts.discordToken) {
            throw new NonInteractiveError(
              "--discord-token is required when discord channel is enabled",
              "discordToken",
            );
          }
          break;
        case "slack":
          if (!opts.slackBotToken) {
            throw new NonInteractiveError(
              "--slack-bot-token is required when slack channel is enabled",
              "slackBotToken",
            );
          }
          if (!opts.slackAppToken) {
            throw new NonInteractiveError(
              "--slack-app-token is required when slack channel is enabled",
              "slackAppToken",
            );
          }
          break;
        case "line":
          if (!opts.lineToken) {
            throw new NonInteractiveError(
              "--line-token is required when line channel is enabled",
              "lineToken",
            );
          }
          if (!opts.lineSecret) {
            throw new NonInteractiveError(
              "--line-secret is required when line channel is enabled",
              "lineSecret",
            );
          }
          break;
        // whatsapp, signal, irc do not require tokens at init time
        default:
          // Unknown channel -- allow for forward compatibility
          break;
      }
    }
  }
}

// ---------- State Builder ----------

/**
 * Build a complete WizardState from non-interactive CLI options.
 *
 * Constructs all state fields that the wizard steps would normally
 * populate through interactive prompts. The resulting state marks
 * all interactive steps as completed so the wizard runner skips
 * directly to write-config, daemon-start, and finish.
 *
 * @param opts - Validated non-interactive options
 * @returns A fully populated WizardState
 */
export function buildNonInteractiveState(
  opts: NonInteractiveOptions,
): WizardState {
  // Provider config
  const provider: ProviderConfig = {
    id: opts.provider!,
    ...(opts.apiKey !== undefined && { apiKey: opts.apiKey }),
    validated: !!opts.skipValidation,
  };

  // Model selection -- delegate to daemon when not specified.
  // The literal "default" is resolved at agent-execution time via the
  // pi-ai catalog (builtin-provider-guard.ts:45 baseUrl pattern). Pre-
  // 260501-kqq, this read a hardcoded provider->model map; that lookup
  // was removed -- the daemon decides at runtime.
  const model = opts.model ?? "default";

  // Channel configs
  const channels: ChannelConfig[] = [];
  if (opts.channels && opts.channels.length > 0) {
    for (const ch of opts.channels) {
      switch (ch) {
        case "telegram":
          channels.push({
            type: "telegram",
            botToken: opts.telegramToken,
            validated: false,
          });
          break;
        case "discord":
          channels.push({
            type: "discord",
            botToken: opts.discordToken,
            validated: false,
          });
          break;
        case "slack":
          channels.push({
            type: "slack",
            botToken: opts.slackBotToken,
            appToken: opts.slackAppToken,
            validated: false,
          });
          break;
        case "line":
          channels.push({
            type: "line",
            botToken: opts.lineToken,
            channelSecret: opts.lineSecret,
            validated: false,
          });
          break;
        case "whatsapp":
          channels.push({ type: "whatsapp", validated: false });
          break;
        case "signal":
          channels.push({ type: "signal", validated: false });
          break;
        case "irc":
          channels.push({ type: "irc", validated: false });
          break;
        default:
          // Unknown channel type -- skip silently for forward compat
          break;
      }
    }
  }

  // Gateway config
  const gatewayAuth = opts.gatewayAuth ?? "token";
  let gatewayToken: string | undefined;
  let gatewayPassword: string | undefined;

  if (gatewayAuth === "token") {
    // Auto-generate 48-char hex token when none provided (same as step 07)
    gatewayToken = opts.gatewayToken ?? randomBytes(24).toString("hex");
  } else {
    gatewayPassword = opts.gatewayPassword;
  }

  const gateway: GatewayConfig = {
    port: opts.gatewayPort ?? 4766,
    bindMode: opts.gatewayBind ?? "loopback",
    authMethod: gatewayAuth,
    ...(gatewayToken !== undefined && { token: gatewayToken }),
    ...(gatewayPassword !== undefined && { password: gatewayPassword }),
    webEnabled: true,
  };

  // Data directory
  const dataDir =
    opts.dataDir ?? safePath(homedir(), ".comis", "data");

  // Mark all interactive steps as completed so the wizard runner skips
  // them and only runs write-config, daemon-start, and finish.
  const completedSteps: WizardStepId[] = [
    "welcome",
    "detect-existing",
    "flow-select",
    "provider",
    "credentials",
    "agent",
    "channels",
    "gateway",
    "workspace",
    "review",
  ];

  return {
    flow: opts.quick ? "quickstart" : "advanced",
    riskAccepted: true,
    existingConfigAction: opts.reset ? "fresh" : undefined,
    resetScope: opts.reset ? (opts.resetScope ?? "config") : undefined,
    provider,
    agentName: opts.agentName ?? "comis-agent",
    model,
    channels,
    gateway,
    dataDir,
    skipHealth: opts.skipHealth ?? false,
    completedSteps,
  };
}

// ---------- NonInteractivePrompter ----------

/**
 * WizardPrompter implementation that resolves prompts from CLI flags.
 *
 * Used in non-interactive mode so the exact same wizard step code
 * works without any user interaction. All prompt methods resolve
 * from the pre-built options object.
 *
 * When `quiet` is true (--json mode), all output methods are no-ops
 * to keep stdout clean for JSON output. When quiet is false, output
 * is written to stderr to avoid contaminating stdout.
 */
export class NonInteractivePrompter implements WizardPrompter {
  private readonly opts: NonInteractiveOptions;
  private readonly quiet: boolean;

  constructor(opts: NonInteractiveOptions, quiet: boolean = false) {
    this.opts = opts;
    this.quiet = quiet;
  }

  intro(_title: string): void {
    // No-op in non-interactive mode
  }

  outro(_message: string): void {
    // No-op in non-interactive mode
  }

  note(_message: string, _title?: string): void {
    // No-op in non-interactive mode
  }

  async select<T>(opts: SelectOpts<T>): Promise<T> {
    // Handle daemon start prompt specifically -- it uses select() with
    // "yes"/"no" string values, NOT confirm() with boolean.
    if (opts.message === "Start the Comis daemon now?") {
      const value = this.opts.startDaemon ? "yes" : "no";
      // Find the matching option to return the correctly-typed value
      const match = opts.options.find(
        (o) => String(o.value) === value,
      );
      if (match) return match.value;
      // Fallback: return the string value cast to T
      return value as unknown as T;
    }

    // For other select prompts, try to return the first option or initialValue
    if (opts.initialValue !== undefined) {
      return opts.initialValue;
    }
    if (opts.options.length > 0) {
      return opts.options[0].value;
    }

    throw new NonInteractiveError(
      `No value available for prompt: ${opts.message}`,
      "select",
    );
  }

  async multiselect<T>(opts: MultiselectOpts<T>): Promise<T[]> {
    // Return initialValues or all options
    if (opts.initialValues && opts.initialValues.length > 0) {
      return opts.initialValues;
    }
    return opts.options.map((o) => o.value);
  }

  async text(opts: TextOpts): Promise<string> {
    // Return defaultValue if available
    if (opts.defaultValue !== undefined) {
      return opts.defaultValue;
    }

    throw new NonInteractiveError(
      `No value available for prompt: ${opts.message}`,
      "text",
    );
  }

  async password(_opts: PasswordOpts): Promise<string> {
    // Password prompts should not be reached in non-interactive mode
    // because buildNonInteractiveState pre-populates all credentials.
    throw new NonInteractiveError(
      "Password prompt reached in non-interactive mode -- this is a bug",
      "password",
    );
  }

  async confirm(opts: ConfirmOpts): Promise<boolean> {
    // Map known confirm prompts to sensible non-interactive defaults
    const msg = opts.message.toLowerCase();

    // Risk acceptance
    if (msg.includes("risk") || msg.includes("acknowledge")) {
      return true;
    }

    // Shell completions
    if (msg.includes("shell completion")) {
      return false;
    }

    // Store in secrets
    if (msg.includes("secret") || msg.includes("store")) {
      return false;
    }

    // Default to initialValue or false
    return opts.initialValue ?? false;
  }

  spinner(): Spinner {
    if (this.quiet) {
      return {
        start(_msg: string): void { /* no-op */ },
        update(_msg: string): void { /* no-op */ },
        stop(_msg: string): void { /* no-op */ },
      };
    }

    return {
      start(msg: string): void {
        process.stderr.write(`  ${msg}\n`);
      },
      update(msg: string): void {
        process.stderr.write(`  ${msg}\n`);
      },
      stop(msg: string): void {
        process.stderr.write(`  ${msg}\n`);
      },
    };
  }

  async group<T extends Record<string, unknown>>(
    steps: { [K in keyof T]: () => Promise<T[K]> },
  ): Promise<T> {
    // Execute thunks sequentially (same pattern as ClackAdapter)
    const results = {} as Record<string, unknown>;
    const keys = Object.keys(steps) as (keyof T)[];

    for (const key of keys) {
      const step = steps[key];
      const value = await step();
      results[key as string] = value;
    }

    return results as T;
  }

  log = {
    info: (msg: string): void => {
      if (!this.quiet) {
        process.stderr.write(`  ${msg}\n`);
      }
    },
    warn: (msg: string): void => {
      if (!this.quiet) {
        process.stderr.write(`  WARN: ${msg}\n`);
      }
    },
    error: (msg: string): void => {
      // Always write errors, even in quiet mode
      process.stderr.write(`  ERROR: ${msg}\n`);
    },
    success: (msg: string): void => {
      if (!this.quiet) {
        process.stderr.write(`  ${msg}\n`);
      }
    },
  };
}
