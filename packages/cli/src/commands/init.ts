// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Init wizard command.
 *
 * Provides `comis init` with full non-interactive mode support
 * for CI/CD pipelines and Docker entrypoints, plus the interactive
 * wizard experience using the new step-based architecture.
 *
 * Non-interactive mode: all values from CLI flags, no prompts.
 * Interactive mode: step-by-step wizard using @clack/prompts.
 *
 * @module
 */

import type { Command } from "commander";
import type { WizardStepId, WizardState } from "../wizard/types.js";
import type { StepRegistry } from "../wizard/state.js";
import { runWizardFlow } from "../wizard/state.js";
import { CancelError } from "../wizard/prompter.js";
import {
  NonInteractiveError,
  validateNonInteractiveOptions,
  buildNonInteractiveState,
  NonInteractivePrompter,
} from "../wizard/non-interactive.js";
import type { NonInteractiveOptions } from "../wizard/non-interactive.js";
import { buildJsonOutput, buildJsonError } from "../wizard/json-output.js";
import { welcomeStep } from "../wizard/steps/00-welcome.js";
import { detectExistingStep } from "../wizard/steps/01-detect-existing.js";
import { flowSelectStep } from "../wizard/steps/02-flow-select.js";
import { storageStep } from "../wizard/steps/02b-storage.js";
import { providerStep } from "../wizard/steps/03-provider.js";
import { credentialsStep } from "../wizard/steps/04-credentials.js";
import { agentStep } from "../wizard/steps/05-agent.js";
import { channelsStep } from "../wizard/steps/06-channels.js";
import { gatewayStep } from "../wizard/steps/07-gateway.js";
import { workspaceStep } from "../wizard/steps/08-workspace.js";
import { toolProvidersStep } from "../wizard/steps/08b-tool-providers.js";
import { videoProvidersStep } from "../wizard/steps/08c-video-providers.js";
import { imageProvidersStep } from "../wizard/steps/08d-image-providers.js";
import { reviewStep } from "../wizard/steps/09-review.js";
import { writeConfigStep } from "../wizard/steps/10-write-config.js";
import { daemonStartStep } from "../wizard/steps/11-daemon-start.js";
import { finishStep } from "../wizard/steps/12-finish.js";

// ---------- Step Registry ----------

/**
 * Build the full step registry with all 17 wizard steps.
 *
 * Used by both interactive and non-interactive modes to provide
 * the same step implementations to the wizard runner.
 */
export function buildStepRegistry(): StepRegistry {
  const registry: StepRegistry = new Map();
  registry.set("welcome", welcomeStep);
  registry.set("detect-existing", detectExistingStep);
  registry.set("flow-select", flowSelectStep);
  registry.set("storage", storageStep);
  registry.set("provider", providerStep);
  registry.set("credentials", credentialsStep);
  registry.set("agent", agentStep);
  registry.set("channels", channelsStep);
  registry.set("gateway", gatewayStep);
  registry.set("workspace", workspaceStep);
  registry.set("tool-providers", toolProvidersStep);
  registry.set("image-providers", imageProvidersStep);
  registry.set("video-providers", videoProvidersStep);
  registry.set("review", reviewStep);
  registry.set("write-config", writeConfigStep);
  registry.set("daemon-start", daemonStartStep);
  registry.set("finish", finishStep);
  return registry;
}

// ---------- Commander Options Mapping ----------

/**
 * Map Commander's parsed options to NonInteractiveOptions.
 *
 * Commander auto-converts kebab-case flags to camelCase properties
 * (e.g., --gateway-port becomes options.gatewayPort), so this is
 * largely a passthrough with nonInteractive forced on.
 */
function buildNonInteractiveOptionsFromCommander(
  options: Record<string, unknown>,
): NonInteractiveOptions {
  return {
    nonInteractive: true,
    acceptRisk: !!options.acceptRisk,
    provider: options.provider as string | undefined,
    apiKey: options.apiKey as string | undefined,
    agentName: options.agentName as string | undefined,
    model: options.model as string | undefined,
    gatewayPort: options.gatewayPort as number | undefined,
    gatewayBind: options.gatewayBind as
      | "loopback"
      | "lan"
      | "custom"
      | undefined,
    gatewayToken: options.gatewayToken as string | undefined,
    channels: options.channels as string[] | undefined,
    telegramToken: options.telegramToken as string | undefined,
    discordToken: options.discordToken as string | undefined,
    slackBotToken: options.slackBotToken as string | undefined,
    slackAppToken: options.slackAppToken as string | undefined,
    lineToken: options.lineToken as string | undefined,
    lineSecret: options.lineSecret as string | undefined,
    imageProvider: options.imageProvider as string | undefined,
    imageApiKey: options.imageApiKey as string | undefined,
    videoProvider: options.videoProvider as string | undefined,
    videoApiKey: options.videoApiKey as string | undefined,
    dataDir: options.dataDir as string | undefined,
    configDir: options.configDir as string | undefined,
    storage: options.storage as "encrypted" | "file" | undefined,
    startDaemon: !!options.startDaemon,
    skipHealth: !!options.skipHealth,
    skipValidation: !!options.skipValidation,
    reset: !!options.reset,
    resetScope: options.resetScope as
      | "config"
      | "config+creds"
      | "full"
      | undefined,
    json: !!options.json,
    quick: !!options.quick,
  };
}

// ---------- Command Registration ----------

/**
 * Register the `init` command on the program.
 *
 * Supports three modes:
 * 1. Non-interactive (--non-interactive): all values from flags
 * 2. Interactive with TTY: step-by-step wizard
 * 3. Non-TTY without --non-interactive: helpful guidance message
 *
 * @param program - The root Commander program
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Interactive setup wizard for first-time configuration")
    // Mode flags
    .option("--non-interactive", "No prompts, all values from flags")
    .option("--accept-risk", "Acknowledge security notice")
    .option("--quick", "Skip flow selection, use QuickStart")
    .option("--json", "Output result as JSON")
    // Provider/credentials
    .option("--provider <id>", "LLM provider")
    .option("--api-key <key>", "Provider API key")
    .option("--agent-name <name>", "Agent identifier (default: comis-agent)")
    .option("--model <id>", "Model identifier")
    // Gateway
    .option("--gateway-port <n>", "Gateway port (default: 4766)", parseInt)
    .option(
      "--gateway-bind <mode>",
      "loopback|lan|custom (default: loopback)",
    )
    .option("--gateway-token <tok>", "Explicit gateway token")
    // Channels
    .option(
      "--channels <list>",
      "Comma-separated channel list",
      (v: string) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
    )
    .option("--telegram-token <tok>", "Telegram bot token")
    .option("--discord-token <tok>", "Discord bot token")
    .option("--slack-bot-token <tok>", "Slack bot token")
    .option("--slack-app-token <tok>", "Slack app token")
    .option("--line-token <tok>", "LINE channel token")
    .option("--line-secret <sec>", "LINE channel secret")
    // Media generation
    .option("--image-provider <id>", "Image generation provider: auto|fal|openai|openai-codex|google|openrouter")
    .option("--image-api-key <key>", "Image provider API key (e.g. FAL_KEY; reuses --api-key for a matching main provider)")
    .option("--video-provider <id>", "Video generation provider: auto|fal|google|xai")
    .option("--video-api-key <key>", "Video provider API key (e.g. FAL_KEY; reuses --api-key for a matching main provider)")
    // Paths
    .option("--data-dir <path>", "Workspace directory")
    .option("--config-dir <dir>", "Override config directory")
    // Credential storage
    .option("--storage <mode>", "encrypted|file (default: encrypted)")
    // Post-setup behavior
    .option("--start-daemon", "Auto-start daemon after config")
    .option("--skip-health", "Skip post-setup health check")
    .option("--skip-validation", "Skip API key validation")
    // Reset
    .option("--reset", "Reset existing config before setup")
    .option(
      "--reset-scope <scope>",
      "config|config+creds|full (default: config)",
    )
    .action(async (options: Record<string, unknown>) => {
      // ------------------------------------------------------------------
      // 1. Non-interactive mode
      // ------------------------------------------------------------------
      if (options.nonInteractive) {
        try {
          // Build NonInteractiveOptions from Commander parsed options
          const niOpts = buildNonInteractiveOptionsFromCommander(options);

          // Validate required flags
          validateNonInteractiveOptions(niOpts);

          // Build pre-populated state
          const initialState = buildNonInteractiveState(niOpts);

          // Create non-interactive prompter
          const prompter = new NonInteractivePrompter(
            niOpts,
            !!options.json,
          );

          // Determine flow
          const flow = niOpts.quick ? "quickstart" : "advanced";

          // Build step registry (all 14 steps)
          const steps = buildStepRegistry();

          // Run wizard flow -- steps already completed in initialState
          // will be skipped. Only write-config, daemon-start, and finish
          // actually execute.
          const finalState = await runWizardFlow(
            flow,
            prompter,
            steps,
            initialState,
          );

          // JSON output
          if (options.json) {
            const output = buildJsonOutput(finalState, {
              configDir: options.configDir as string | undefined,
            });
            process.stdout.write(
              JSON.stringify(output, null, 2) + "\n",
            );
          }
        } catch (err) {
          if (options.json) {
            const errMsg =
              err instanceof Error ? err.message : String(err);
            const field =
              err instanceof NonInteractiveError
                ? err.field
                : undefined;
            process.stdout.write(
              JSON.stringify(buildJsonError(errMsg, field), null, 2) +
                "\n",
            );
            process.exit(1);
          }
          console.error(
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }
        return;
      }

      // ------------------------------------------------------------------
      // 2. Non-TTY without --non-interactive: guide user
      // ------------------------------------------------------------------
      if (!process.stdin.isTTY) {
        console.error(
          "Init wizard requires an interactive terminal (TTY).\n" +
            "For non-interactive setup, use: comis init --non-interactive --accept-risk --provider <id> --api-key <key>\n" +
            "See: comis init --help",
        );
        process.exit(1);
      }

      // ------------------------------------------------------------------
      // 3. Interactive mode using new wizard architecture
      // ------------------------------------------------------------------
      const { createClackAdapter } = await import(
        "../wizard/clack-adapter.js"
      );
      const prompter = createClackAdapter();

      // Determine flow
      const flow = options.quick ? "quickstart" : "advanced";
      const steps = buildStepRegistry();

      // Build initial state from any applicable flags
      let initialState: WizardState | undefined;
      if (options.quick) {
        // --quick flag pre-sets flow without prompting
        initialState = {
          completedSteps: [] as readonly WizardStepId[],
          flow: "quickstart" as const,
        };
      }

      try {
        await runWizardFlow(
          flow as "quickstart" | "advanced",
          prompter,
          steps,
          initialState,
        );
        // Exit explicitly on success. The clack adapter holds process.stdin in
        // raw-mode (a TTY), which keeps the event loop alive — without this the
        // process hangs after the wizard's final message. Mirrors the cancel
        // and error paths, which already exit explicitly.
        process.exit(0);
      } catch (err) {
        if (err instanceof CancelError) {
          process.exit(0);
        }
        throw err;
      }
    });
}
