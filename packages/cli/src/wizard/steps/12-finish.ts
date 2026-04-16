/**
 * Finish step -- step 12 of the init wizard.
 *
 * Displays a quick-reference card with essential CLI commands,
 * gateway access info with WebSocket URL and token location,
 * offers shell completion setup, and ends with a branded outro.
 *
 * This is the user's last impression of the wizard -- clear, concise,
 * and immediately actionable.
 *
 * @module
 */

import type { WizardState, WizardStep, WizardPrompter } from "../index.js";
import { updateState, sectionSeparator, brand } from "../index.js";

// ---------- Helpers ----------

/**
 * Build the quick-reference card lines.
 *
 * Each command name is branded (steel blue), left-padded with 2 spaces,
 * and right-aligned for visual consistency.
 */
function buildReferenceCard(): string {
  const commands: [string, string][] = [
    ["Start daemon:", "comis daemon start"],
    ["Check status:", "comis status"],
    ["Add channels:", "comis configure --section channels"],
    ["Security audit:", "comis security audit"],
    ["Full diagnostics:", "comis doctor"],
    ["Get help:", "comis --help"],
  ];

  const lines = commands.map(
    ([label, cmd]) => `  ${label.padEnd(18)}${brand(cmd)}`,
  );
  return lines.join("\n");
}

/**
 * Build the gateway access info block from wizard state.
 *
 * Returns undefined if no gateway config exists.
 */
function buildGatewayInfo(state: WizardState): string | undefined {
  if (!state.gateway) return undefined;

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

  const wsLine = `  WebSocket:  ${brand(`ws://${host}:${state.gateway.port}/ws`)}`;

  let authLine: string;
  if (state.gateway.authMethod === "password") {
    authLine = "  Auth:       Password auth (in ~/.comis/.env)";
  } else {
    const tokenPreview = state.gateway.token
      ? `${state.gateway.token.slice(0, 8)}...`
      : "see file";
    authLine = `  Token:      ${tokenPreview} (in ~/.comis/.env)`;
  }

  const webLine = `  Web App:    ${brand(`http://${host}:${state.gateway.port}`)}`;

  return `${wsLine}\n${webLine}\n${authLine}`;
}

// ---------- Step Implementation ----------

export const finishStep: WizardStep = {
  id: "finish",
  label: "Finish",

  async execute(
    state: WizardState,
    prompter: WizardPrompter,
  ): Promise<WizardState> {
    // 1. Quick-reference card
    prompter.note(buildReferenceCard(), sectionSeparator("Quick Reference"));

    // 2. Gateway access info
    const gatewayInfo = buildGatewayInfo(state);
    if (gatewayInfo) {
      prompter.note(gatewayInfo, sectionSeparator("Gateway Access"));
    }

    // 3. Shell completion offer
    const wantCompletions = await prompter.confirm({
      message: "Enable shell completions for comis?",
      initialValue: true,
    });

    if (wantCompletions) {
      prompter.log.info(
        "Run 'comis --help' to see available commands including shell completion setup",
      );
    }

    // 4. Branded outro
    prompter.outro("Happy building! Run 'comis status' to see your system.");

    // 5. Return state unchanged -- wizard complete
    return updateState(state, {});
  },
};
