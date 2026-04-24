// SPDX-License-Identifier: Apache-2.0
/**
 * Finish step -- step 12 of the init wizard.
 *
 * Displays a quick-reference card with essential CLI commands,
 * gateway access info (URLs), the full access token with a secure-storage
 * warning, and -- when the gateway binds loopback-only -- a copy-paste SSH
 * tunnel recipe so non-technical users can open the dashboard from another
 * computer. Ends with a shell-completion offer and a branded outro.
 *
 * @module
 */

import type { GatewayConfig, WizardState, WizardStep, WizardPrompter } from "../index.js";
import { brand, info, sectionSeparator, updateState, warning } from "../index.js";

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

function resolveHost(gateway: GatewayConfig): string {
  switch (gateway.bindMode) {
    case "loopback":
      return "127.0.0.1";
    case "lan":
      return "0.0.0.0";
    case "custom":
      return gateway.customIp ?? "127.0.0.1";
  }
}

/**
 * URLs block — dashboard + websocket only. No auth hints here;
 * the token/password lives in its own block so the user sees it
 * as the thing to copy.
 */
function buildGatewayInfo(state: WizardState): string | undefined {
  if (!state.gateway) return undefined;

  const host = resolveHost(state.gateway);
  const { port } = state.gateway;

  const lines: string[] = [];
  if (state.gateway.webEnabled) {
    lines.push(`  Dashboard:  ${brand(`http://${host}:${port}/app/`)}`);
  }
  lines.push(`  WebSocket:  ${brand(`ws://${host}:${port}/ws`)}`);
  return lines.join("\n");
}

/**
 * Access token block — prints the full token on its own line so
 * copy-paste works cleanly, plus a prominent "keep secret" warning
 * and storage guidance. For password auth, points the user at the
 * password they already chose.
 */
function buildAccessTokenBlock(state: WizardState): string | undefined {
  if (!state.gateway) return undefined;

  if (state.gateway.authMethod === "password") {
    return [
      "You chose a password for gateway access.",
      "",
      info("Use the password you set earlier when the dashboard asks for it."),
      info("It is also stored in ~/.comis/.env — keep that file private."),
    ].join("\n");
  }

  if (!state.gateway.token) return undefined;

  return [
    "Copy this token now — you will need it to sign in to the dashboard:",
    "",
    `    ${brand(state.gateway.token)}`,
    "",
    warning("Keep it secret. Anyone with this token can control your agents."),
    info("Save it in a password manager (1Password, Bitwarden, Apple Passwords)."),
    info("It is also stored at ~/.comis/.env — keep that file private."),
  ].join("\n");
}

/**
 * SSH tunnel recipe — shown only when the gateway is loopback-only
 * and the dashboard is enabled. Walks the user through ssh -N -L
 * with a clear YOUR-SERVER placeholder and the localhost URL to
 * open on their laptop.
 */
function buildTunnelInstructions(state: WizardState): string | undefined {
  if (!state.gateway || !state.gateway.webEnabled) return undefined;
  if (state.gateway.bindMode !== "loopback") return undefined;

  const { port } = state.gateway;

  return [
    "Your dashboard is only reachable from this computer right now.",
    "To open it from your laptop, follow these steps one time:",
    "",
    `  ${brand("1.")} On your laptop, open a Terminal window and run:`,
    "",
    `       ${brand(`ssh -N -L ${port}:127.0.0.1:${port} root@YOUR-SERVER`)}`,
    "",
    `     Replace ${brand("YOUR-SERVER")} with this server's IP address or`,
    "     hostname (ask your hosting provider if you are not sure).",
    "     Leave that Terminal window open.",
    "",
    `  ${brand("2.")} In your laptop's web browser, open:`,
    "",
    `       ${brand(`http://localhost:${port}/app/`)}`,
    "",
    `  ${brand("3.")} Paste your access token when asked.`,
    "",
    info("When you are done, close the Terminal window to disconnect."),
  ].join("\n");
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

    // 2. Gateway URLs
    const gatewayInfo = buildGatewayInfo(state);
    if (gatewayInfo) {
      prompter.note(gatewayInfo, sectionSeparator("Gateway Access"));
    }

    // 3. Access token (or password pointer) — its own highlighted block
    const tokenBlock = buildAccessTokenBlock(state);
    if (tokenBlock) {
      prompter.note(tokenBlock, sectionSeparator("Your Access Token"));
    }

    // 4. Copy-paste SSH tunnel recipe (loopback only)
    const tunnelBlock = buildTunnelInstructions(state);
    if (tunnelBlock) {
      prompter.note(tunnelBlock, sectionSeparator("Open the Dashboard from Another Computer"));
    }

    // 5. Shell completion offer
    const wantCompletions = await prompter.confirm({
      message: "Enable shell completions for comis?",
      initialValue: true,
    });

    if (wantCompletions) {
      prompter.log.info(
        "Run 'comis --help' to see available commands including shell completion setup",
      );
    }

    // 6. Branded outro
    prompter.outro("Happy building! Run 'comis status' to see your system.");

    // 7. Return state unchanged -- wizard complete
    return updateState(state, {});
  },
};
