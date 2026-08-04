// SPDX-License-Identifier: Apache-2.0
/** Content-free terminal classifications shared by background-task producers and consumers. */
export type BackgroundTaskFailureCode =
  | "skill_import_incomplete"
  | "mcp_connection_details_missing"
  | "mcp_secret_reference_missing"
  | "mcp_call_deadline_exceeded"
  | "mutation_not_persisted";

/** Numbers-only context for a background terminal failure. */
export type BackgroundTaskFailureDiagnostic = {
  readonly kind: "mcp_call_deadline_exceeded";
  readonly configKey: "integrations.mcp.callToolTimeoutMs";
  readonly configuredMs: number;
  readonly queueWaitedMs: number;
  readonly requestBudgetMs: number;
};
