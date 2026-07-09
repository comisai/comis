// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Write-config step -- step 10 of the init wizard.
 *
 * Atomically writes config.yaml and .env files from accumulated
 * WizardState. Creates the data directory. The credential storage mode is
 * chosen earlier (step 02b) and carried on state.storageMode: "encrypted"
 * persists collected secrets into the encrypted secrets.db and writes a
 * placeholder .env, "file" writes a plaintext .env. The resolved mode is
 * emitted as security.storage into config.yaml.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { stringify, parse } from "yaml";
import { safePath, loadEnvFile } from "@comis/core";
import type {
  WizardState,
  WizardStep,
} from "../types.js";
import {
  PROVIDER_ENV_KEYS,
  CHANNEL_ENV_KEYS,
  TOOL_PROVIDER_ENV_KEYS,
  VIDEO_PROVIDER_ENV_KEYS,
  IMAGE_PROVIDER_ENV_KEYS,
  TRANSCRIPTION_PROVIDER_ENV_KEYS,
  TTS_PROVIDER_ENV_KEYS,
} from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { heading, success as themeSuccess } from "../theme.js";
import { offlineSecretSet } from "../../util/offline-secrets-store.js";

/** Matches `${VAR}` env-substitution references in serialized config. */
const SECRET_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ---------- Helpers ----------

/**
 * Get a sensible default model for a provider.
 *
 * Matches the defaults used by the wizard.
 */
function getDefaultModel(provider?: string): string {
  if (!provider) return "default";

  const defaults: Record<string, string> = {
    anthropic: "claude-sonnet-4-5-20250929",
    openai: "gpt-4o",
    // pi-ai catalog's first entry for openai-codex (verified via
    // getModels("openai-codex")[0].id). If pi-ai shuffles its catalog,
    // the daemon's runtime default kicks in (same path as unknown providers).
    "openai-codex": "gpt-5.1",
    google: "gemini-2.0-flash",
    groq: "llama-3.3-70b-versatile",
    ollama: "llama3",
  };
  return defaults[provider] ?? "default";
}

/**
 * Build the config object from WizardState matching AppConfig shape.
 *
 * Uses ${ENV_VAR} substitution for credentials -- actual secrets
 * never appear in config.yaml.
 */
function buildConfigObject(state: WizardState): Record<string, unknown> {
  const config: Record<string, unknown> = {
    logLevel: "debug",
    dataDir: state.dataDir ?? safePath(homedir(), ".comis", "data"),
  };

  // Agents section
  const agentConfig: Record<string, unknown> = {
    name: state.agentName ?? "comis-agent",
    provider: state.provider?.id,
    model: state.model ?? getDefaultModel(state.provider?.id),
  };

  // Custom endpoint providers
  if (state.provider?.customEndpoint) {
    agentConfig.customEndpoint = state.provider.customEndpoint;
  }
  if (state.provider?.compatMode) {
    agentConfig.compatMode = state.provider.compatMode;
  }

  // OAuth profile wiring -- when handleCodexOAuth (step 04) produced a
  // profile, emit it onto the agent so the daemon resolves the right
  // identity for this provider's LLM calls. PerAgentConfigSchema accepts
  // oauthProfiles as Record<provider, profileId> with the literal
  // <provider>:<identity> format already validated at runner time.
  if (state.provider?.oauthProfileId && state.provider?.id) {
    agentConfig.oauthProfiles = {
      [state.provider.id]: state.provider.oauthProfileId,
    };
  }

  // Elevated reply (sender trust map)
  if (state.senderTrustEntries && state.senderTrustEntries.length > 0) {
    const senderTrustMap: Record<string, string> = {};
    for (const entry of state.senderTrustEntries) {
      senderTrustMap[entry.senderId] = entry.level;
    }
    agentConfig.elevatedReply = {
      enabled: true,
      senderTrustMap,
    };
  }

  config.agents = { default: agentConfig };

  // Security section -- emit the resolved credential storage mode chosen at
  // step 02b so the daemon's storage mode is explicit + auditable in
  // config.yaml. AppConfig accepts a top-level security object with a
  // storage enum.
  if (state.storageMode) {
    config.security = { storage: state.storageMode };
  }

  // Gateway section
  if (state.gateway) {
    let host: string;
    switch (state.gateway.bindMode) {
      case "loopback":
        host = "127.0.0.1";
        break;
      case "lan":
        host = "0.0.0.0";
        break;
      case "custom":
        host = state.gateway.customIp ?? "127.0.0.1";
        break;
      default:
        host = "127.0.0.1";
    }

    const gatewayConfig: Record<string, unknown> = {
      enabled: true,
      host,
      port: state.gateway.port ?? 4766,
    };

    // Token is the only supported gateway auth method.
    gatewayConfig.tokens = [
      { id: "default", secret: "${COMIS_GATEWAY_TOKEN}", scopes: ["*"] },
    ];

    // Web dashboard -- default true; wizard always sets this explicitly
    gatewayConfig.web = { enabled: state.gateway.webEnabled };

    config.gateway = gatewayConfig;
  }

  // Channels section
  if (state.channels && state.channels.length > 0) {
    const channels: Record<string, unknown> = {};

    for (const ch of state.channels) {
      const entry: Record<string, unknown> = { enabled: true };

      // Use ${ENV_VAR} substitution per channel type
      if (ch.type === "telegram" && ch.botToken) entry.botToken = "${TELEGRAM_BOT_TOKEN}";
      if (ch.type === "discord" && ch.botToken) entry.botToken = "${DISCORD_BOT_TOKEN}";
      if (ch.type === "slack" && ch.botToken) entry.botToken = "${SLACK_BOT_TOKEN}";
      if (ch.type === "slack" && ch.apiKey) entry.signingSecret = "${SLACK_SIGNING_SECRET}";
      if (ch.type === "whatsapp" && ch.botToken) entry.accessToken = "${WHATSAPP_ACCESS_TOKEN}";
      if (ch.type === "line" && ch.botToken) entry.channelAccessToken = "${LINE_CHANNEL_ACCESS_TOKEN}";
      if (ch.type === "line" && ch.channelSecret) entry.channelSecret = "${LINE_CHANNEL_SECRET}";

      // Microsoft Teams: appId/tenantId/authMode are non-secret config written
      // inline; only appPassword (the client secret) becomes a ${VAR} ref —
      // mirrors slack signingSecret -> ${SLACK_SIGNING_SECRET}. The generic
      // botToken fallback below does NOT fit Teams (it has no botToken), so this
      // explicit block is required (paired with the collectManagedSecrets branch
      // below, or the reference would dangle).
      if (ch.type === "msteams") {
        if (ch.appId) entry.appId = ch.appId;
        if (ch.appPassword) entry.appPassword = "${MSTEAMS_APP_PASSWORD}";
        if (ch.tenantId) entry.tenantId = ch.tenantId;
        if (ch.authMode) entry.authMode = ch.authMode;
      }

      // Generic fallback for other channel types
      if (ch.botToken && !entry.botToken && !entry.accessToken && !entry.channelAccessToken) {
        entry.botToken = `\${${ch.type.toUpperCase()}_BOT_TOKEN}`;
      }
      if (ch.apiKey && !entry.signingSecret && !entry.channelSecret) {
        entry.apiKey = `\${${ch.type.toUpperCase()}_API_KEY}`;
      }
      if (ch.appToken) entry.appToken = `\${${ch.type.toUpperCase()}_APP_TOKEN}`;

      // Discord guild IDs
      if (ch.type === "discord" && ch.guildIds && ch.guildIds.length > 0) {
        entry.guildIds = ch.guildIds;
      }

      // Sender allowlist
      if (ch.allowFrom && ch.allowFrom.length > 0) {
        entry.allowFrom = ch.allowFrom;
      }

      channels[ch.type] = entry;
    }

    config.channels = channels;
  }

  // Integrations section — media generation provider selections (steps 08c/08d).
  // Emit the explicit operator choice (even "auto") so the configured backend is
  // auditable in config.yaml; each sub-key is omitted when its step never ran
  // (the daemon then applies its own "auto" default). The credentials live in
  // .env / the secrets store (collectManagedSecrets) — NOT ${VAR} refs here,
  // because the daemon resolves media keys (FAL_KEY / OPENAI_API_KEY /
  // GOOGLE_API_KEY / OPENROUTER_API_KEY / XAI_API_KEY) straight from the
  // SecretManager.
  const media: Record<string, unknown> = {};
  if (state.imageProvider?.provider) {
    media.imageGeneration = { provider: state.imageProvider.provider };
  }
  if (state.videoProvider?.provider) {
    media.videoGeneration = { provider: state.videoProvider.provider };
  }
  if (state.transcriptionProvider?.provider) {
    media.transcription = { provider: state.transcriptionProvider.provider };
  }
  if (state.ttsProvider?.provider) {
    media.tts = { provider: state.ttsProvider.provider };
  }
  if (Object.keys(media).length > 0) {
    config.integrations = { media };
  }

  // Embedding section — the semantic-recall embedder chosen in step 08g. Only a
  // multilingual choice is written (English keeps the daemon's nomic default, so
  // there is nothing to emit). Writes the AUTHORITATIVE `embedding.*` surface,
  // NOT the legacy `memory.recall.embeddingModel` field. `multilingual: true` is
  // the advisory flag that reconciles the `comis fleet` model-health line.
  if (state.recallProvider?.multilingual === true) {
    const rp = state.recallProvider;
    config.embedding =
      rp.provider === "openai"
        ? { provider: "openai", multilingual: true, openai: { model: rp.model, dimensions: rp.dimensions } }
        : { provider: "local", multilingual: true, local: { modelUri: rp.modelUri } };
  }

  return config;
}

/**
 * Collect the secret values the wizard gathered, keyed by the env-var name
 * the generated config.yaml references them under (e.g. COMIS_GATEWAY_TOKEN,
 * TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY).
 *
 * This is the single source of truth for "what credentials must be persisted
 * for the config to resolve" — consumed by BOTH the .env writer and the
 * secrets-store writer so the two paths can never drift. A `${VAR}` emitted
 * into config.yaml without a matching entry here is a latent boot failure.
 */
function collectManagedSecrets(state: WizardState): Map<string, string> {
  const managed = new Map<string, string>();

  // Provider API key
  if (state.provider?.id && state.provider.apiKey) {
    const envKey = PROVIDER_ENV_KEYS[state.provider.id];
    if (envKey) managed.set(envKey, state.provider.apiKey);
  }

  // Channel credentials
  if (state.channels) {
    for (const ch of state.channels) {
      const envKeys = CHANNEL_ENV_KEYS[ch.type];
      if (ch.botToken && envKeys?.[0]) managed.set(envKeys[0], ch.botToken);
      if (ch.apiKey && envKeys?.[1]) managed.set(envKeys[1], ch.apiKey);
      if (ch.channelSecret && ch.type === "line") {
        const lineEnvKeys = CHANNEL_ENV_KEYS["line"];
        if (lineEnvKeys?.[1]) managed.set(lineEnvKeys[1], ch.channelSecret);
      }
      // Microsoft Teams' secret is appPassword (not botToken/apiKey/channelSecret),
      // so it needs its own branch — this is the join that keeps the config's
      // ${MSTEAMS_APP_PASSWORD} reference from being a dangling, boot-fatal ref.
      if (ch.appPassword && ch.type === "msteams") {
        const msteamsEnvKeys = CHANNEL_ENV_KEYS["msteams"];
        if (msteamsEnvKeys?.[0]) managed.set(msteamsEnvKeys[0], ch.appPassword);
      }
      if (ch.appToken) managed.set(`${ch.type.toUpperCase()}_APP_TOKEN`, ch.appToken);
    }
  }

  // Tool provider credentials
  if (state.toolProviders) {
    for (const tp of state.toolProviders) {
      const envKey = TOOL_PROVIDER_ENV_KEYS[tp.id];
      if (envKey && tp.apiKey) managed.set(envKey, tp.apiKey);
    }
  }

  // Image-generation credential (step 08d). Only present when the wizard
  // collected a STATIC key (fal always; cross-provider openai/google/openrouter).
  // A key-reusing choice, `auto`, or `openai-codex` (OAuth) carries no apiKey
  // here — the matching key is already in the map from the provider section.
  // Set() is idempotent, so a duplicate same-value write is harmless.
  if (state.imageProvider?.apiKey) {
    const envKey = IMAGE_PROVIDER_ENV_KEYS[state.imageProvider.provider];
    if (envKey) managed.set(envKey, state.imageProvider.apiKey);
  }

  // Video-generation credential (step 08c). Only present when the wizard
  // collected a key (fal always; cross-provider google/xai). A key-reusing
  // google/xai or `auto` carries no apiKey here — the GOOGLE_API_KEY/XAI_API_KEY
  // is already in the map from the provider section. Set() is
  // idempotent, so a duplicate same-value write is harmless.
  if (state.videoProvider?.apiKey) {
    const envKey = VIDEO_PROVIDER_ENV_KEYS[state.videoProvider.provider];
    if (envKey) managed.set(envKey, state.videoProvider.apiKey);
  }

  // Transcription (STT) credential (step 08e). Present unless reused from the
  // main provider (openai/groq) — deepgram always carries its own key here.
  if (state.transcriptionProvider?.apiKey) {
    const envKey = TRANSCRIPTION_PROVIDER_ENV_KEYS[state.transcriptionProvider.provider];
    if (envKey) managed.set(envKey, state.transcriptionProvider.apiKey);
  }

  // TTS credential (step 08f). Present unless reused (openai) or keyless (edge);
  // elevenlabs always carries its own ELEVENLABS_API_KEY here.
  if (state.ttsProvider?.apiKey) {
    const envKey = TTS_PROVIDER_ENV_KEYS[state.ttsProvider.provider];
    if (envKey) managed.set(envKey, state.ttsProvider.apiKey);
  }

  // Gateway credentials -- token is the only supported gateway auth method.
  if (state.gateway?.token) {
    managed.set("COMIS_GATEWAY_TOKEN", state.gateway.token);
  }

  return managed;
}

/**
 * Build .env file content lines from WizardState.
 *
 * Contains actual credentials -- never appears in config.yaml.
 * Merges with existingEnv to preserve keys the wizard doesn't manage
 * (e.g. tool provider keys survive a quickstart re-run).
 */
function buildEnvLines(
  state: WizardState,
  existingEnv: Record<string, string | undefined> = {},
): string[] {
  const managed = collectManagedSecrets(state);

  // Merge: start with existing keys, then overlay managed keys
  const merged = new Map<string, string>();
  for (const [key, val] of Object.entries(existingEnv)) {
    if (val !== undefined && val !== "") merged.set(key, val);
  }
  for (const [key, val] of managed) {
    merged.set(key, val);
  }

  const lines: string[] = ["# Comis secrets -- generated by init wizard"];
  for (const [key, val] of merged) {
    lines.push(`${key}=${val}`);
  }

  return lines;
}

/**
 * Return the distinct `${VAR}` references in the serialized config that are
 * NOT covered by `available` (the union of names written to .env and names
 * persisted into the encrypted store). A non-empty result means the daemon
 * would abort at boot with "Missing env var <name>".
 */
function findUnresolvedSecretRefs(
  serializedConfig: string,
  available: ReadonlySet<string>,
): string[] {
  const referenced = new Set<string>();
  for (const match of serializedConfig.matchAll(SECRET_REF_PATTERN)) {
    const name = match[1];
    if (name) referenced.add(name);
  }
  return [...referenced].filter((name) => !available.has(name));
}

// ---------- Step Implementation ----------

export const writeConfigStep: WizardStep = {
  id: "write-config",
  label: "Write Configuration",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    // 1. Show section heading
    prompter.note(heading("Writing Configuration"));

    // 2. Determine paths using safePath (never path.join)
    const configDir = safePath(homedir(), ".comis");
    const configPath = safePath(configDir, "config.yaml");
    const envPath = safePath(configDir, ".env");
    const dataDir = state.dataDir ?? safePath(homedir(), ".comis", "data");

    // 3. Storage mode is decided at step 02b and carried on state.storageMode.
    // "encrypted" routes collected secrets into the encrypted secrets.db (and
    // writes a placeholder .env); anything else writes a plaintext .env. The
    // choice happens exactly once, at step 02b — this step never re-prompts.
    const useSecretsStore = state.storageMode === "encrypted";

    // 4. Build config object
    const configObj = buildConfigObject(state);

    // 5. Serialize to YAML
    const yaml = stringify(configObj, { lineWidth: 0 });

    // 6. Create spinner
    const spinner = prompter.spinner();
    spinner.start("Writing configuration...");

    // Populated by the post-write guard; surfaced to the daemon-start step so
    // it refuses to auto-start a config that would FATAL on a missing ${VAR}.
    // Always assigned before the (post-try) return — the catch always rethrows.
    let unresolvedSecretRefs: string[];

    try {
      // 7. Create config directory
      mkdirSync(configDir, { recursive: true, mode: 0o700 });

      // 8. Atomic config write
      const tempPath = configPath + ".tmp";
      writeFileSync(tempPath, yaml, "utf-8");

      // Validate the temp file is valid YAML
      try {
        const readBack = stringify(parse(yaml));
        if (!readBack) {
          unlinkSync(tempPath);
          throw new Error("YAML validation failed: empty parse result");
        }
      } catch (parseErr) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Best-effort cleanup
        }
        throw new Error(
          `YAML validation failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          { cause: parseErr },
        );
      }

      // Atomic rename (POSIX guarantees atomicity)
      renameSync(tempPath, configPath);
      spinner.update("config.yaml written");

      // 9. Write .env file
      // Load existing .env to preserve keys the wizard doesn't manage
      const existingEnv: Record<string, string | undefined> = {};
      if (existsSync(envPath)) {
        loadEnvFile(envPath, existingEnv);
      }

      // The credentials the wizard collected, keyed by the ${VAR} name the
      // config references. The set of names the daemon will be able to resolve
      // at boot — used by the post-write guard below.
      const managed = collectManagedSecrets(state);
      const availableNames = new Set<string>();
      for (const [key, val] of Object.entries(existingEnv)) {
        if (val !== undefined && val !== "") availableNames.add(key);
      }
      const storeFailures: Array<{ name: string; message: string }> = [];
      let storedCount = 0;

      if (!useSecretsStore) {
        const envContent = buildEnvLines(state, existingEnv).join("\n") + "\n";
        writeFileSync(envPath, envContent, { mode: 0o600 });
        spinner.update(".env written (0600)");
        // Every collected secret is now in .env -> resolvable at boot.
        for (const name of managed.keys()) availableNames.add(name);
      } else {
        // 10. Secrets store mode: minimal .env — but NEVER drop an existing
        // SECRETS_MASTER_KEY. The encrypted secrets.db is sealed with it; if
        // this overwrite removed it, the next daemon boot would regenerate a
        // fresh key that no longer matches the store (DECRYPTION_FAILED), and
        // every stored secret would be orphaned/lost.
        const secretsEnvLines = [
          "# Comis secrets -- managed by secrets store",
          "# API keys are stored encrypted in secrets.db",
          "# Run: comis secrets set <KEY_NAME> to add keys",
          "",
        ];
        const existingMasterKey = existingEnv.SECRETS_MASTER_KEY;
        if (existingMasterKey !== undefined && existingMasterKey !== "") {
          secretsEnvLines.push(`SECRETS_MASTER_KEY=${existingMasterKey}`, "");
        }
        writeFileSync(envPath, secretsEnvLines.join("\n") + "\n", { mode: 0o600 });
        spinner.update(".env written (secrets store mode)");

        // 10a. PERSIST the collected secrets into the encrypted store — the
        // wizard must never discard values it already holds: a ${VAR}
        // referenced by the written config but never stored leaves the daemon
        // FATAL-crash-looping on boot.
        // The .env (with SECRETS_MASTER_KEY) is already written above, so the
        // offline store write can decrypt/seal correctly. The daemon is not
        // running during init, so the daemon-free direct-store path is correct.
        for (const [name, value] of managed) {
          const res = offlineSecretSet({ name, value, dataDir: configDir, envFilePath: envPath });
          if (res.ok) {
            availableNames.add(name);
            storedCount += 1;
          } else {
            storeFailures.push({ name, message: res.error.message });
          }
        }
        spinner.update(
          storeFailures.length === 0
            ? `${storedCount} secret(s) stored in encrypted store`
            : `${storedCount} stored, ${storeFailures.length} failed`,
        );
      }

      // 11. Create data directory
      let dataDirCreated = false;
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        dataDirCreated = true;
      }

      // 12. Stop spinner with success
      spinner.stop("Configuration written successfully");

      // 13. Show summary
      prompter.log.success(themeSuccess("~/.comis/config.yaml"));
      if (!useSecretsStore) {
        prompter.log.success(themeSuccess("~/.comis/.env (0600)"));
      } else {
        prompter.log.success(themeSuccess("~/.comis/.env (secrets store)"));
      }
      if (dataDirCreated) {
        prompter.log.success(themeSuccess(`${dataDir}/ created`));
      }

      // Secrets store summary: the wizard PERSISTS the keys it collected
      // (see step 10a) rather than asking the user to re-enter them.
      if (useSecretsStore) {
        if (storedCount > 0) {
          prompter.log.success(
            themeSuccess(`${storedCount} secret(s) stored in the encrypted store`),
          );
        }
        for (const failure of storeFailures) {
          prompter.log.error(`Failed to store ${failure.name}: ${failure.message}`);
          prompter.log.info(`  Set it manually: comis secrets set ${failure.name}`);
        }
      }

      // 14. Post-write guard: every ${VAR} the config references must resolve
      // from .env or the encrypted store, or the daemon aborts at boot with
      // "Missing env var <name>". Surface the gap loudly here and signal the
      // daemon-start step (via state) so it does not auto-start into a crash
      // loop. This is the safety net behind step 10a — it catches a failed
      // store write or any reference the wizard emitted without a value.
      unresolvedSecretRefs = findUnresolvedSecretRefs(yaml, availableNames);
      if (unresolvedSecretRefs.length > 0) {
        prompter.log.error(
          `config.yaml references ${unresolvedSecretRefs.length} secret(s) that are not set: ${unresolvedSecretRefs.join(", ")}`,
        );
        prompter.log.error("The daemon will not start until these are stored:");
        for (const name of unresolvedSecretRefs) {
          prompter.log.info(`  comis secrets set ${name}`);
        }
      }
    } catch (writeErr) {
      spinner.stop("Configuration write failed");

      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);

      if (msg.includes("ENOSPC")) {
        prompter.log.error("Disk full -- free up space and try again.");
      } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
        prompter.log.error(`Permission denied writing to ${configDir}. Check directory permissions.`);
      } else {
        prompter.log.error(`Write failed: ${msg}`);
      }

      throw writeErr;
    }

    // 15. Return updated state, carrying any unresolved secret refs forward.
    return updateState(
      state,
      unresolvedSecretRefs.length > 0 ? { unresolvedSecretRefs } : {},
    );
  },
};
