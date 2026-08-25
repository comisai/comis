// SPDX-License-Identifier: Apache-2.0
import type { WorkspacePolicyPort, WorkspacePolicySnapshot, WorkspacePolicyError } from "@comis/core";
import type { Result } from "@comis/shared";

export async function resolveCapturedWorkspacePolicy(
  port: WorkspacePolicyPort | undefined,
  agentId: string,
  policyHash: string,
): Promise<Result<WorkspacePolicySnapshot, WorkspacePolicyError> | undefined> {
  const cached = port?.get(policyHash);
  return cached?.ok === true ? cached : port?.load(agentId);
}
