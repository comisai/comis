// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
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
import { safePath, writeMasterKeyIfAbsent } from "@comis/core";
import { createModelCatalog } from "@comis/core";
import type {
  WizardState,
  WizardStepId,
  ChannelConfig,
  GatewayConfig,
  ProviderConfig,
  VideoProviderConfig,
  ImageProviderConfig,
  TranscriptionProviderConfig,
  TtsProviderConfig,
} from "./types.js";
import {
  SUPPORTED_VIDEO_PROVIDERS,
  VIDEO_PROVIDER_ENV_KEYS,
  SUPPORTED_IMAGE_PROVIDERS,
  IMAGE_PROVIDER_ENV_KEYS,
  SUPPORTED_TRANSCRIPTION_PROVIDERS,
  TRANSCRIPTION_PROVIDER_ENV_KEYS,
  SUPPORTED_TTS_PROVIDERS,
  TTS_PROVIDER_ENV_KEYS,
  PROVIDER_ENV_KEYS,
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
import { DAEMON_START_PROMPT, DAEMON_RESTART_PROMPT } from "./steps/11-daemon-start.js";

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
  // Gateway (token is the only supported auth method)
  gatewayPort?: number;
  gatewayBind?: "loopback" | "lan" | "custom";
  gatewayToken?: string;
  // Channels
  channels?: string[];
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  lineToken?: string;
  lineSecret?: string;
  msteamsAppId?: string;
  msteamsAppPassword?: string;
  msteamsTenantId?: string;
  msteamsAuthMode?: "secret" | "certificate" | "managedIdentity";
  googlechatSaKey?: string;
  googlechatSubscription?: string;
  googlechatMode?: "pubsub" | "webhook";
  googlechatAudience?: string;
  // Media generation
  imageProvider?: string;
  imageApiKey?: string;
  videoProvider?: string;
  videoApiKey?: string;
  // Media processing
  sttProvider?: string;
  sttApiKey?: string;
  ttsProvider?: string;
  ttsApiKey?: string;
  // Paths
  dataDir?: string;
  configDir?: string;
  // Credential storage
  storage?: "encrypted" | "file";
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

  // openai-codex requires interactive OAuth login (browser callback,
  // device-code prompt, or manual paste). Non-interactive mode has no
  // way to drive the OAuth flow, so reject up front with a clear hint
  // pointing at `comis auth login --method device-code`. Placed BEFORE
  // the soft "unknown provider" warning so the literal error fires
  // even though openai-codex IS in the pi-ai catalog.
  if (opts.provider === "openai-codex") {
    throw new NonInteractiveError(
      "openai-codex requires interactive login; run `comis init` interactively or run `comis auth login --provider openai-codex --method device-code` separately.",
      "provider",
    );
  }

  // Soft validation: warn for unknown providers but do not throw.
  // Daemon-side guards (credential-resolver, builtin-provider-guard)
  // catch genuinely-invalid providers downstream when the agent
  // attempts to use the config. This loosening enables forward compat
  // when a new pi-ai version adds a provider before comis releases.
  // The "custom" provider is always allowed (synthetic).
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

  // --reset-scope requires --reset
  if (opts.resetScope && !opts.reset) {
    throw new NonInteractiveError(
      "--reset-scope requires --reset to be set",
      "resetScope",
    );
  }

  // --storage, when provided, must be one of encrypted|file
  if (opts.storage !== undefined && opts.storage !== "encrypted" && opts.storage !== "file") {
    throw new NonInteractiveError(
      "--storage must be 'encrypted' or 'file'",
      "storage",
    );
  }

  // --image-provider / --video-provider, when provided, must be one of the
  // closed media vocabulary. Unlike LLM providers (an evolving pi-ai catalog),
  // these are fixed config enums, so a typo would FATAL the daemon at config
  // parse — reject early with a clear hint.
  if (opts.imageProvider !== undefined) {
    const known = SUPPORTED_IMAGE_PROVIDERS.map((ip) => ip.id);
    if (!known.includes(opts.imageProvider)) {
      throw new NonInteractiveError(
        `--image-provider must be one of: ${known.join(", ")}`,
        "imageProvider",
      );
    }
  }
  if (opts.videoProvider !== undefined) {
    const known = SUPPORTED_VIDEO_PROVIDERS.map((vp) => vp.id);
    if (!known.includes(opts.videoProvider)) {
      throw new NonInteractiveError(
        `--video-provider must be one of: ${known.join(", ")}`,
        "videoProvider",
      );
    }
  }
  if (opts.sttProvider !== undefined) {
    const known = SUPPORTED_TRANSCRIPTION_PROVIDERS.map((tp) => tp.id);
    if (!known.includes(opts.sttProvider)) {
      throw new NonInteractiveError(
        `--stt-provider must be one of: ${known.join(", ")}`,
        "sttProvider",
      );
    }
  }
  if (opts.ttsProvider !== undefined) {
    const known = SUPPORTED_TTS_PROVIDERS.map((tp) => tp.id);
    if (!known.includes(opts.ttsProvider)) {
      throw new NonInteractiveError(
        `--tts-provider must be one of: ${known.join(", ")}`,
        "ttsProvider",
      );
    }
  }

  // --msteams-auth-mode, when provided, must be one of the closed Bot Framework
  // auth vocabulary. Like the media-provider enums above (and the --storage
  // enum) this is a fixed config enum — a typo would be written verbatim into
  // config.yaml and only rejected by the daemon's MsTeamsChannelEntrySchema at
  // boot (a FATAL, or a crash loop under --start-daemon). Reject early with a
  // clear hint. This also restores parity with the interactive path, which
  // bounds authMode to exactly these three values via a select prompt.
  if (
    opts.msteamsAuthMode !== undefined &&
    !["secret", "certificate", "managedIdentity"].includes(opts.msteamsAuthMode)
  ) {
    throw new NonInteractiveError(
      "--msteams-auth-mode must be one of: secret, certificate, managedIdentity",
      "msteamsAuthMode",
    );
  }

  // --googlechat-mode, when provided, must be one of the closed inbound-transport
  // vocabulary. Like the enums above, a typo would be written verbatim into
  // config.yaml and only rejected by the daemon's GoogleChatChannelEntrySchema at
  // boot. Reject early with a clear hint, mirroring the interactive select prompt.
  if (
    opts.googlechatMode !== undefined &&
    !["pubsub", "webhook"].includes(opts.googlechatMode)
  ) {
    throw new NonInteractiveError(
      "--googlechat-mode must be one of: pubsub, webhook",
      "googlechatMode",
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
        case "msteams":
          if (!opts.msteamsAppId) {
            throw new NonInteractiveError(
              "--msteams-app-id is required when msteams channel is enabled",
              "msteamsAppId",
            );
          }
          if (!opts.msteamsAppPassword) {
            throw new NonInteractiveError(
              "--msteams-app-password is required when msteams channel is enabled",
              "msteamsAppPassword",
            );
          }
          if (!opts.msteamsTenantId) {
            throw new NonInteractiveError(
              "--msteams-tenant-id is required when msteams channel is enabled",
              "msteamsTenantId",
            );
          }
          break;
        case "googlechat": {
          if (!opts.googlechatSaKey) {
            throw new NonInteractiveError(
              "--googlechat-sa-key is required when googlechat channel is enabled",
              "googlechatSaKey",
            );
          }
          // pubsub (the default when --googlechat-mode is absent) needs the
          // Pub/Sub subscription; webhook needs the inbound JWT audience.
          // Reject an incomplete block before it is written.
          const mode = opts.googlechatMode ?? "pubsub";
          if (mode === "pubsub" && !opts.googlechatSubscription) {
            throw new NonInteractiveError(
              "--googlechat-subscription is required for googlechat pubsub mode",
              "googlechatSubscription",
            );
          }
          if (mode === "webhook" && !opts.googlechatAudience) {
            throw new NonInteractiveError(
              "--googlechat-audience is required for googlechat webhook mode",
              "googlechatAudience",
            );
          }
          break;
        }
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
  // pi-ai catalog (builtin-provider-guard.ts baseUrl pattern). There is
  // no CLI-side provider->model map -- the daemon decides at runtime.
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
        case "msteams":
          channels.push({
            type: "msteams",
            appId: opts.msteamsAppId,
            appPassword: opts.msteamsAppPassword,
            tenantId: opts.msteamsTenantId,
            authMode: opts.msteamsAuthMode,
            validated: false,
          });
          break;
        case "googlechat":
          // The SA key is taken verbatim (CI passes the JSON directly, e.g.
          // --googlechat-sa-key "$(cat key.json)"); write-config swaps it for the
          // ${GOOGLECHAT_SA_KEY} ref and persists the blob to the secret store.
          channels.push({
            type: "googlechat",
            serviceAccountKey: opts.googlechatSaKey,
            subscriptionName: opts.googlechatSubscription,
            audience: opts.googlechatAudience,
            mode: opts.googlechatMode,
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

  // Image-generation provider (step 08d, skipped in non-interactive mode).
  // Mirrors the interactive step's credential-reuse rule: an openai/google/openrouter choice
  // that matches the main provider reuses --api-key; fal or a cross-provider
  // choice uses --image-api-key; auto and openai-codex (OAuth) take no key.
  let imageProvider: ImageProviderConfig | undefined;
  if (opts.imageProvider !== undefined) {
    const requiredEnvKey = IMAGE_PROVIDER_ENV_KEYS[opts.imageProvider];
    if (!requiredEnvKey) {
      // auto or openai-codex — no static key collected here.
      imageProvider = { provider: opts.imageProvider };
    } else if (
      opts.apiKey !== undefined &&
      PROVIDER_ENV_KEYS[opts.provider!] === requiredEnvKey
    ) {
      imageProvider = { provider: opts.imageProvider };
    } else if (opts.imageApiKey !== undefined) {
      imageProvider = { provider: opts.imageProvider, apiKey: opts.imageApiKey };
    } else {
      imageProvider = { provider: opts.imageProvider };
    }
  }

  // Video-generation provider (step 08c, skipped in non-interactive mode).
  // Build the state the step would have produced from --video-provider. The
  // credential resolution mirrors the interactive step's reuse rule: a google/xai
  // choice that matches the main provider reuses --api-key (no extra key); fal
  // or a cross-provider google/xai uses --video-api-key.
  let videoProvider: VideoProviderConfig | undefined;
  if (opts.videoProvider !== undefined) {
    const requiredEnvKey = VIDEO_PROVIDER_ENV_KEYS[opts.videoProvider];
    if (!requiredEnvKey) {
      // auto — follow the main provider; no credential.
      videoProvider = { provider: opts.videoProvider };
    } else if (
      opts.apiKey !== undefined &&
      PROVIDER_ENV_KEYS[opts.provider!] === requiredEnvKey
    ) {
      // Main provider already supplies the matching key (e.g. google main + Veo).
      videoProvider = { provider: opts.videoProvider };
    } else if (opts.videoApiKey !== undefined) {
      videoProvider = { provider: opts.videoProvider, apiKey: opts.videoApiKey };
    } else {
      // No key available to satisfy this provider — record the selection so the
      // config is written; the daemon surfaces an honest auth_required at use
      // time (no video-specific ${VAR} ref to crash boot).
      videoProvider = { provider: opts.videoProvider };
    }
  }

  // Transcription (STT) provider (step 08e, skipped in non-interactive mode).
  // auto (keyless-first / follow-main) and local (in-process whisper) need no
  // key; openai/groq reuse --api-key when it matches the main provider; deepgram
  // (and any cross-provider choice) uses --stt-api-key.
  let transcriptionProvider: TranscriptionProviderConfig | undefined;
  if (opts.sttProvider !== undefined) {
    const requiredEnvKey = TRANSCRIPTION_PROVIDER_ENV_KEYS[opts.sttProvider];
    if (!requiredEnvKey) {
      // keyless: auto (keyless-first / follow-main) or local (in-process
      // whisper) — no static key collected here. Mirrors the TTS/image branches.
      transcriptionProvider = { provider: opts.sttProvider };
    } else if (
      opts.apiKey !== undefined &&
      PROVIDER_ENV_KEYS[opts.provider!] === requiredEnvKey
    ) {
      transcriptionProvider = { provider: opts.sttProvider };
    } else if (opts.sttApiKey !== undefined) {
      transcriptionProvider = { provider: opts.sttProvider, apiKey: opts.sttApiKey };
    } else {
      transcriptionProvider = { provider: opts.sttProvider };
    }
  }

  // TTS provider (step 08f, skipped in non-interactive mode). edge needs no key;
  // openai reuses --api-key when the main provider is openai; elevenlabs (and any
  // cross-provider openai) uses --tts-api-key.
  let ttsProvider: TtsProviderConfig | undefined;
  if (opts.ttsProvider !== undefined) {
    const requiredEnvKey = TTS_PROVIDER_ENV_KEYS[opts.ttsProvider];
    if (!requiredEnvKey) {
      // edge — free, no key.
      ttsProvider = { provider: opts.ttsProvider };
    } else if (
      opts.apiKey !== undefined &&
      PROVIDER_ENV_KEYS[opts.provider!] === requiredEnvKey
    ) {
      ttsProvider = { provider: opts.ttsProvider };
    } else if (opts.ttsApiKey !== undefined) {
      ttsProvider = { provider: opts.ttsProvider, apiKey: opts.ttsApiKey };
    } else {
      ttsProvider = { provider: opts.ttsProvider };
    }
  }

  // Gateway config — token is the only supported gateway auth method.
  // Auto-generate a 48-char hex token when none provided (same as step 07).
  const gatewayToken = opts.gatewayToken ?? randomBytes(24).toString("hex");

  const gateway: GatewayConfig = {
    port: opts.gatewayPort ?? 4766,
    bindMode: opts.gatewayBind ?? "loopback",
    token: gatewayToken,
    webEnabled: true,
  };

  // Data directory
  const dataDir =
    opts.dataDir ?? safePath(homedir(), ".comis", "data");

  // Credential storage mode -- encrypted by default. When encrypted, provision
  // the master key headlessly so the encrypted store is usable without a
  // separate `comis secrets init`. The key belongs at the CONFIG dir
  // (~/.comis/.env), NOT the /data subdir -- same place step 02b + step 10
  // read it from. writeMasterKeyIfAbsent is idempotent (never clobbers an
  // existing key).
  const storageMode = opts.storage ?? "encrypted";
  const configDir = opts.configDir ?? safePath(homedir(), ".comis");
  if (storageMode === "encrypted") {
    writeMasterKeyIfAbsent(configDir);
  }

  // Mark all interactive steps as completed so the wizard runner skips
  // them and only runs write-config, daemon-start, and finish. This MUST
  // list every interactive step registered in buildStepRegistry (init.ts);
  // any omission lets that step run and hit a prompt -> NonInteractiveError
  // ("...prompt reached in non-interactive mode -- this is a bug"). The
  // tool-providers step (08b) calls prompter.password() and was the missing
  // one. init.test.ts cross-checks this list against the live registry.
  const completedSteps: WizardStepId[] = [
    "welcome",
    "detect-existing",
    "flow-select",
    "storage",
    "provider",
    "credentials",
    "agent",
    "channels",
    "gateway",
    "workspace",
    "tool-providers",
    "image-providers",
    "video-providers",
    "transcription",
    "tts",
    "review",
  ];

  return {
    flow: opts.quick ? "quickstart" : "advanced",
    riskAccepted: true,
    existingConfigAction: opts.reset ? "fresh" : undefined,
    resetScope: opts.reset ? (opts.resetScope ?? "config") : undefined,
    provider,
    storageMode,
    agentName: opts.agentName ?? "comis-agent",
    model,
    channels,
    ...(imageProvider !== undefined && { imageProvider }),
    ...(videoProvider !== undefined && { videoProvider }),
    ...(transcriptionProvider !== undefined && { transcriptionProvider }),
    ...(ttsProvider !== undefined && { ttsProvider }),
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
    // Daemon start/restart prompts (step 11) MUST respect --start-daemon. Both
    // use select() with string values, not confirm(). Without this, the generic
    // first-option fallback below picks "yes"/"restart" and a plain
    // `comis init --non-interactive` (startDaemon defaults false) silently
    // spawns — or, when a daemon already holds the gateway port, STOPS+RESPAWNS
    // an unrelated running daemon (observed live). We key off the exact prompt
    // literals the step exports so the two can never drift.
    if (
      opts.message === DAEMON_START_PROMPT ||
      opts.message === DAEMON_RESTART_PROMPT
    ) {
      const value = this.opts.startDaemon
        ? opts.message === DAEMON_RESTART_PROMPT
          ? "restart"
          : "yes"
        : "no";
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
