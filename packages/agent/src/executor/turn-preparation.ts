// SPDX-License-Identifier: Apache-2.0
import type {
  NormalizedMessage,
  ResolvedTurnScope,
  WorkspacePolicySnapshot,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type { ResolvedLocale } from "./resolve-response-locale-policy.js";

export type { ResolvedLocale } from "./resolve-response-locale-policy.js";

export interface ActiveCapabilitySnapshot {
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
  }[];
}

export interface AssembledConversationWindow {
  readonly history: readonly unknown[];
  readonly currentRequest: NormalizedMessage;
}

export interface RecallContext {
  readonly inlineMemory?: string;
  readonly memories: readonly {
    readonly id: string;
    readonly content: string;
  }[];
}

export interface SkillSection {
  readonly id: string;
  readonly content: string;
}

export interface ExternalContextSection {
  readonly id: string;
  readonly content: string;
}

export interface PreparedTurn {
  readonly scope: ResolvedTurnScope;
  readonly workspacePolicy: WorkspacePolicySnapshot;
  readonly capabilities: ActiveCapabilitySnapshot;
  readonly locale: ResolvedLocale;
  readonly conversation: AssembledConversationWindow;
  readonly recall: RecallContext;
  readonly selectedSkills: readonly SkillSection[];
  readonly externalInstructions: readonly ExternalContextSection[];
}

export type PreparedTurnError =
  | { readonly kind: "missing_scope" }
  | { readonly kind: "missing_workspace_policy" }
  | { readonly kind: "missing_capabilities" }
  | { readonly kind: "workspace_policy_failed"; readonly cause: unknown }
  | { readonly kind: "capability_capture_failed"; readonly cause: unknown }
  | { readonly kind: "conversation_assembly_failed"; readonly cause: unknown }
  | { readonly kind: "recall_selection_failed"; readonly cause: unknown };

export interface TurnPreparationResolvers {
  resolveWorkspacePolicy(): Promise<Result<WorkspacePolicySnapshot | undefined, unknown>>;
  captureCapabilities(): Result<ActiveCapabilitySnapshot | undefined, unknown>;
  assembleConversation(): Promise<Result<AssembledConversationWindow, unknown>>;
  selectRecall(): Promise<Result<RecallContext, unknown>>;
}

export interface PrepareTurnInput {
  readonly scope: ResolvedTurnScope | undefined;
  readonly locale: ResolvedLocale;
  readonly selectedSkills: readonly SkillSection[];
  readonly externalInstructions: readonly ExternalContextSection[];
  readonly resolvers: TurnPreparationResolvers;
}

/** Resolve the immutable inputs consumed by one model turn. */
export async function prepareTurn(
  input: PrepareTurnInput,
): Promise<Result<PreparedTurn, PreparedTurnError>> {
  if (input.scope === undefined) return err({ kind: "missing_scope" });

  const workspacePolicy = await input.resolvers.resolveWorkspacePolicy();
  if (!workspacePolicy.ok) {
    return err({ kind: "workspace_policy_failed", cause: workspacePolicy.error });
  }
  if (workspacePolicy.value === undefined) {
    return err({ kind: "missing_workspace_policy" });
  }

  const capabilities = input.resolvers.captureCapabilities();
  if (!capabilities.ok) {
    return err({ kind: "capability_capture_failed", cause: capabilities.error });
  }
  if (capabilities.value === undefined) {
    return err({ kind: "missing_capabilities" });
  }

  const conversation = await input.resolvers.assembleConversation();
  if (!conversation.ok) {
    return err({ kind: "conversation_assembly_failed", cause: conversation.error });
  }

  const recall = await input.resolvers.selectRecall();
  if (!recall.ok) {
    return err({ kind: "recall_selection_failed", cause: recall.error });
  }

  return ok({
    scope: input.scope,
    workspacePolicy: workspacePolicy.value,
    capabilities: capabilities.value,
    locale: input.locale,
    conversation: conversation.value,
    recall: recall.value,
    selectedSkills: input.selectedSkills,
    externalInstructions: input.externalInstructions,
  });
}

export interface ProviderNeutralModelRequest {
  readonly systemPrompt: string;
  readonly conversation: readonly unknown[];
  readonly capabilities: ActiveCapabilitySnapshot;
  readonly recall: RecallContext;
}

export type ModelRequestAssemblyError =
  | { readonly kind: "missing_current_request" };

/** Combine already-selected turn inputs without performing any new selection. */
export function assembleModelRequest(input: {
  readonly preparedTurn: PreparedTurn;
  readonly compiledPrompt: { readonly systemPrompt: string };
}): Result<ProviderNeutralModelRequest, ModelRequestAssemblyError> {
  const currentText = input.preparedTurn.conversation.currentRequest.text;
  if (currentText === undefined) return err({ kind: "missing_current_request" });

  return ok({
    systemPrompt: input.compiledPrompt.systemPrompt,
    conversation: [
      ...input.preparedTurn.conversation.history,
      { role: "user", content: currentText },
    ],
    capabilities: input.preparedTurn.capabilities,
    recall: input.preparedTurn.recall,
  });
}
