// SPDX-License-Identifier: Apache-2.0
/**
 * Tooling-Fill — operator UX for materializing description +
 * replacesPackages fields on tooling capability hints via the live
 * Comis daemon.
 *
 * Public API consumed by `packages/cli/src/commands/config.ts` (the
 * `comis config tooling-fill` sub-subcommand registered there). Mirrors
 * the `packages/cli/src/sync-tooling/index.ts` barrel pattern: single
 * import path for callers, public types co-located with the functions
 * that produce them.
 *
 * @module
 */

export {
  callAgent,
  type AgentCallArgs,
  type AgentCallError,
  type AgentCallErrorKind,
  type AgentCallResponse,
} from "./agent-call.js";

export {
  detectSupervisor,
  stopDaemon,
  startDaemon,
  MANUAL_RECIPE_HINT,
  type Supervisor,
  type SupervisorError,
  type SupervisorErrorKind,
} from "./supervisor.js";

export {
  buildFillPrompt,
  type FillPromptArgs,
  type FillKind as PromptFillKind,
} from "./prompt-template.js";

export {
  parseFillResponse,
  type ParsedFill,
  type ParseError,
  type ParseFailureReason,
} from "./response-parser.js";

export {
  PACKAGE_NAME_REGEX,
  validatePackageNames,
  isStubValued,
  type ValidatedPackages,
  type HintShape,
} from "./validators.js";

export {
  setHintFields,
  type ApplyHintError,
  type ApplyHintErrorKind,
  type HintFields,
  type FillKind,
} from "./apply-hint.js";

export {
  runToolingFill,
  type OrchestratorOpts,
  type OrchestratorResult,
  type PromptIO,
} from "./orchestrator.js";
