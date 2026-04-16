/**
 * Manual wizard flow.
 *
 * Full-control wizard covering all 8 steps: provider, API key,
 * agent name, model, channels, gateway, data directory, and review.
 * Uses ModelCatalog from @comis/agent for dynamic model selection.
 *
 * @module
 */

import * as p from "@clack/prompts";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import { ok, err, type Result } from "@comis/shared";
import { createModelCatalog, type CatalogEntry } from "@comis/agent";
import type { WizardResult, ChannelSetup } from "./flow-types.js";
import {
  PROVIDERS,
  MIN_KEY_LENGTHS,
  CHANNEL_TYPES,
} from "./flow-types.js";
import { writeWizardConfig, writeWizardEnv } from "./config-writer.js";

/**
 * Run the Manual wizard flow.
 *
 * Presents all configuration options: provider, API key, agent name,
 * model, channels, gateway, data directory, and a review step.
 *
 * @param configDir - Override config directory (default ~/.comis)
 * @returns The wizard result or an error
 */
export async function runManualFlow(
  configDir?: string,
): Promise<Result<WizardResult, Error>> {
  const targetDir = configDir ?? os.homedir() + "/.comis";

  p.intro("Comis Manual Setup");

  // Step 1: Provider
  const provider = await p.select({
    message: "Select your LLM provider:",
    options: PROVIDERS,
  });
  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Step 2: API key
  let apiKey = "";
  if (provider !== "ollama") {
    const minLen = MIN_KEY_LENGTHS[provider] ?? 20;
    const keyResult = await p.password({
      message: `Enter your ${provider} API key:`,
      validate: (value) => {
        if (!value || value.length < minLen) {
          return `API key must be at least ${minLen} characters`;
        }
        return undefined;
      },
    });
    if (p.isCancel(keyResult)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    apiKey = keyResult;
  } else {
    p.log.info("Ollama runs locally -- no API key needed.");
  }

  // Step 3: Agent name
  const agentName = await p.text({
    message: "Name your agent:",
    placeholder: "Comis",
    defaultValue: "Comis",
    validate: (value) => {
      if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value)) {
        return "Name must be alphanumeric with optional hyphens (no leading hyphen)";
      }
      if (value.length > 64) {
        return "Name must be at most 64 characters";
      }
      return undefined;
    },
  });
  if (p.isCancel(agentName)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Step 4: Model selection from ModelCatalog
  let model: string;
  try {
    const catalog = createModelCatalog();
    catalog.loadStatic();
    const models = catalog.getByProvider(provider);

    if (models.length > 0) {
      const modelOptions = models.slice(0, 20).map((m: CatalogEntry) => ({
        value: m.modelId,
        label: m.displayName,
        hint: m.contextWindow > 0 ? `${Math.round(m.contextWindow / 1000)}k ctx` : undefined,
      }));
      // Add custom option
      modelOptions.push({ value: "__custom__", label: "Custom (enter manually)", hint: undefined });

      const modelChoice = await p.select({
        message: "Select a model:",
        options: modelOptions,
      });
      if (p.isCancel(modelChoice)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (modelChoice === "__custom__") {
        const custom = await p.text({
          message: "Enter custom model identifier:",
          validate: (value) =>
            !value || value.length === 0
              ? "Model identifier is required"
              : undefined,
        });
        if (p.isCancel(custom)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        model = custom;
      } else {
        model = modelChoice;
      }
    } else {
      const custom = await p.text({
        message: "Enter model identifier:",
        placeholder: getDefaultModel(provider),
        defaultValue: getDefaultModel(provider),
      });
      if (p.isCancel(custom)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
      model = custom;
    }
  } catch {
    // Fallback if ModelCatalog fails
    const custom = await p.text({
      message: "Enter model identifier:",
      placeholder: getDefaultModel(provider),
      defaultValue: getDefaultModel(provider),
    });
    if (p.isCancel(custom)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    model = custom;
  }

  // Step 5: Channels
  const channels: ChannelSetup[] = [];
  const setupChannels = await p.confirm({
    message: "Would you like to configure messaging channels?",
    initialValue: false,
  });
  if (p.isCancel(setupChannels)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (setupChannels) {
    const selectedTypes = await p.multiselect({
      message: "Select channels to configure:",
      options: CHANNEL_TYPES,
      required: false,
    });
    if (p.isCancel(selectedTypes)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    for (const channelType of selectedTypes) {
      const setup: ChannelSetup = { type: channelType };

      if (channelType === "telegram") {
        const token = await p.password({
          message: "Telegram bot token (from @BotFather):",
          validate: (v) =>
            !v || v.length < 10 ? "Token too short" : undefined,
        });
        if (p.isCancel(token)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        setup.botToken = token;
      } else if (channelType === "discord") {
        const token = await p.password({
          message: "Discord bot token:",
          validate: (v) =>
            !v || v.length < 10 ? "Token too short" : undefined,
        });
        if (p.isCancel(token)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        setup.botToken = token;
      } else if (channelType === "slack") {
        const botToken = await p.password({
          message: "Slack bot token (xoxb-...):",
          validate: (v) =>
            !v || v.length < 10 ? "Token too short" : undefined,
        });
        if (p.isCancel(botToken)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        setup.botToken = botToken;

        const appToken = await p.password({
          message: "Slack app token (xapp-...):",
          validate: (v) =>
            !v || v.length < 10 ? "Token too short" : undefined,
        });
        if (p.isCancel(appToken)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        setup.appToken = appToken;
      } else if (channelType === "whatsapp") {
        p.log.info(
          "WhatsApp uses QR code pairing -- no token needed during setup.",
        );
      } else if (channelType === "signal") {
        p.log.info(
          "Signal requires signal-cli. Run 'comis signal-setup' after init.",
        );
      } else if (channelType === "irc" || channelType === "line") {
        p.log.info(
          `${channelType.toUpperCase()} adapter will use default configuration.`,
        );
      }

      channels.push(setup);
    }
  }

  // Step 6: Gateway
  let gatewayEnabled = false;
  let gatewayHost = "127.0.0.1";
  let gatewayPort = 3000;
  let gatewayToken: string | undefined;

  const enableGateway = await p.confirm({
    message: "Enable the gateway HTTP server (web dashboard & API)?",
    initialValue: true,
  });
  if (p.isCancel(enableGateway)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (enableGateway) {
    gatewayEnabled = true;

    const host = await p.text({
      message: "Gateway bind address:",
      defaultValue: "127.0.0.1",
      placeholder: "127.0.0.1",
    });
    if (p.isCancel(host)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    gatewayHost = host;

    const portStr = await p.text({
      message: "Gateway port:",
      defaultValue: "3000",
      placeholder: "3000",
      validate: (value) => {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          return "Port must be an integer between 1 and 65535";
        }
        return undefined;
      },
    });
    if (p.isCancel(portStr)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    gatewayPort = Number(portStr);

    gatewayToken = randomBytes(32).toString("hex");
    p.log.info("Generated gateway access token for authentication.");
  }

  // Step 7: Data directory
  const dataDir = await p.text({
    message: "Data directory for persistent storage:",
    defaultValue: targetDir,
    placeholder: targetDir,
    validate: (value) => {
      if (!value) return "Path is required";
      if (!value.startsWith("/") && !value.startsWith("./") && !value.startsWith("~/")) {
        return "Please provide an absolute path, or relative with ./ or ~/";
      }
      return undefined;
    },
  });
  if (p.isCancel(dataDir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Step 8: Review
  const summary = [
    `  Provider:   ${provider}`,
    `  API Key:    ${apiKey ? "****" + apiKey.slice(-4) : "(none)"}`,
    `  Agent Name: ${agentName}`,
    `  Model:      ${model}`,
    `  Channels:   ${channels.length > 0 ? channels.map((c) => c.type).join(", ") : "(none)"}`,
    `  Gateway:    ${gatewayEnabled ? `${gatewayHost}:${gatewayPort}` : "disabled"}`,
    `  Data Dir:   ${dataDir}`,
  ].join("\n");

  p.log.info("Configuration summary:\n" + summary);

  const confirmed = await p.confirm({
    message: "Save this configuration?",
    initialValue: true,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Setup cancelled. No files written.");
    process.exit(0);
  }

  const wizardResult: WizardResult = {
    provider,
    apiKey,
    agentName,
    model,
    channels,
    gatewayEnabled,
    gatewayHost,
    gatewayPort,
    gatewayToken,
    dataDir,
  };

  // Write config files
  const configResult = writeWizardConfig(wizardResult, targetDir);
  if (!configResult.ok) {
    p.log.error(`Failed to write config: ${configResult.error.message}`);
    return err(configResult.error);
  }

  if (apiKey) {
    const envResult = writeWizardEnv(wizardResult, targetDir);
    if (!envResult.ok) {
      p.log.error(`Failed to write .env: ${envResult.error.message}`);
      return err(envResult.error);
    }
  }

  p.log.success(`Configuration saved to ${configResult.value}`);

  if (gatewayEnabled && gatewayToken) {
    p.log.warn(`Save your gateway token -- it will not be shown again:\n  ${gatewayToken}`);
  }

  p.outro("Setup complete! Next: comis daemon start");

  return ok(wizardResult);
}

/** Fallback default model per provider. */
function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    anthropic: "claude-sonnet-4-5-20250929",
    openai: "gpt-4o",
    google: "gemini-2.0-flash",
    groq: "llama-3.3-70b-versatile",
    ollama: "llama3",
  };
  return defaults[provider] ?? "default";
}
