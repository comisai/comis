// SPDX-License-Identifier: Apache-2.0
/** Resolve skill-import request variants into one vetted-file-map input shape. */

import {
  parseSkillBundleManifest,
  unpackSkillArchive,
  type SkillBundleFile,
  type SkillInstallSource,
} from "@comis/skills";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { WorkspaceApiDeps } from "../api/types.js";
import { fetchGitHubDir } from "../api/github-skill-fetch.js";
import { readVettingLimits } from "./vet-install-gate.js";
import {
  defaultSkillImportFetchDeps,
  fetchSkillImportResponse,
  readSkillImportBytes,
} from "./import-fetch.js";
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
    }
  | {
      readonly source: "archive";
      readonly archiveBase64: string;
    }
  | {
      readonly source: "archive";
      readonly archiveUrl: string;
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

function decodeArchiveBase64(
  encoded: string,
  maxArchiveBytes: number,
): Result<Uint8Array, Error> {
  const maxEncodedLength = Math.ceil(maxArchiveBytes / 3) * 4;
  if (encoded.length > maxEncodedLength) {
    return err(
      new Error(
        `Archive encoded bytes ${encoded.length} exceed skills.import.maxArchiveBytes=${maxArchiveBytes}`,
      ),
    );
  }
  if (encoded.length % 4 !== 0) return err(new Error("Archive base64 is not canonical"));
  const paddingIndex = encoded.indexOf("=");
  const contentEnd = paddingIndex === -1 ? encoded.length : paddingIndex;
  if (paddingIndex !== -1) {
    const padding = encoded.length - paddingIndex;
    if (padding > 2 || !encoded.slice(paddingIndex).split("").every((char) => char === "=")) {
      return err(new Error("Archive base64 has invalid padding"));
    }
  }
  for (let index = 0; index < contentEnd; index++) {
    const code = encoded.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return err(new Error("Archive base64 contains an invalid character"));
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    return err(new Error("Archive base64 is not canonical"));
  }
  if (decoded.byteLength > maxArchiveBytes) {
    return err(
      new Error(
        `Archive bytes ${decoded.byteLength} exceed skills.import.maxArchiveBytes=${maxArchiveBytes}`,
      ),
    );
  }
  return ok(Uint8Array.from(decoded));
}

async function resolveArchive(
  request: Extract<SkillImportSourceRequest, { source: "archive" }>,
  deps: WorkspaceApiDeps,
  callingAgentId: string,
): Promise<Result<ResolvedSkillImportSource, Error>> {
  const importConfig = deps.agents[callingAgentId]?.skills?.import;
  const vettingLimits = readVettingLimits(deps, callingAgentId);
  const maxArchiveBytes = importConfig?.maxArchiveBytes ?? 8 * 1024 * 1024;
  let bytes: Uint8Array;
  let ref: string;
  if ("archiveBase64" in request) {
    const decoded = decodeArchiveBase64(request.archiveBase64, maxArchiveBytes);
    if (!decoded.ok) return decoded;
    bytes = decoded.value;
    ref = "uploaded";
  } else {
    const parsedUrl = tryCatch(() => new URL(request.archiveUrl.trim()));
    if (!parsedUrl.ok) return parsedUrl;
    if (parsedUrl.value.username !== "" || parsedUrl.value.password !== "") {
      return err(new Error("Archive URL must not contain credentials"));
    }
    const fetched = await fetchSkillImportResponse(
      parsedUrl.value.toString(),
      deps.skillImportFetchDeps ?? defaultSkillImportFetchDeps,
    );
    if (!fetched.ok) return fetched;
    if (!fetched.value.ok) {
      return err(
        new Error(
          `Archive request failed: ${fetched.value.status} ${fetched.value.statusText}`,
        ),
      );
    }
    const read = await readSkillImportBytes(
      fetched.value,
      maxArchiveBytes,
      "skills.import.maxArchiveBytes",
    );
    if (!read.ok) return read;
    bytes = read.value;
    parsedUrl.value.search = "";
    parsedUrl.value.hash = "";
    ref = parsedUrl.value.toString();
  }
  const unpacked = unpackSkillArchive(bytes, {
    maxArchiveBytes,
    maxCompressionRatio: importConfig?.maxCompressionRatio ?? 100,
    maxEntries: vettingLimits?.maxEntries ?? 200,
    maxEntryBytes: vettingLimits?.maxEntryBytes ?? 4 * 1024 * 1024,
    maxBundleBytes: vettingLimits?.maxBundleBytes ?? 32 * 1024 * 1024,
    maxPathDepth: vettingLimits?.maxPathDepth ?? 10,
  });
  if (!unpacked.ok) {
    return err(new Error(`${unpacked.error.code}: ${unpacked.error.message}`));
  }
  const parsedManifest = parseSkillBundleManifest(unpacked.value);
  if (!parsedManifest.ok) return err(new Error(parsedManifest.error.message));
  return ok({
    name: parsedManifest.value.manifest.name,
    files: unpacked.value,
    source: "archive",
    ref,
  });
}

/** Resolve one request without writing any live skill file. */
export async function resolveSkillImportSource(
  request: SkillImportSourceRequest,
  deps: WorkspaceApiDeps,
  callingAgentId: string,
): Promise<Result<ResolvedSkillImportSource, Error>> {
  if (request.source === "archive") {
    return resolveArchive(request, deps, callingAgentId);
  }
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
