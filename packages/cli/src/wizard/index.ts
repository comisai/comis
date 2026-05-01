// SPDX-License-Identifier: Apache-2.0
/**
 * Wizard module public API.
 *
 * Barrel file re-exporting all types, constants, classes, functions,
 * and validators that make up the init wizard. Consuming code (the
 * init command, tests, future phases) imports from this single entry
 * point rather than reaching into individual wizard files.
 *
 * Legacy wizard files (flow-types.ts, quickstart-flow.ts, manual-flow.ts,
 * config-writer.ts) were removed -- superseded by the step-based architecture.
 *
 * @module
 */

// ---------- Types ----------

export type {
  FlowType,
  WizardStepId,
  WizardState,
  WizardStep,
  WizardResult,
  WizardError,
  ValidationResult,
  AuthMethod,
  ChannelConfig,
  GatewayConfig,
  ProviderConfig,
  ToolProviderConfig,
  SupportedToolProvider,
} from "./types.js";

export {
  INITIAL_STATE,
  SUPPORTED_CHANNELS,
  SUPPORTED_TOOL_PROVIDERS,
  PROVIDER_ENV_KEYS,
  CHANNEL_ENV_KEYS,
  TOOL_PROVIDER_ENV_KEYS,
} from "./types.js";

// ---------- Prompter ----------

export type {
  WizardPrompter,
  SelectOpts,
  MultiselectOpts,
  TextOpts,
  PasswordOpts,
  ConfirmOpts,
  Spinner,
} from "./prompter.js";

export { CancelError } from "./prompter.js";

// ---------- Clack Adapter ----------

export { ClackAdapter, createClackAdapter } from "./clack-adapter.js";

// ---------- Theme ----------

export {
  COMIS_PALETTE,
  heading,
  sectionSeparator,
  success,
  warning,
  error,
  info,
  formatValidationError,
  brand,
} from "./theme.js";

// ---------- State Machine ----------

export {
  FLOW_STEPS,
  updateState,
  markStepComplete,
  jumpToStep,
  getNextStep,
  getStepIndex,
  isStepComplete,
  getCompletedStepCount,
  runWizardFlow,
} from "./state.js";

// ---------- Validators ----------

export { validateApiKey, getKeyPrefix } from "./validators/api-key.js";
export { validateAgentName } from "./validators/agent-name.js";
export { validatePort } from "./validators/port.js";
export { validateIpAddress, validateBindMode } from "./validators/network.js";
export {
  validateChannelCredential,
  getChannelCredentialTypes,
} from "./validators/channel-creds.js";

// ---------- Steps ----------

export { welcomeStep } from "./steps/00-welcome.js";
export { detectExistingStep } from "./steps/01-detect-existing.js";
export { flowSelectStep } from "./steps/02-flow-select.js";
export { providerStep } from "./steps/03-provider.js";
export { credentialsStep } from "./steps/04-credentials.js";
export { agentStep } from "./steps/05-agent.js";
export { channelsStep } from "./steps/06-channels.js";
export { gatewayStep } from "./steps/07-gateway.js";
export { workspaceStep } from "./steps/08-workspace.js";
export { toolProvidersStep } from "./steps/08b-tool-providers.js";
export { reviewStep } from "./steps/09-review.js";
export { writeConfigStep } from "./steps/10-write-config.js";
export { daemonStartStep } from "./steps/11-daemon-start.js";
export { finishStep } from "./steps/12-finish.js";

// ---------- JSON Output ----------

export type { InitJsonOutput } from "./json-output.js";
export { buildJsonOutput, buildJsonError } from "./json-output.js";

// ---------- Non-Interactive ----------

export type { NonInteractiveOptions } from "./non-interactive.js";
export {
  NonInteractiveError,
  validateNonInteractiveOptions,
  buildNonInteractiveState,
  NonInteractivePrompter,
} from "./non-interactive.js";
