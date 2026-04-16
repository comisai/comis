/**
 * Welcome step -- step 00 of the init wizard.
 *
 * Always runs first in every flow. Displays the branded Comis
 * intro banner, presents a security notice explaining agent
 * capabilities, and requires explicit user acknowledgement before
 * proceeding. Declining exits cleanly with no partial state.
 *
 * @module
 */

import type { WizardState, WizardStep, WizardPrompter } from "../index.js";
import { updateState, heading, CancelError } from "../index.js";

// ---------- Security Notice ----------

const SECURITY_NOTICE = `Comis agents can execute tools, read files, and interact
with external services on your behalf. You are responsible
for reviewing agent actions and configuring appropriate
safety guardrails.

Learn more: https://comis.dev/docs/security`;

// ---------- Step Implementation ----------

export const welcomeStep: WizardStep = {
  id: "welcome",
  label: "Welcome & Security",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    // Branded intro banner
    prompter.intro(heading("Comis Agent Setup"));

    // Welcome message
    prompter.note("Welcome! This wizard will set up your AI agent in a few steps.");

    // Security notice
    prompter.note(SECURITY_NOTICE, "Security Notice");

    // Risk acknowledgement -- must explicitly accept
    const accepted = await prompter.confirm({
      message: "I understand and accept responsibility for agent actions.",
      initialValue: false,
    });

    if (!accepted) {
      prompter.outro("Setup cancelled. You can re-run 'comis init' when ready.");
      throw new CancelError();
    }

    return updateState(state, { riskAccepted: true });
  },
};
