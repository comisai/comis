/**
 * Review summary step -- step 09 of the init wizard.
 *
 * Displays a formatted summary of all configured values and offers
 * three options: confirm (proceed to write-config), edit (jump back
 * to a specific step), or cancel (clean exit via CancelError).
 *
 * The go-back feature uses the _jumpTo state machine mechanism.
 * The state machine runner processes the jump, clears downstream state,
 * and re-runs from the target step.
 *
 * This step does NOT write any files -- it only displays and navigates.
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardStepId,
  WizardPrompter,
} from "../index.js";
import {
  updateState,
  heading,
  CancelError,
} from "../index.js";

// ---------- Helpers ----------

/**
 * Build a formatted summary string from wizard state.
 *
 * Each section is conditionally included based on which state
 * fields have been populated by prior steps.
 */
function buildSummary(state: WizardState): string {
  const lines: string[] = [];

  // Provider section
  let providerLine = `Provider:   ${state.provider?.id ?? "not set"}`;
  if (state.provider?.customEndpoint) {
    providerLine += ` (${state.provider.customEndpoint})`;
  }
  lines.push(providerLine);
  lines.push(`Model:      ${state.model ?? "default"}`);

  // Agent section
  lines.push("");
  lines.push(`Agent:      ${state.agentName ?? "comis-agent"}`);

  // Gateway section
  if (state.gateway) {
    let bindAddress: string;
    switch (state.gateway.bindMode) {
      case "loopback":
        bindAddress = "127.0.0.1";
        break;
      case "lan":
        bindAddress = "0.0.0.0";
        break;
      case "custom":
        bindAddress = state.gateway.customIp ?? "127.0.0.1";
        break;
      default:
        bindAddress = "127.0.0.1";
    }
    lines.push("");
    lines.push(`Gateway:    ws://${bindAddress}:${state.gateway.port} (${state.gateway.authMethod} auth)`);
  }

  // Channels section
  if (state.channels && state.channels.length > 0) {
    const channelNames = state.channels.map((c) => {
      if (c.validated === false) {
        return `${c.type} (pending)`;
      }
      return c.type;
    });
    lines.push("");
    lines.push(`Channels:   ${channelNames.join(", ")}`);
  }

  // Sender trust section
  if (state.senderTrustEntries && state.senderTrustEntries.length > 0) {
    const ids = state.senderTrustEntries.map((e) => e.senderId);
    lines.push("");
    lines.push(`Admins:     ${ids.join(", ")}`);
  }

  // Tool providers section
  if (state.toolProviders && state.toolProviders.length > 0) {
    const names = state.toolProviders.map((tp) => tp.id);
    lines.push("");
    lines.push(`Tools:      ${names.join(", ")}`);
  }

  // Workspace section
  if (state.dataDir) {
    lines.push("");
    lines.push(`Workspace:  ${state.dataDir}`);
  }

  // Files to write section
  lines.push("");
  lines.push("Files to write:");
  lines.push("  ~/.comis/config.yaml");
  lines.push("  ~/.comis/.env");

  return lines.join("\n");
}

/**
 * Build the list of editable step options based on completed state.
 *
 * Only steps that have collected state are offered as jump targets.
 */
function buildEditOptions(state: WizardState): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [
    { value: "provider", label: "Provider & API key" },
    { value: "agent", label: "Agent name & model" },
  ];

  if (state.channels) {
    options.push({ value: "channels", label: "Channels" });
  }

  if (state.gateway) {
    options.push({ value: "gateway", label: "Gateway" });
  }

  if (state.toolProviders) {
    options.push({ value: "tool-providers", label: "Tool Providers" });
  }

  if (state.dataDir) {
    options.push({ value: "workspace", label: "Workspace" });
  }

  return options;
}

// ---------- Step Implementation ----------

export const reviewStep: WizardStep = {
  id: "review",
  label: "Review",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    // 1. Show review heading
    prompter.note(heading("Configuration Summary"));

    // 2. Display formatted summary
    const summary = buildSummary(state);
    prompter.note(summary, "Configuration Summary");

    // 3. Action prompt
    const action = await prompter.select<string>({
      message: "Create this configuration?",
      options: [
        { value: "confirm", label: "Yes, write files and continue" },
        { value: "edit", label: "Go back and edit" },
        { value: "cancel", label: "Cancel" },
      ],
    });

    // 4. Handle cancel
    if (action === "cancel") {
      throw new CancelError();
    }

    // 5. Handle edit (go-back)
    if (action === "edit") {
      const editOptions = buildEditOptions(state);

      const selectedStep = await prompter.select<string>({
        message: "Which section do you want to edit?",
        options: editOptions,
      });

      return updateState(state, { _jumpTo: selectedStep as WizardStepId });
    }

    // 6. Handle confirm -- proceed to write-config
    return updateState(state, {});
  },
};
