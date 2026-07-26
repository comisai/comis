// SPDX-License-Identifier: Apache-2.0
// @allow-throw: callers (skill-handlers.ts:skills.import) catch these throws
// and convert to JSON-RPC error responses via rpc-dispatch.ts. Mirrors the
// pattern of the rest of the skill-handlers module.
/**
 * Bounded GitHub Contents API walk for `skills.import`.
 *
 * Extracted from `skill-handlers.ts` to (a) keep that file under the 800-line
 * cap, and (b) isolate the bounded-recursion + bounded-file-count + per-
 * fetch-timeout invariants on a focused module.
 *
 * Guarantees:
 *   - Every request passes through validateUrl and DNS-pinned fetch.
 *   - Recursion depth bounded at GITHUB_FETCH_MAX_DEPTH (10 levels).
 *   - Total file count bounded at GITHUB_FETCH_MAX_FILES (200 files).
 *   - Every file and the total fetched bundle are byte-bounded.
 *
 * Beyond any cap the function throws a validation-class Error which the
 * `skills.import` handler converts to an RPC error response.
 *
 * @module
 */

import { z } from "zod";
import { tryCatch } from "@comis/shared";
import {
  defaultSkillImportFetchDeps,
  fetchSkillImportResponse,
  readSkillImportText,
  type SkillImportFetchDeps,
} from "../skills/import-fetch.js";

const GITHUB_FETCH_MAX_DEPTH = 10;
const GITHUB_FETCH_MAX_FILES = 200;
const GITHUB_FETCH_MAX_LISTING_BYTES = 1024 * 1024;
const GITHUB_FETCH_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const GITHUB_FETCH_MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

const GitHubEntrySchema = z.strictObject({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  download_url: z.string().url().nullable(),
  path: z.string(),
});

const GitHubListingSchema = z.array(GitHubEntrySchema);

interface GitHubFetchState {
  count: number;
  bytes: number;
}

/** Fetch bounded text through the shared SSRF-safe import substrate. */
async function fetchText(
  url: string,
  fetchDeps: SkillImportFetchDeps,
  maxBytes: number,
  configKey: string,
  headers?: Record<string, string>,
): Promise<string> {
  const fetched = await fetchSkillImportResponse(url, fetchDeps, headers === undefined ? {} : { headers });
  if (!fetched.ok) throw fetched.error;
  if (!fetched.value.ok) {
    throw new Error(`GitHub API error: ${fetched.value.status} ${fetched.value.statusText}`);
  }
  const body = await readSkillImportText(fetched.value, maxBytes, configKey);
  if (!body.ok) throw body.error;
  return body.value;
}

/** Build the GitHub Contents endpoint without allowing path/query injection. */
function contentsApiUrl(owner: string, repo: string, path: string, branch: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
  );
  url.searchParams.set("ref", branch);
  return url.toString();
}

/**
 * Recursively fetch all files in a GitHub directory via the Contents API.
 *
 * @param owner GitHub owner/org segment (e.g. "anthropic").
 * @param repo Repo segment (e.g. "comis").
 * @param path Path inside the repo (e.g. "skills/my-skill").
 * @param branch Git branch (e.g. "main").
 * @param fetchDeps Injectable fetch security seams; production uses the
 *   shared validateUrl + DNS-pinned implementation.
 * @returns Array of `{ path, content }` where `path` is relative to the
 *   skill folder root.
 * @throws On depth/file-count overflow OR underlying fetch error.
 */
export async function fetchGitHubDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  fetchDeps: SkillImportFetchDeps = defaultSkillImportFetchDeps,
): Promise<Array<{ path: string; content: string }>> {
  return fetchGitHubDirRecursive(owner, repo, path, branch, path, 0, { count: 0, bytes: 0 }, fetchDeps);
}

async function fetchGitHubDirRecursive(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  rootPath: string,
  depth: number,
  state: GitHubFetchState,
  fetchDeps: SkillImportFetchDeps,
): Promise<Array<{ path: string; content: string }>> {
  if (depth > GITHUB_FETCH_MAX_DEPTH) {
    throw new Error(
      `Skill import: directory recursion depth exceeds ${GITHUB_FETCH_MAX_DEPTH} levels`,
    );
  }
  const listingText = await fetchText(
    contentsApiUrl(owner, repo, path, branch),
    fetchDeps,
    GITHUB_FETCH_MAX_LISTING_BYTES,
    "skills.import.githubListingBytes",
    { Accept: "application/vnd.github.v3+json", "User-Agent": "Comis-Skill-Import" },
  );
  const decoded = tryCatch(() => JSON.parse(listingText) as unknown);
  if (!decoded.ok) throw new Error(`GitHub API response was not valid JSON: ${decoded.error.message}`);
  const parsed = GitHubListingSchema.safeParse(decoded.value);
  if (!parsed.success) throw new Error(`GitHub API response shape invalid: ${parsed.error.message}`);
  const entries = parsed.data;

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.download_url) {
      if (state.count >= GITHUB_FETCH_MAX_FILES) {
        throw new Error(
          `Skill import: file count exceeds ${GITHUB_FETCH_MAX_FILES} (too many files in repository directory)`,
        );
      }
      state.count++;
      const content = await fetchText(
        entry.download_url,
        fetchDeps,
        GITHUB_FETCH_MAX_ENTRY_BYTES,
        "skills.installVetting.maxEntryBytes",
      );
      state.bytes += new TextEncoder().encode(content).byteLength;
      if (state.bytes > GITHUB_FETCH_MAX_BUNDLE_BYTES) {
        throw new Error(
          `Skill import fetched bytes ${state.bytes} exceed skills.installVetting.maxBundleBytes=${GITHUB_FETCH_MAX_BUNDLE_BYTES}`,
        );
      }
      // Relative path within the skill folder: strip the ROOT directory prefix
      const relativePath = entry.path.startsWith(rootPath + "/")
        ? entry.path.slice(rootPath.length + 1)
        : entry.name;
      files.push({ path: relativePath, content });
    } else if (entry.type === "dir") {
      const subFiles = await fetchGitHubDirRecursive(
        owner,
        repo,
        entry.path,
        branch,
        rootPath,
        depth + 1,
        state,
        fetchDeps,
      );
      files.push(...subFiles);
    }
  }
  return files;
}
