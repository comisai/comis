// SPDX-License-Identifier: Apache-2.0
/**
 * Best-effort writer for inline ROLE.md / IDENTITY.md content supplied via
 * the L2 single-call agents.create path (260428-vyf).
 *
 * Collapses the previous 3-call agent-creation workflow
 * (`agents_manage.create` -> `write(ROLE.md)` -> `write(IDENTITY.md)`)
 * into a single RPC by writing both files atomically as a side-effect of
 * the `agents.create` RPC. role/identity are write-once side-effects, NOT
 * durable state — they never enter the persisted config.yaml.
 *
 * Defense-in-depth posture:
 *  - Size limits enforced both at the TypeBox tool-param boundary
 *    (maxLength 16384/4096) AND here, so a caller bypassing the tool layer
 *    cannot push oversize content past the daemon.
 *  - safePath(workspaceDir, "ROLE.md"|"IDENTITY.md") guards against any
 *    workspaceDir whose computation could be poisoned upstream. The
 *    filename is HARDCODED, not derived from input — defense in depth.
 *  - Returns Result<T,E> on every code path (no thrown exceptions).
 *
 * @module
 */

import { writeFile } from "node:fs/promises";
import { safePath, PathTraversalError } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentInlineWorkspaceParams {
  /** Already-resolved workspace directory (via resolveWorkspaceDir). */
  workspaceDir: string;
  /** Agent identifier — used for structured logging. */
  agentId: string;
  /** Optional inline ROLE.md content. */
  role?: string;
  /** Optional inline IDENTITY.md content. */
  identity?: string;
}

export interface AgentInlineWorkspaceResult {
  roleWritten: boolean;
  identityWritten: boolean;
  bytesWritten: number;
}

export type AgentInlineWorkspaceError =
  | { kind: "oversize"; file: "ROLE.md" | "IDENTITY.md"; limit: number; actual: number }
  | { kind: "path_traversal"; file: "ROLE.md" | "IDENTITY.md"; message: string }
  | { kind: "io"; file: "ROLE.md" | "IDENTITY.md"; message: string };

export interface AgentInlineWorkspaceDeps {
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max ROLE.md inline content size (chars). Mirrored at the TypeBox layer. */
const ROLE_MAX = 16384;
/** Max IDENTITY.md inline content size (chars). Mirrored at the TypeBox layer. */
const IDENTITY_MAX = 4096;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve target path via safePath, catching PathTraversalError.
 * Returns Result so the caller can branch without try/catch on its own.
 */
function resolveTarget(
  workspaceDir: string,
  filename: "ROLE.md" | "IDENTITY.md",
): Result<string, AgentInlineWorkspaceError> {
  try {
    return ok(safePath(workspaceDir, filename));
  } catch (e: unknown) {
    if (e instanceof PathTraversalError) {
      return err({ kind: "path_traversal", file: filename, message: e.message });
    }
    // Unexpected non-traversal error from safePath — treat as IO surface;
    // the caller will WARN-log and the create RPC will still succeed.
    const message = e instanceof Error ? e.message : String(e);
    return err({ kind: "io", file: filename, message });
  }
}

/**
 * Attempt a single file write. fs.writeFile rejection -> structured WARN +
 * `{kind:"io"}` Result. Never throws.
 */
async function attemptWrite(
  deps: AgentInlineWorkspaceDeps,
  agentId: string,
  filename: "ROLE.md" | "IDENTITY.md",
  targetPath: string,
  content: string,
): Promise<Result<void, AgentInlineWorkspaceError>> {
  try {
    await writeFile(targetPath, content, { encoding: "utf8" });
    return ok(undefined);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    deps.logger.warn(
      {
        module: "daemon.rpc.agent-handlers",
        agentId,
        file: filename,
        err: e,
        hint: "Inline ROLE.md/IDENTITY.md write failed; agent exists with template files. User can call write() to customize.",
        errorKind: "resource" as const,
      },
      "Inline workspace file write failed",
    );
    return err({ kind: "io", file: filename, message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write inline ROLE.md / IDENTITY.md content to the agent's workspace
 * directory. Best-effort — the caller (`agents.create`) will surface a
 * Result-shaped outcome on the RPC return so the L1 tool can build the
 * appropriate next-step contract for the LLM.
 *
 * @param deps - Required structured logger.
 * @param params - workspaceDir + agentId + optional role/identity content.
 * @returns Result with per-file written flags + total byte count, or one
 *          of three structured error kinds (oversize | path_traversal | io).
 */
export async function writeInlineWorkspaceFiles(
  deps: AgentInlineWorkspaceDeps,
  params: AgentInlineWorkspaceParams,
): Promise<Result<AgentInlineWorkspaceResult, AgentInlineWorkspaceError>> {
  // Belt-and-braces size limits. Schema layer already enforces these, but
  // a caller that bypasses the tool (e.g. direct RPC) must still be gated.
  if (params.role !== undefined && params.role.length > ROLE_MAX) {
    return err({ kind: "oversize", file: "ROLE.md", limit: ROLE_MAX, actual: params.role.length });
  }
  if (params.identity !== undefined && params.identity.length > IDENTITY_MAX) {
    return err({
      kind: "oversize",
      file: "IDENTITY.md",
      limit: IDENTITY_MAX,
      actual: params.identity.length,
    });
  }

  let roleWritten = false;
  let identityWritten = false;
  let bytesWritten = 0;

  if (params.role !== undefined) {
    const targetResult = resolveTarget(params.workspaceDir, "ROLE.md");
    if (!targetResult.ok) return targetResult;
    const writeResult = await attemptWrite(
      deps,
      params.agentId,
      "ROLE.md",
      targetResult.value,
      params.role,
    );
    if (!writeResult.ok) return writeResult;
    roleWritten = true;
    bytesWritten += params.role.length;
  }

  if (params.identity !== undefined) {
    const targetResult = resolveTarget(params.workspaceDir, "IDENTITY.md");
    if (!targetResult.ok) return targetResult;
    const writeResult = await attemptWrite(
      deps,
      params.agentId,
      "IDENTITY.md",
      targetResult.value,
      params.identity,
    );
    if (!writeResult.ok) return writeResult;
    identityWritten = true;
    bytesWritten += params.identity.length;
  }

  // Emit canonical INFO log only when at least one file was written.
  // Pure no-op invocations (both fields absent) stay silent.
  if (roleWritten || identityWritten) {
    deps.logger.info(
      {
        module: "daemon.rpc.agent-handlers",
        agentId: params.agentId,
        roleBytes: roleWritten ? params.role!.length : 0,
        identityBytes: identityWritten ? params.identity!.length : 0,
        hint: "customized inline workspace ROLE.md+IDENTITY.md skips the post-create write() roundtrip",
      },
      "Wrote inline workspace files (ROLE.md + IDENTITY.md) on agents.create",
    );
  }

  return ok({ roleWritten, identityWritten, bytesWritten });
}
