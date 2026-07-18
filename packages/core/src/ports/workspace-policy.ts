// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { WorkspacePolicySnapshot } from "../domain/workspace-policy.js";

export type WorkspacePolicyError =
  | { readonly kind: "agent_not_found"; readonly agentId: string }
  | { readonly kind: "snapshot_not_found"; readonly policyHash: string }
  | { readonly kind: "io"; readonly agentId: string; readonly fileName: string }
  | { readonly kind: "invalid_section"; readonly agentId: string; readonly fileName: string }
  | {
    readonly kind: "oversized_section";
    readonly agentId: string;
    readonly fileName: string;
    readonly actualChars: number;
    readonly maxChars: number;
  };

/** Loads one immutable, attributed workspace-policy snapshot for an agent turn. */
export interface WorkspacePolicyPort {
  load(agentId: string): Promise<Result<WorkspacePolicySnapshot, WorkspacePolicyError>>;
  /** Resolve the exact immutable snapshot previously loaded for a turn. */
  get(policyHash: string): Result<WorkspacePolicySnapshot, WorkspacePolicyError>;
}
