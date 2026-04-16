/**
 * Skill management RPC handler methods.
 * Covers:
 *   skills.list    -- List prompt skill descriptions for an agent
 *   skills.upload  -- Create a skill folder from uploaded files
 *   skills.import  -- Import a skill from a GitHub directory URL
 *   skills.delete  -- Remove a skill folder
 *   skills.create  -- Create a new skill from SKILL.md content
 *   skills.update  -- Update an existing skill's content
 * Extracted from setup-gateway-rpc.ts.
 * @module
 */

import type { SkillRegistry } from "@comis/skills";
import { scanSkillContent } from "@comis/skills";
import type { AppContainer } from "@comis/core";
import { safePath } from "@comis/core";
import { createLogger } from "@comis/infra";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import type { RpcHandler } from "./types.js";

const logger = createLogger({ name: "skill-handlers" });

/** Skill name validation regex: lowercase alphanumeric + hyphens, 1-64 chars. */
const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Parse a GitHub directory URL into API-friendly parts.
 * Accepts: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 */
function parseGitHubDirUrl(url: string): { owner: string; repo: string; branch: string; path: string } | null {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], path: m[4].replace(/\/$/, "") };
}

/** Recursively fetch all files in a GitHub directory via the Contents API. */
async function fetchGitHubDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  rootPath?: string,
): Promise<Array<{ path: string; content: string }>> {
  const effectiveRoot = rootPath ?? path;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const resp = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Comis-Skill-Import" },
  });
  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
  }
  const entries = (await resp.json()) as Array<{
    name: string;
    type: "file" | "dir";
    download_url: string | null;
    path: string;
  }>;

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.download_url) {
      const fileResp = await fetch(entry.download_url);
      if (!fileResp.ok) continue;
      const content = await fileResp.text();
      // Relative path within the skill folder: strip the ROOT directory prefix
      const relativePath = entry.path.startsWith(effectiveRoot + "/")
        ? entry.path.slice(effectiveRoot.length + 1)
        : entry.name;
      files.push({ path: relativePath, content });
    } else if (entry.type === "dir") {
      const subFiles = await fetchGitHubDir(owner, repo, entry.path, branch, effectiveRoot);
      files.push(...subFiles);
    }
  }
  return files;
}

/** Dependencies for skill management RPC handlers. */
export interface SkillHandlerDeps {
  /** Per-agent skill registries. */
  skillRegistries?: Map<string, SkillRegistry>;
  /** Per-agent workspace directory paths. */
  workspaceDirs?: Map<string, string>;
  /** Default agent ID for deterministic skills.list fallback. */
  defaultAgentId?: string;
  /** Bootstrap container (for dataDir access). */
  container: AppContainer;
  /** Event bus for skill lifecycle events. */
  eventBus?: AppContainer["eventBus"];
}

/**
 * Create skill management RPC handlers.
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createSkillHandlers(deps: SkillHandlerDeps): Record<string, RpcHandler> {
  return {
    "skills.list": async (params) => {
      if (!deps.skillRegistries || deps.skillRegistries.size === 0) {
        return { skills: [] };
      }
      const agentId = typeof params.agentId === "string" ? params.agentId
        : typeof params._agentId === "string" ? params._agentId
        : undefined;

      // If agentId specified, return skills for that agent only
      if (agentId) {
        const registry = deps.skillRegistries.get(agentId);
        if (!registry) return { skills: [] };
        return { skills: registry.getPromptSkillDescriptions() };
      }

      // Default: return skills from the default agent's registry (deterministic fallback)
      const fallbackRegistry = deps.defaultAgentId
        ? deps.skillRegistries.get(deps.defaultAgentId) ?? deps.skillRegistries.values().next().value
        : deps.skillRegistries.values().next().value;
      if (!fallbackRegistry) return { skills: [] };
      return { skills: fallbackRegistry.getPromptSkillDescriptions() };
    },

    "skills.upload": async (params) => {
      const name = typeof params.name === "string" ? params.name : "";
      const scope = typeof params.scope === "string" && params.scope === "shared" ? "shared" : "local";
      const files = Array.isArray(params.files) ? params.files as Array<{ path: string; content: string }> : [];

      // _agentId fallback
      const callingAgentId = typeof params.agentId === "string" ? params.agentId
        : typeof params._agentId === "string" ? params._agentId
        : undefined;

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations. Provide agentId or call via agent tool.");
      }

      // Validate skill folder name
      if (!name || name.length > 64 || !SKILL_NAME_RE.test(name) || name.includes("--")) {
        throw new Error("Invalid skill name: must be 1-64 chars, lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens");
      }

      // Must have at least one file
      if (files.length === 0) {
        throw new Error("No files provided");
      }

      // Must include a SKILL.md
      const hasSkillMd = files.some((f) => {
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
          throw new Error(
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

      const skillDir = safePath(skillsBaseDir, name);

      // Prevent overwrite of existing skill
      if (existsSync(skillDir)) {
        throw new Error(`Skill directory already exists: ${name}`);
      }

      // Create skill directory
      mkdirSync(skillDir, { recursive: true });

      // Write each file
      for (const file of files) {
        if (typeof file.path !== "string" || typeof file.content !== "string") continue;
        // file.path is relative within the skill folder (e.g. "SKILL.md" or "examples/foo.md")
        const filePath = safePath(skillDir, file.path);
        // Ensure parent directory exists for nested files
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (parentDir && !existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        writeFileSync(filePath, file.content, "utf-8");
      }

      // Scope-aware re-discovery
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) {
          registry.init();
        }
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }

      return { ok: true, path: skillDir };
    },

    "skills.import": async (params) => {
      const url = typeof params.url === "string" ? params.url.trim() : "";
      const scope = typeof params.scope === "string" && params.scope === "shared" ? "shared" : "local";

      // _agentId fallback
      const callingAgentId = typeof params.agentId === "string" ? params.agentId
        : typeof params._agentId === "string" ? params._agentId
        : undefined;

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations. Provide agentId or call via agent tool.");
      }

      // Scope guard: fail fast before expensive network fetch
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new Error(
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

      // Create skill directory and write files
      mkdirSync(skillDir, { recursive: true });
      for (const file of fetchedFiles) {
        const filePath = safePath(skillDir, file.path);
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (parentDir && !existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        writeFileSync(filePath, file.content, "utf-8");
      }

      // Scope-aware re-discovery
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) {
          registry.init();
        }
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }

      return { ok: true, path: skillDir, name, fileCount: fetchedFiles.length };
    },

    "skills.delete": async (params) => {
      const name = typeof params.name === "string" ? params.name : "";
      const scope = typeof params.scope === "string" && params.scope === "shared" ? "shared" : "local";

      // _agentId fallback
      const callingAgentId = typeof params.agentId === "string" ? params.agentId
        : typeof params._agentId === "string" ? params._agentId
        : undefined;

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations. Provide agentId or call via agent tool.");
      }

      // Validate name
      if (!name || name.length > 64 || !SKILL_NAME_RE.test(name) || name.includes("--")) {
        throw new Error("Invalid skill name");
      }

      // Scope guard: only the default agent may delete shared skills
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new Error(
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
      const skill = descriptions.find((s) => s.name === name);
      if (!skill) {
        throw new Error(`Skill not found: ${name}`);
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
            `Skill "${name}" is not in this agent's workspace skills directory. ` +
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

      return { ok: true };
    },

    "skills.create": async (params) => {
      const name = typeof params.name === "string" ? params.name : "";
      const content = typeof params.content === "string" ? params.content : "";
      const scope = typeof params.scope === "string" && params.scope === "shared" ? "shared" : "local";
      const callingAgentId = typeof params.agentId === "string" ? params.agentId
        : typeof params._agentId === "string" ? params._agentId
        : undefined;

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations.");
      }

      // Validate skill name
      if (!name || name.length > 64 || !SKILL_NAME_RE.test(name) || name.includes("--")) {
        logger.warn({ skillName: name || "(empty)", agentId: callingAgentId, hint: "Skill name must be 1-64 chars, lowercase alphanumeric with single hyphens", errorKind: "validation" }, "Skill create rejected: invalid name");
        deps.eventBus?.emit("skill:failed", { skillName: name || "(empty)", error: "Invalid skill name", phase: "create", agentId: callingAgentId, timestamp: Date.now() });
        throw new Error("Invalid skill name: must be 1-64 chars, lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens");
      }

      if (!content) {
        throw new Error("Content is required for create action. Provide full SKILL.md content.");
      }

      // Security scan before write
      const scanResult = scanSkillContent(content);
      if (!scanResult.clean) {
        const criticalFindings = scanResult.findings.filter((f) => f.severity === "CRITICAL");
        if (criticalFindings.length > 0) {
          const summary = criticalFindings.map((f) => f.description).join("; ");
          logger.warn({ skillName: name, agentId: callingAgentId, scanSummary: summary, hint: "Remove injection patterns, crypto mining, or obfuscated content from skill body", errorKind: "security" }, "Skill create rejected: content scan failed");
          deps.eventBus?.emit("skill:failed", { skillName: name, error: `Content scan failed: ${summary}`, phase: "scan", agentId: callingAgentId, timestamp: Date.now() });
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

      const skillDir = safePath(skillsBaseDir, name);

      // Prevent overwrite
      if (existsSync(skillDir)) {
        throw new Error(`Skill directory already exists: ${name}. Use update action to modify existing skills.`);
      }

      // Write SKILL.md
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(safePath(skillDir, "SKILL.md"), content, "utf-8");

      // Re-discover
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) registry.init();
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }

      // Emit skill:created event
      deps.eventBus?.emit("skill:created", { skillName: name, scope: scope as "local" | "shared", agentId: callingAgentId, timestamp: Date.now() });

      return { ok: true, path: skillDir, name };
    },

    "skills.update": async (params) => {
      const name = typeof params.name === "string" ? params.name : "";
      const content = typeof params.content === "string" ? params.content : "";
      const scope = typeof params.scope === "string" && params.scope === "shared" ? "shared" : "local";

      const callingAgentId = typeof params.agentId === "string" ? params.agentId
        : typeof params._agentId === "string" ? params._agentId
        : undefined;

      if (!callingAgentId) {
        throw new Error("Agent ID is required for skill operations.");
      }

      // Validate name
      if (!name || name.length > 64 || !SKILL_NAME_RE.test(name) || name.includes("--")) {
        logger.warn({ skillName: name || "(empty)", agentId: callingAgentId, hint: "Skill name must be 1-64 chars, lowercase alphanumeric with single hyphens", errorKind: "validation" }, "Skill update rejected: invalid name");
        throw new Error("Invalid skill name");
      }

      if (!content) {
        throw new Error("Content is required for update action.");
      }

      // Resolve registry and validate skill exists
      const registry = deps.skillRegistries?.get(callingAgentId);
      if (!registry) throw new Error("Skill registry not found for agent");

      const descriptions = registry.getPromptSkillDescriptions();
      const skill = descriptions.find((s) => s.name === name);
      if (!skill) throw new Error(`Skill not found: ${name}`);

      // Scope guard
      if (scope === "shared" && callingAgentId !== deps.defaultAgentId) {
        throw new Error(`Only the default agent ("${deps.defaultAgentId}") can manage shared skills. Agent "${callingAgentId}" must use scope: "local".`);
      }

      // Security scan before write
      const scanResult = scanSkillContent(content);
      if (!scanResult.clean) {
        const criticalFindings = scanResult.findings.filter((f) => f.severity === "CRITICAL");
        if (criticalFindings.length > 0) {
          const summary = criticalFindings.map((f) => f.description).join("; ");
          logger.warn({ skillName: name, agentId: callingAgentId, scanSummary: summary, hint: "Remove injection patterns, crypto mining, or obfuscated content from skill body", errorKind: "security" }, "Skill update rejected: content scan failed");
          deps.eventBus?.emit("skill:failed", { skillName: name, error: `Content scan failed: ${summary}`, phase: "scan", agentId: callingAgentId, timestamp: Date.now() });
          throw new Error(`Skill content rejected by security scan: ${summary}`);
        }
      }

      // Resolve path from skill's actual location
      const skillMdPath = safePath(skill.location, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        throw new Error(`SKILL.md not found at expected location: ${skillMdPath}`);
      }

      // Overwrite SKILL.md
      writeFileSync(skillMdPath, content, "utf-8");

      // Re-discover
      if (scope === "shared" && deps.skillRegistries) {
        for (const registry of deps.skillRegistries.values()) registry.init();
      } else if (deps.skillRegistries) {
        deps.skillRegistries.get(callingAgentId)?.init();
      }

      // Emit skill:updated event
      deps.eventBus?.emit("skill:updated", { skillName: name, scope: scope as "local" | "shared", agentId: callingAgentId, timestamp: Date.now() });

      return { ok: true, name };
    },
  };
}
