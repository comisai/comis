// SPDX-License-Identifier: Apache-2.0
/** Resolve skill-import request variants into one vetted-file-map input shape. */

import type { SkillBundleFile, SkillInstallSource } from "@comis/skills";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import type { WorkspaceApiDeps } from "../api/types.js";
import { fetchGitHubDir } from "../api/github-skill-fetch.js";
import { readVettingLimits } from "./vet-install-gate.js";
import { fetchWellKnownSkill } from "./wellknown-skill-fetch.js";

/** Current RPC request variants. */
export type SkillImportSourceRequest =
  | {
      readonly source?: "github";
      readonly url: string;
    }
  | {
      readonly source: "wellknown";
      readonly ref: string;
    };

/** Common output consumed by the one write/vet/install path. */
export interface ResolvedSkillImportSource {
  readonly name: string;
  readonly files: readonly SkillBundleFile[];
  readonly source: SkillInstallSource;
  readonly ref: string;
  readonly registryTrust?: "community" | "operator";
}

function parseGitHubDirUrl(
  url: string,
): { owner: string; repo: string; branch: string; path: string } | undefined {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (match === null) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    branch: match[3]!,
    path: match[4]!.replace(/\/$/, ""),
  };
}

function validSkillName(name: string | undefined): name is string {
  return (
    name !== undefined &&
    name.length <= 64 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) &&
    !name.includes("--")
  );
}

/** Resolve one request without writing any live skill file. */
export async function resolveSkillImportSource(
  request: SkillImportSourceRequest,
  deps: WorkspaceApiDeps,
  callingAgentId: string,
): Promise<Result<ResolvedSkillImportSource, Error>> {
  if (request.source === "wellknown") {
    const importConfig = deps.agents[callingAgentId]?.skills?.import;
    const vettingLimits = readVettingLimits(deps, callingAgentId);
    const fetched = await fetchWellKnownSkill({
      ref: request.ref,
      dataDir: deps.container.config.dataDir || ".",
      registries: importConfig?.registries ?? [],
      cacheTtlMs: importConfig?.indexCacheTtlMs ?? 3_600_000,
      ...(vettingLimits?.maxEntryBytes !== undefined && {
        maxEntryBytes: vettingLimits.maxEntryBytes,
      }),
      ...(vettingLimits?.maxBundleBytes !== undefined && {
        maxBundleBytes: vettingLimits.maxBundleBytes,
      }),
      ...(deps.skillImportFetchDeps !== undefined && { fetchDeps: deps.skillImportFetchDeps }),
      logger: deps.logger,
    });
    if (!fetched.ok) return fetched;
    return ok({
      name: fetched.value.name,
      files: fetched.value.files,
      source: "wellknown",
      ref: fetched.value.ref,
      registryTrust: fetched.value.registryTrust,
    });
  }

  const url = request.url.trim();
  if (url.length === 0) return err(new Error("URL is required"));
  const parsed = parseGitHubDirUrl(url);
  if (parsed === undefined) {
    return err(
      new Error(
        "Invalid GitHub URL. Expected: https://github.com/{owner}/{repo}/tree/{branch}/{path}",
      ),
    );
  }
  const segments = parsed.path.split("/").filter(Boolean);
  const name = segments[segments.length - 1];
  if (!validSkillName(name)) {
    return err(
      new Error(
        `Invalid skill name derived from URL: "${name}". Must be lowercase alphanumeric with hyphens.`,
      ),
    );
  }
  const fetched = await fromPromise(
    fetchGitHubDir(
      parsed.owner,
      parsed.repo,
      parsed.path,
      parsed.branch,
      deps.skillImportFetchDeps,
    ),
  );
  if (!fetched.ok) return fetched;
  if (fetched.value.length === 0) {
    return err(new Error("No files found at the given URL"));
  }
  const hasSkillMd = fetched.value.some(
    (file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"),
  );
  if (!hasSkillMd) {
    return err(new Error("Repository folder must contain a SKILL.md file"));
  }
  return ok({ name, files: fetched.value, source: "github", ref: url });
}
