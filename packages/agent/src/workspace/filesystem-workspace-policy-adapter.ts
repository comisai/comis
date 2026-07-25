// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import {
  AGENT_STATE_FILES,
  OPERATOR_OWNED_FILES,
  WORKSPACE_FILE_NAMES,
  isUntouchedWorkspaceTemplate,
  computeWorkspacePolicyCombinedHash,
  hashWorkspacePolicyContent,
  parseWorkspacePolicySnapshot,
  safePath,
  type InstructionSection,
  type WorkspaceFileName,
  type WorkspacePolicyError,
  type WorkspacePolicyPort,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const MAX_WORKSPACE_SECTION_CHARS = 20_000;
const operatorOwned = new Set<WorkspaceFileName>(OPERATOR_OWNED_FILES);
const agentState = new Set<WorkspaceFileName>(AGENT_STATE_FILES);

export interface FilesystemWorkspacePolicyAdapterDeps {
  resolveWorkspaceDir(agentId: string): string | undefined;
}

function sectionId(fileName: WorkspaceFileName): string {
  return `workspace:${fileName.slice(0, -3).toLowerCase()}`;
}

function isMissingFile(error: Error): boolean {
  return (error as Error & { code?: string }).code === "ENOENT";
}

function toSection(
  agentId: string,
  fileName: WorkspaceFileName,
  content: string,
): Result<InstructionSection, WorkspacePolicyError> {
  if (content.length > MAX_WORKSPACE_SECTION_CHARS) {
    return err({
      kind: "oversized_section",
      agentId,
      fileName,
      actualChars: content.length,
      maxChars: MAX_WORKSPACE_SECTION_CHARS,
    });
  }

  if (operatorOwned.has(fileName)) {
    return ok({
      id: sectionId(fileName),
      sourceKind: "operator",
      trust: "trusted",
      stability: "stable",
      content,
      contentHash: hashWorkspacePolicyContent(content),
      maxChars: MAX_WORKSPACE_SECTION_CHARS,
    });
  }

  if (agentState.has(fileName)) {
    return ok({
      id: sectionId(fileName),
      sourceKind: "agent_state",
      trust: "untrusted",
      stability: "turn",
      content,
      contentHash: hashWorkspacePolicyContent(content),
      maxChars: MAX_WORKSPACE_SECTION_CHARS,
    });
  }

  return err({ kind: "invalid_section", agentId, fileName });
}

async function loadSnapshot(
  deps: FilesystemWorkspacePolicyAdapterDeps,
  agentId: string,
): Promise<Result<WorkspacePolicySnapshot, WorkspacePolicyError>> {
  const workspaceDir = deps.resolveWorkspaceDir(agentId);
  if (!workspaceDir) {
    return err({ kind: "agent_not_found", agentId });
  }

  const sections: InstructionSection[] = [];
  for (const fileName of WORKSPACE_FILE_NAMES) {
    const pathResult = tryCatch(() => safePath(workspaceDir, fileName));
    if (!pathResult.ok) {
      return err({ kind: "invalid_section", agentId, fileName });
    }

    const readResult = await fromPromise(fs.readFile(pathResult.value, "utf-8"));
    if (!readResult.ok) {
      if (isMissingFile(readResult.error)) {
        continue;
      }
      return err({ kind: "io", agentId, fileName });
    }
    if (isUntouchedWorkspaceTemplate(fileName, readResult.value)) {
      continue;
    }

    const sectionResult = toSection(agentId, fileName, readResult.value);
    if (!sectionResult.ok) {
      return sectionResult;
    }
    sections.push(sectionResult.value);
  }

  const combinedHash = computeWorkspacePolicyCombinedHash(sections);
  const parsed = parseWorkspacePolicySnapshot({ agentId, sections, combinedHash });
  if (!parsed.ok) {
    return err({ kind: "invalid_section", agentId, fileName: "<snapshot>" });
  }
  return ok(parsed.value);
}

export function createFilesystemWorkspacePolicyAdapter(
  deps: FilesystemWorkspacePolicyAdapterDeps,
): WorkspacePolicyPort {
  const snapshots = new Map<string, WorkspacePolicySnapshot>();
  return {
    async load(agentId) {
      const result = await loadSnapshot(deps, agentId);
      if (result.ok) snapshots.set(result.value.combinedHash, result.value);
      return result;
    },
    get(policyHash) {
      const snapshot = snapshots.get(policyHash);
      return snapshot === undefined
        ? err({ kind: "snapshot_not_found", policyHash })
        : ok(snapshot);
    },
  };
}
