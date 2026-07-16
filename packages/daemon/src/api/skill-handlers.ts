// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Skill management RPC handler methods.
 * Covers:
 *   skills.list    -- List prompt skill descriptions for an agent
 *   skills.upload  -- Create a skill folder from uploaded files
 *   skills.import  -- Import a skill from a GitHub directory URL
 *   skills.delete  -- Remove a skill folder
 *   skills.create  -- Create a new skill from SKILL.md content
 *   skills.update  -- Update an existing skill's content
 *
 * Uses the `@comis/core` contract registry. Method keys are
 * computed-property names (`[SkillsListContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/workspace.ts` (the workspace umbrella
 * file groups all 5 handlers that share the `WorkspaceApiDeps` slice).
 * The dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)`.
 *
 * Two of the 6 methods (`skills.create` + `skills.update`) are NOT
 * registered in setup-gateway-api.ts (gateway-tool / agent-tool
 * dispatch path only). The bidirectional 1:1 architecture test walks
 * handler-factory PropertyAssignment keys (registration-plane-agnostic)
 * so contracts exist for all 6. The contract scope `["admin"]`
 * documents the intended trust model regardless of registration plane
 * (the create/update handlers gate destructive writes to the
 * shared-skills directory via the `defaultAgentId` check).
 *
 * The bespoke pre-Zod validation (skill-name format, content scan,
 * shared-scope default-agent guard, SKILL.md presence, no-overwrite
 * guard) is intentionally retained for user-friendly error UX. The
 * contract parse runs AFTER and serves as type narrowing +
 * defense-in-depth.
 *
 * Note: the handler accepts `_agentId` (from internals) as a fallback
 * for `agentId`. After `stripInternalFields(rawParams)` removes
 * `_agentId`, the fallback must resolve from the RAW params BEFORE the
 * strip step — `_agentId` is read from `rawParams` and threaded
 * through as the calling-agent identity.
 * @module
 */

import { scanSkillContent } from "@comis/skills";
import {
  safePath,
  SkillsListContract,
  SkillsUploadContract,
  SkillsImportContract,
  SkillsDeleteContract,
  SkillsCreateContract,
  SkillsUpdateContract,
  stripInternalFields,
  requireCapability,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import { createLogger } from "@comis/infra";
import { rmSync, existsSync } from "node:fs";
import type { RpcHandler } from "./types.js";
import { runBundleInstallHook } from "../skills/bundle-install-helper.js";

const logger = createLogger({ name: "skill-handlers" });

/** Skill name validation regex: lowercase alphanumeric + hyphens, 1-64 chars. */
const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/**
 * Parse a GitHub directory URL into API-friendly parts.
 * Accepts: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 */
function parseGitHubDirUrl(url: string): { owner: string; repo: string; branch: string; path: string } | null {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], path: m[4].replace(/\/$/, "") };
}

// Bounded GitHub Contents API walk (depth, file count, timeout) lives
// in `./github-skill-fetch.ts` so this file stays under the 800-line cap.
import { fetchGitHubDir } from "./github-skill-fetch.js";

// Single source of truth: WorkspaceApiDeps (shared with workspace, browser,
// approval, mcp, notification handlers).
import type { WorkspaceApiDeps as SkillHandlerDeps } from "./types.js";
import { AuthorizationError } from "./errors.js";
export type { SkillHandlerDeps };

/**
 * Resolve the calling-agent identity from RAW params (the dispatcher
 * injects `_agentId` as an internal field; `params.agentId` is the
 * user-facing fallback). Reads BEFORE stripInternalFields removes
 * `_agentId` from the strip output.
 */
function resolveCallingAgentId(rawParams: Record<string, unknown>): string | undefined {
  if (typeof rawParams.agentId === "string") return rawParams.agentId;
  if (typeof rawParams._agentId === "string") return rawParams._agentId;
  return undefined;
}

/**
 * Create skill management RPC handlers.
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createSkillHandlers(deps: SkillHandlerDeps): Record<string, RpcHandler> {
  return {
    [SkillsListContract.method]: async (rawParams) => {
      if (!deps.skillRegistries || deps.skillRegistries.size === 0) {
        const empty = { skills: [] };
        if (IS_DEV) SkillsListContract.response.parse(empty);
        return empty;
      }

      // Resolve agentId from RAW params (covers the _agentId fallback path)
      const agentId = resolveCallingAgentId(rawParams);

      const userParams = stripInternalFields(rawParams);
      SkillsListContract.request.parse(userParams);

      // If agentId specified, return skills for that agent only
      if (agentId) {
        const registry = deps.skillRegistries.get(agentId);
        if (!registry) {
          const empty = { skills: [] };
          if (IS_DEV) SkillsListContract.response.parse(empty);
          return empty;
        }
        const result = { skills: registry.getPromptSkillDescriptions() };
        if (IS_DEV) SkillsListContract.response.parse(result);
        return result;
      }

      // Default: return skills from the default agent's registry (deterministic fallback)
      const fallbackRegistry = deps.defaultAgentId
        ? deps.skillRegistries.get(deps.defaultAgentId) ?? deps.skillRegistries.values().next().value
        : deps.skillRegistries.values().next().value;
      if (!fallbackRegistry) {
        const empty = { skills: [] };
        if (IS_DEV) SkillsListContract.response.parse(empty);
        return empty;
      }
      const result = { skills: fallbackRegistry.getPromptSkillDescriptions() };
      if (IS_DEV) SkillsListContract.response.parse(result);
      return result;
    },

    [SkillsUploadContract.method]: async (rawParams) => {
      // In-process capability gate — the agent loop skips
      // checkScope, so orch:skill is enforced here, reading the injected
      // _capabilities from raw params BEFORE the strip.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:skill");

      // Resolve calling agent from RAW params (covers _agentId fallback)
      const callingAgentId = resolveCallingAgentId(rawParams);

      const userParams = stripInternalFields(rawParams);
      const params = SkillsUploadContract.request.parse(userParams);

      const scope = params.scope === "shared" ? "shared" : "local";

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations. Provide agentId or call via agent tool.");
      }

      // Validate skill folder name (bespoke for user-friendly error)
      if (
        !params.name ||
        params.name.length > 64 ||
        !SKILL_NAME_RE.test(params.name) ||
        params.name.includes("--")
      ) {
        throw new Error("Invalid skill name: must be 1-64 chars, lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens");
      }

      // Must have at least one file
      if (params.files.length === 0) {
        throw new Error("No files provided");
      }

      // Must include a SKILL.md
      const hasSkillMd = params.files.some((f) => {
        const segments = typeof f.path === "string" ? f.path.split("/") : [];
        // The file's relative path within the skill folder -- accept SKILL.md at root of the folder
        const filename = segments[segments.length - 1];
        return filename === "SKILL.md";
      });
      if (!hasSkillMd) {
        throw new Error("Skill folder must contain a SKILL.md file");
      }

      // Scope-based path resolution
      const dataDir = deps.container.config.dataDir || ".";
      let skillsBaseDir: string;

      if (scope === "shared") {
        // GUARD: Only the default agent may write to shared skills
        if (callingAgentId !== deps.defaultAgentId) {
          throw new AuthorizationError(
            `Only the default agent ("${deps.defaultAgentId}") can manage shared skills. ` +
            `Agent "${callingAgentId}" must use scope: "local" to manage its own skills.`
          );
        }
        skillsBaseDir = safePath(dataDir, "skills");
      } else {
        // Default: agent's own workspace skills directory
        const wsDir = deps.workspaceDirs?.get(callingAgentId);
        if (!wsDir) {
          throw new Error(`No workspace directory found for agent: ${callingAgentId}`);
        }
        skillsBaseDir = safePath(wsDir, "skills");
      }

      const skillDir = safePath(skillsBaseDir, params.name);

      // Prevent overwrite of existing skill
      if (existsSync(skillDir)) {
        throw new Error(`Skill directory already exists: ${params.name}`);
      }

      // Route skill-folder dir creation + per-file writes
      // through the shared fs-safe substrate so every artifact honors
      // the §1.4 `0o700`/`0o600` invariant. `confinedBaseDir` is the
      // scope-resolved `skillsBaseDir` (either `dataDir/skills` for
      // shared or `wsDir/skills` for local) — the operation-specific
      // confinement bound that already exists on disk by construction.
      // Result.err propagates to the gateway via thrown Error (file
      // header @allow-throw notes that all throws here are caught +
      // converted to JSON-RPC error responses by rpc-dispatch.ts).
      const skillDirResult = ensureContainedDir({
        dir: skillDir,
        mode: 0o700,
        confinedBaseDir: skillsBaseDir,
      });
      if (!skillDirResult.ok) {
        logger.warn(
          {
            err: skillDirResult.error,
            skillName: params.name,
            agentId: callingAgentId,
            hint: "Skill directory creation rejected by fs-safe substrate; check parent dir mode / symlink",
            errorKind: "resource" as const,
          },
          "Skill upload dir creation failed",
        );
        throw new Error(`Skill directory creation failed: ${skillDirResult.error.message}`);
      }

      // Write each file
      for (const file of params.files) {
        if (typeof file.path !== "string" || typeof file.content !== "string") continue;
        // file.path is relative within the skill folder (e.g. "SKILL.md" or "examples/foo.md")
        const filePath = safePath(skillDir, file.path);
        // Ensure parent directory exists for nested files
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (parentDir && !existsSync(parentDir)) {
          const parentDirResult = ensureContainedDir({
            dir: parentDir,
            mode: 0o700,
            confinedBaseDir: skillsBaseDir,
          });
          if (!parentDirResult.ok) {
            logger.warn(
              {
                err: parentDirResult.error,
                skillName: params.name,
                agentId: callingAgentId,
                hint: "Nested parent dir creation rejected by fs-safe substrate",
                errorKind: "resource" as const,
              },
              "Skill upload nested parent dir creation failed",
            );
            throw new Error(`Skill nested parent dir creation failed: ${parentDirResult.error.message}`);
          }
        }
        const writeResult = writeRegularFile({
          path: filePath,
          content: file.content,
          confinedBaseDir: skillsBaseDir,
        });
        if (!writeResult.ok) {
          logger.warn(
            {
              err: writeResult.error,
              skillName: params.name,
              agentId: callingAgentId,
              hint: "Skill file write rejected by fs-safe substrate",
              errorKind: "resource" as const,
            },
            "Skill upload file write failed",
          );
          throw new Error(`Skill file write failed: ${writeResult.error.message}`);
        }
      }

      // Scope-aware re-discovery
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) {
          registry.init();
        }
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }
      await runBundleInstallHook(deps, params.name, skillDir, rawParams);

      const result = { ok: true as const, path: skillDir };
      if (IS_DEV) SkillsUploadContract.response.parse(result);
      return result;
    },

    [SkillsImportContract.method]: async (rawParams) => {
      // In-process capability gate (see skills.upload).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:skill");

      const callingAgentId = resolveCallingAgentId(rawParams);

      const userParams = stripInternalFields(rawParams);
      const params = SkillsImportContract.request.parse(userParams);

      const url = params.url.trim();
      const scope = params.scope === "shared" ? "shared" : "local";

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations. Provide agentId or call via agent tool.");
      }

      // Scope guard: fail fast before expensive network fetch
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new AuthorizationError(
          `Only the default agent ("${deps.defaultAgentId}") can manage shared skills. ` +
          `Agent "${callingAgentId}" must use scope: "local" to manage its own skills.`
        );
      }

      if (!url) {
        throw new Error("URL is required");
      }

      // Parse GitHub URL
      const parsed = parseGitHubDirUrl(url);
      if (!parsed) {
        throw new Error("Invalid GitHub URL. Expected: https://github.com/{owner}/{repo}/tree/{branch}/{path}");
      }

      // Derive skill name from the last path segment
      const segments = parsed.path.split("/").filter(Boolean);
      const name = segments[segments.length - 1];
      if (!name || name.length > 64 || !SKILL_NAME_RE.test(name) || name.includes("--")) {
        throw new Error(`Invalid skill name derived from URL: "${name}". Must be lowercase alphanumeric with hyphens.`);
      }

      // Fetch all files from the GitHub directory
      const fetchedFiles = await fetchGitHubDir(parsed.owner, parsed.repo, parsed.path, parsed.branch);
      if (fetchedFiles.length === 0) {
        throw new Error("No files found at the given URL");
      }

      // Must include a SKILL.md
      const hasSkillMd = fetchedFiles.some((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"));
      if (!hasSkillMd) {
        throw new Error("Repository folder must contain a SKILL.md file");
      }

      // Scope-based path resolution
      const dataDir = deps.container.config.dataDir || ".";
      let skillsBaseDir: string;

      if (scope === "shared") {
        skillsBaseDir = safePath(dataDir, "skills");
      } else {
        // Default: agent's own workspace skills directory
        const wsDir = deps.workspaceDirs?.get(callingAgentId);
        if (!wsDir) {
          throw new Error(`No workspace directory found for agent: ${callingAgentId}`);
        }
        skillsBaseDir = safePath(wsDir, "skills");
      }

      const skillDir = safePath(skillsBaseDir, name);

      // Prevent overwrite
      if (existsSync(skillDir)) {
        throw new Error(`Skill directory already exists: ${name}`);
      }

      // Route skill-folder dir creation + per-file writes
      // through the shared fs-safe substrate so every artifact honors
      // the §1.4 `0o700`/`0o600` invariant. Mirrors the skills.upload
      // migration; same scope-resolved `skillsBaseDir` confinement bound.
      const skillDirResult = ensureContainedDir({
        dir: skillDir,
        mode: 0o700,
        confinedBaseDir: skillsBaseDir,
      });
      if (!skillDirResult.ok) {
        logger.warn(
          {
            err: skillDirResult.error,
            skillName: name,
            agentId: callingAgentId,
            hint: "Imported skill dir creation rejected by fs-safe substrate; check parent dir mode / symlink",
            errorKind: "resource" as const,
          },
          "Skill import dir creation failed",
        );
        throw new Error(`Skill directory creation failed: ${skillDirResult.error.message}`);
      }
      for (const file of fetchedFiles) {
        const filePath = safePath(skillDir, file.path);
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (parentDir && !existsSync(parentDir)) {
          const parentDirResult = ensureContainedDir({
            dir: parentDir,
            mode: 0o700,
            confinedBaseDir: skillsBaseDir,
          });
          if (!parentDirResult.ok) {
            logger.warn(
              {
                err: parentDirResult.error,
                skillName: name,
                agentId: callingAgentId,
                hint: "Nested parent dir creation rejected by fs-safe substrate",
                errorKind: "resource" as const,
              },
              "Skill import nested parent dir creation failed",
            );
            throw new Error(`Skill nested parent dir creation failed: ${parentDirResult.error.message}`);
          }
        }
        const writeResult = writeRegularFile({
          path: filePath,
          content: file.content,
          confinedBaseDir: skillsBaseDir,
        });
        if (!writeResult.ok) {
          logger.warn(
            {
              err: writeResult.error,
              skillName: name,
              agentId: callingAgentId,
              hint: "Imported skill file write rejected by fs-safe substrate",
              errorKind: "resource" as const,
            },
            "Skill import file write failed",
          );
          throw new Error(`Skill file write failed: ${writeResult.error.message}`);
        }
      }

      // Scope-aware re-discovery
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) {
          registry.init();
        }
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }
      await runBundleInstallHook(deps, name, skillDir, rawParams);

      const result = { ok: true as const, path: skillDir, name, fileCount: fetchedFiles.length };
      if (IS_DEV) SkillsImportContract.response.parse(result);
      return result;
    },

    [SkillsDeleteContract.method]: async (rawParams) => {
      // In-process capability gate (see skills.upload).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:skill");

      const callingAgentId = resolveCallingAgentId(rawParams);

      const userParams = stripInternalFields(rawParams);
      const params = SkillsDeleteContract.request.parse(userParams);

      const scope = params.scope === "shared" ? "shared" : "local";

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations. Provide agentId or call via agent tool.");
      }

      // Validate name
      if (!params.name || params.name.length > 64 || !SKILL_NAME_RE.test(params.name) || params.name.includes("--")) {
        throw new Error("Invalid skill name");
      }

      // Scope guard: only the default agent may delete shared skills
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new AuthorizationError(
          `Only the default agent ("${deps.defaultAgentId}") can manage shared skills. ` +
          `Agent "${callingAgentId}" must use scope: "local" to manage its own skills.`
        );
      }

      // Resolve registry using callingAgentId
      const registry = deps.skillRegistries?.get(callingAgentId);
      if (!registry) {
        throw new Error("Skill registry not found for agent");
      }

      // Look up skill in registry descriptions
      const descriptions = registry.getPromptSkillDescriptions();
      const skill = descriptions.find((s) => s.name === params.name);
      if (!skill) {
        throw new Error(`Skill not found: ${params.name}`);
      }

      // Determine allowed base directories for deletion
      const dataDir = deps.container.config.dataDir || ".";
      const sharedSkillsDir = safePath(dataDir, "skills");
      const wsDir = deps.workspaceDirs?.get(callingAgentId);
      const agentSkillsDir = wsDir ? safePath(wsDir, "skills") : undefined;

      // Fix: trailing separator for proper containment check
      const sharedPrefix = sharedSkillsDir + "/";
      const agentPrefix = agentSkillsDir ? agentSkillsDir + "/" : undefined;

      const isInShared = skill.location === sharedSkillsDir || skill.location.startsWith(sharedPrefix);
      const isInAgent = agentPrefix && (skill.location === agentSkillsDir || skill.location.startsWith(agentPrefix));

      // Scope-aware delete validation
      if (scope === "shared") {
        if (!isInShared) {
          throw new Error("Skill is not in the shared skills directory");
        }
      } else {
        // scope: "local" -- must be in agent's own workspace
        if (!isInAgent) {
          throw new Error(
            `Skill "${params.name}" is not in this agent's workspace skills directory. ` +
            'Use scope: "shared" to manage shared skills (default agent only).'
          );
        }
      }

      // Use the skill's actual location (directory name may differ from skill name)
      const skillDir = skill.location;

      // Remove skill directory
      rmSync(skillDir, { recursive: true, force: true });

      // Scope-aware re-discovery
      if (scope === "shared" && deps.skillRegistries) {
        for (const reg of deps.skillRegistries.values()) {
          reg.init();
        }
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }

      const result = { ok: true as const };
      if (IS_DEV) SkillsDeleteContract.response.parse(result);
      return result;
    },

    [SkillsCreateContract.method]: async (rawParams) => {
      // In-process capability gate (see skills.upload).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:skill");

      const callingAgentId = resolveCallingAgentId(rawParams);

      const userParams = stripInternalFields(rawParams);
      const params = SkillsCreateContract.request.parse(userParams);

      const scope = params.scope === "shared" ? "shared" : "local";

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations.");
      }

      // Validate skill name
      if (!params.name || params.name.length > 64 || !SKILL_NAME_RE.test(params.name) || params.name.includes("--")) {
        logger.warn({ skillName: params.name || "(empty)", agentId: callingAgentId, hint: "Skill name must be 1-64 chars, lowercase alphanumeric with single hyphens", errorKind: "validation" as const }, "Skill create rejected: invalid name");
        deps.eventBus?.emit("skill:failed", { skillName: params.name || "(empty)", error: "Invalid skill name", phase: "create", agentId: callingAgentId, timestamp: systemNowMs() });
        throw new Error("Invalid skill name: must be 1-64 chars, lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens");
      }

      if (!params.content) {
        throw new Error("Content is required for create action. Provide full SKILL.md content.");
      }

      // Security scan before write
      const scanResult = scanSkillContent(params.content);
      if (!scanResult.clean) {
        const criticalFindings = scanResult.findings.filter((f) => f.severity === "CRITICAL");
        if (criticalFindings.length > 0) {
          const summary = criticalFindings.map((f) => f.description).join("; ");
          logger.warn({ skillName: params.name, agentId: callingAgentId, scanSummary: summary, hint: "Remove injection patterns, crypto mining, or obfuscated content from skill body", errorKind: "validation" as const }, "Skill create rejected: content scan failed");
          deps.eventBus?.emit("skill:failed", { skillName: params.name, error: `Content scan failed: ${summary}`, phase: "scan", agentId: callingAgentId, timestamp: systemNowMs() });
          throw new Error(`Skill content rejected by security scan: ${summary}`);
        }
      }

      // Scope guard
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new Error(`Only the default agent ("${deps.defaultAgentId}") can manage shared skills. Agent "${callingAgentId}" must use scope: "local".`);
      }

      // Resolve scope directory (reuse existing pattern from skills.upload)
      const dataDir = deps.container.config.dataDir || ".";
      let skillsBaseDir: string;
      if (scope === "shared") {
        skillsBaseDir = safePath(dataDir, "skills");
      } else {
        const wsDir = deps.workspaceDirs?.get(callingAgentId);
        if (!wsDir) throw new Error(`No workspace directory found for agent: ${callingAgentId}`);
        skillsBaseDir = safePath(wsDir, "skills");
      }

      const skillDir = safePath(skillsBaseDir, params.name);

      // Prevent overwrite
      if (existsSync(skillDir)) {
        throw new Error(`Skill directory already exists: ${params.name}. Use update action to modify existing skills.`);
      }

      // Route skill-dir creation + SKILL.md write through
      // the shared fs-safe substrate so the new skill folder honors the
      // §1.4 `0o700`/`0o600` invariant. Result.err propagates via thrown
      // Error per the file's @allow-throw header.
      const skillDirResult = ensureContainedDir({
        dir: skillDir,
        mode: 0o700,
        confinedBaseDir: skillsBaseDir,
      });
      if (!skillDirResult.ok) {
        logger.warn(
          {
            err: skillDirResult.error,
            skillName: params.name,
            agentId: callingAgentId,
            hint: "Skill dir creation rejected by fs-safe substrate; check parent dir mode / symlink",
            errorKind: "resource" as const,
          },
          "Skill create dir creation failed",
        );
        throw new Error(`Skill directory creation failed: ${skillDirResult.error.message}`);
      }
      const skillMdPath = safePath(skillDir, "SKILL.md");
      const writeResult = writeRegularFile({
        path: skillMdPath,
        content: params.content,
        confinedBaseDir: skillsBaseDir,
      });
      if (!writeResult.ok) {
        logger.warn(
          {
            err: writeResult.error,
            skillName: params.name,
            agentId: callingAgentId,
            hint: "Skill SKILL.md write rejected by fs-safe substrate",
            errorKind: "resource" as const,
          },
          "Skill create file write failed",
        );
        throw new Error(`Skill file write failed: ${writeResult.error.message}`);
      }

      // Re-discover (triggers emitSkillAudit -> audit:event lifecycle capture)
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) registry.init();
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }
      await runBundleInstallHook(deps, params.name, skillDir, rawParams);

      const result = { ok: true as const, path: skillDir, name: params.name };
      if (IS_DEV) SkillsCreateContract.response.parse(result);
      return result;
    },

    [SkillsUpdateContract.method]: async (rawParams) => {
      // In-process capability gate (see skills.upload).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:skill");

      const callingAgentId = resolveCallingAgentId(rawParams);

      const userParams = stripInternalFields(rawParams);
      const params = SkillsUpdateContract.request.parse(userParams);

      const scope = params.scope === "shared" ? "shared" : "local";

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations.");
      }

      // Validate name
      if (!params.name || params.name.length > 64 || !SKILL_NAME_RE.test(params.name) || params.name.includes("--")) {
        logger.warn({ skillName: params.name || "(empty)", agentId: callingAgentId, hint: "Skill name must be 1-64 chars, lowercase alphanumeric with single hyphens", errorKind: "validation" as const }, "Skill update rejected: invalid name");
        throw new Error("Invalid skill name");
      }

      if (!params.content) {
        throw new Error("Content is required for update action.");
      }

      // Resolve registry and validate skill exists
      const registry = deps.skillRegistries?.get(callingAgentId);
      if (!registry) throw new Error("Skill registry not found for agent");

      const descriptions = registry.getPromptSkillDescriptions();
      const skill = descriptions.find((s) => s.name === params.name);
      if (!skill) throw new Error(`Skill not found: ${params.name}`);

      // Scope guard
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new Error(`Only the default agent ("${deps.defaultAgentId}") can manage shared skills. Agent "${callingAgentId}" must use scope: "local".`);
      }

      // Security scan before write
      const scanResult = scanSkillContent(params.content);
      if (!scanResult.clean) {
        const criticalFindings = scanResult.findings.filter((f) => f.severity === "CRITICAL");
        if (criticalFindings.length > 0) {
          const summary = criticalFindings.map((f) => f.description).join("; ");
          logger.warn({ skillName: params.name, agentId: callingAgentId, scanSummary: summary, hint: "Remove injection patterns, crypto mining, or obfuscated content from skill body", errorKind: "validation" as const }, "Skill update rejected: content scan failed");
          deps.eventBus?.emit("skill:failed", { skillName: params.name, error: `Content scan failed: ${summary}`, phase: "scan", agentId: callingAgentId, timestamp: systemNowMs() });
          throw new Error(`Skill content rejected by security scan: ${summary}`);
        }
      }

      // Resolve path from skill's actual location
      const skillMdPath = safePath(skill.location, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        throw new Error(`SKILL.md not found at expected location: ${skillMdPath}`);
      }

      // Route the SKILL.md overwrite through the shared
      // fs-safe substrate so the updated file honors the §1.4 `0o600`
      // invariant — even if the existing file was previously written
      // with a wider mode (legacy artifacts). `confinedBaseDir`
      // is the resolved skill directory (which already exists by the
      // preceding existsSync check). writeRegularFile's unlink-before-
      // open semantics defensively re-mode the file via fchmod(0o600)
      // so legacy artifacts are corrected in-place. Result.err
      // propagates via thrown Error per the file's @allow-throw header.
      const writeResult = writeRegularFile({
        path: skillMdPath,
        content: params.content,
        confinedBaseDir: skill.location,
      });
      if (!writeResult.ok) {
        logger.warn(
          {
            err: writeResult.error,
            skillName: params.name,
            agentId: callingAgentId,
            hint: "Skill SKILL.md overwrite rejected by fs-safe substrate",
            errorKind: "resource" as const,
          },
          "Skill update file write failed",
        );
        throw new Error(`Skill file write failed: ${writeResult.error.message}`);
      }

      // Re-discover (triggers emitSkillAudit -> audit:event lifecycle capture)
      if (scope === "shared" && deps.skillRegistries) {
        for (const reg of deps.skillRegistries.values()) reg.init();
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }
      await runBundleInstallHook(deps, params.name, skill.location, rawParams);

      const result = { ok: true as const, name: params.name };
      if (IS_DEV) SkillsUpdateContract.response.parse(result);
      return result;
    },
  };
}
