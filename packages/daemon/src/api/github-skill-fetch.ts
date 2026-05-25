// SPDX-License-Identifier: Apache-2.0
// @allow-throw: callers (skill-handlers.ts:skills.import) catch these throws
// and convert to JSON-RPC error responses via rpc-dispatch.ts. Mirrors the
// pattern of the rest of the skill-handlers module.
/**
 * WR-03 — bounded GitHub Contents API walk for `skills.import`.
 *
 * Extracted from `skill-handlers.ts` to (a) keep that file under the 800-line
 * cap, and (b) isolate the bounded-recursion + bounded-file-count + per-
 * fetch-timeout invariants on a focused module.
 *
 * Guarantees:
 *   - Recursion depth bounded at GITHUB_FETCH_MAX_DEPTH (10 levels).
 *   - Total file count bounded at GITHUB_FETCH_MAX_FILES (200 files).
 *   - Each fetch attempt bounded at GITHUB_FETCH_TIMEOUT_MS (10s) via
 *     `AbortSignal.timeout()`. Beyond the timeout the underlying fetch
 *     rejects with `TimeoutError` which propagates to the caller.
 *
 * Beyond any cap the function throws a validation-class Error which the
 * `skills.import` handler converts to an RPC error response.
 *
 * @module
 */

const GITHUB_FETCH_MAX_DEPTH = 10;
const GITHUB_FETCH_MAX_FILES = 200;
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

/** Fetch with AbortSignal-based timeout (10s default). */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const signal = AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal });
}

/**
 * Recursively fetch all files in a GitHub directory via the Contents API.
 *
 * @param owner GitHub owner/org segment (e.g. "anthropic").
 * @param repo Repo segment (e.g. "comis").
 * @param path Path inside the repo (e.g. "skills/my-skill").
 * @param branch Git branch (e.g. "main").
 * @param rootPath The top-level fetch path; used to compute paths relative
 *   to the skill folder root. Caller passes `undefined` at the entry point;
 *   the function threads it through the recursive calls.
 * @param depth Internal recursion depth (caller passes `0` — not part of the
 *   public surface). Bounded at GITHUB_FETCH_MAX_DEPTH.
 * @param totalFiles Internal mutable file-count accumulator shared across the
 *   recursive call chain. Caller passes `{ count: 0 }`. Bounded at
 *   GITHUB_FETCH_MAX_FILES.
 * @returns Array of `{ path, content }` where `path` is relative to the
 *   skill folder root.
 * @throws On depth/file-count overflow OR underlying fetch error.
 */
export async function fetchGitHubDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  rootPath?: string,
  depth = 0,
  totalFiles: { count: number } = { count: 0 },
): Promise<Array<{ path: string; content: string }>> {
  if (depth > GITHUB_FETCH_MAX_DEPTH) {
    throw new Error(
      `Skill import: directory recursion depth exceeds ${GITHUB_FETCH_MAX_DEPTH} levels`,
    );
  }
  const effectiveRoot = rootPath ?? path;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const resp = await fetchWithTimeout(apiUrl, {
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
      if (totalFiles.count >= GITHUB_FETCH_MAX_FILES) {
        throw new Error(
          `Skill import: file count exceeds ${GITHUB_FETCH_MAX_FILES} (too many files in repository directory)`,
        );
      }
      totalFiles.count++;
      const fileResp = await fetchWithTimeout(entry.download_url);
      if (!fileResp.ok) continue;
      const content = await fileResp.text();
      // Relative path within the skill folder: strip the ROOT directory prefix
      const relativePath = entry.path.startsWith(effectiveRoot + "/")
        ? entry.path.slice(effectiveRoot.length + 1)
        : entry.name;
      files.push({ path: relativePath, content });
    } else if (entry.type === "dir") {
      const subFiles = await fetchGitHubDir(
        owner,
        repo,
        entry.path,
        branch,
        effectiveRoot,
        depth + 1,
        totalFiles,
      );
      files.push(...subFiles);
    }
  }
  return files;
}
