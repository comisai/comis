// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
/**
 * OSV malware check for stdio MCP commands.
 *
 * Pre-spawn check against api.osv.dev for known malicious packages
 * (MAL-* advisory IDs from the OpenSSF Malicious Packages dataset).
 * Cached on disk under `~/.comis/cache/osv/<ecosystem>-<pkg>.json` with
 * operator-configurable TTL (default 24h). Fail-open on network/API
 * errors per SAFETY-05 — a transient api.osv.dev outage must NOT block
 * every legitimate MCP connect.
 *
 * Per RESEARCH.md §"Pattern 4" + REQUIREMENTS.md SAFETY-05/06.
 *
 * @module
 */

import { safePath, systemNowMs } from "@comis/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import type { McpClientManagerDeps } from "./mcp-client-types.js";

/** Default cache root for OSV responses. Operator-overridable via opts.cacheDir. */
export const DEFAULT_OSV_CACHE_DIR = safePath(homedir(), ".comis", "cache", "osv");
/** Fetch timeout — guards against api.osv.dev hangs. */
const OSV_FETCH_TIMEOUT_MS = 5000;

interface OsvCacheEntry {
  readonly fetchedAt: number;
  readonly verdict: "safe" | "malicious";
  readonly advisoryIds: readonly string[];
}

/**
 * Cache-entry shape validator. Used at cache READ time to reject
 * adversarially-shaped cache files (CR-01): a previously-installed
 * malicious package, or any actor with write access to the cache dir,
 * cannot poison the cache with `verdict: "Malicious"` (capital M) or
 * other near-misses that would silently pass the downstream
 * `verdict === "malicious"` exact-match check at
 * mcp-client-connect.ts:93. The schema is intentionally STRICT:
 *   - `verdict` must be exactly `"safe"` or `"malicious"`.
 *   - `advisoryIds` must be an array of strings.
 *   - `fetchedAt` must be a non-negative integer.
 * Any deviation falls through to a fresh fetch (treats cache as miss).
 */
const OsvCacheEntrySchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  verdict: z.enum(["safe", "malicious"]),
  advisoryIds: z.array(z.string()),
});

interface OsvVuln { readonly id: string; }
interface OsvResponse { readonly vulns?: readonly OsvVuln[]; }
type ComisLoggerLike = McpClientManagerDeps["logger"];

/** Options for `osvMalwareCheck`. `fetchImpl` is test-only injection. */
export interface OsvCheckOptions {
  readonly cacheDir: string;
  readonly ttlMs: number;
  readonly logger: ComisLoggerLike;
  readonly fetchImpl?: typeof fetch;
}

/** OSV check result. `safe` is also returned on fail-open paths per SAFETY-05. */
export interface OsvCheckResult {
  readonly verdict: "safe" | "malicious";
  readonly advisoryIds: readonly string[];
}

/**
 * Pre-spawn OSV malware check. Reads `<cacheDir>/<ecosystem>-<pkg>.json`;
 * on cache miss queries `https://api.osv.dev/v1/query`; on `MAL-*` match
 * returns `verdict: "malicious"`; on network/API error returns
 * `verdict: "safe"` (fail-open) with WARN log carrying
 * `errorKind: "network" | "dependency"`. Cache writes are atomic via
 * tmp(`0o600`) + `renameSync`; dir created at `0o700` on first use.
 */
export async function osvMalwareCheck(
  packageName: string,
  ecosystem: "npm" | "pypi",
  opts: OsvCheckOptions,
): Promise<OsvCheckResult> {
  const { cacheDir, ttlMs, logger } = opts;
  const fetcher = opts.fetchImpl ?? fetch;

  // Sanitize scoped names (`@org/pkg`) → no path separator in filename;
  // ecosystem prefix prevents npm/pypi same-name collisions.
  const cacheFileName = `${ecosystem}-${packageName.replace(/\//g, "_")}.json`;
  const cachePath = safePath(cacheDir, cacheFileName);

  // Cache read — CR-01: validate the entry shape via Zod BEFORE trusting
  // it. The pre-fix code did `JSON.parse(raw) as OsvCacheEntry` (an
  // unsafe cast that lies). A previously-installed malicious package
  // could write `{ "verdict": "Malicious", ... }` (capital M) — the
  // downstream `verdict === "malicious"` exact-match check would NOT
  // fire, and the package would be treated as safe. Validation rejects
  // any cache entry whose shape does not match OsvCacheEntrySchema, and
  // falls through to a fresh fetch (treats the malformed entry as miss).
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf-8");
      const parsed = OsvCacheEntrySchema.safeParse(JSON.parse(raw));
      if (parsed.success && systemNowMs() - parsed.data.fetchedAt < ttlMs) {
        return { verdict: parsed.data.verdict, advisoryIds: parsed.data.advisoryIds };
      }
      // Shape-invalid OR stale → fall through to fresh fetch.
    } catch {
      // Corrupted cache or stat race — fall through to fresh fetch.
    }
  }

  // API call
  let response: OsvResponse;
  try {
    const res = await fetcher("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { name: packageName, ecosystem } }),
      signal: AbortSignal.timeout(OSV_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        {
          packageName,
          ecosystem,
          status: res.status,
          hint: "OSV API non-2xx; failing open per SAFETY-05",
          errorKind: "dependency" as const,
        },
        "OSV API non-2xx — failing open",
      );
      return { verdict: "safe", advisoryIds: [] };
    }
    response = (await res.json()) as OsvResponse;
  } catch (error: unknown) {
    logger.warn(
      {
        packageName,
        ecosystem,
        err: error instanceof Error ? error.message : String(error),
        hint: "OSV API network/timeout error; failing open per SAFETY-05",
        errorKind: "network" as const,
      },
      "OSV API error — failing open",
    );
    return { verdict: "safe", advisoryIds: [] };
  }

  // Verdict resolution + atomic cache write (tmp + rename)
  const malIds = (response.vulns ?? [])
    .map((v) => v.id)
    .filter((id) => id.startsWith("MAL-"));
  const result: OsvCacheEntry = {
    fetchedAt: systemNowMs(),
    verdict: malIds.length > 0 ? "malicious" : "safe",
    advisoryIds: malIds,
  };

  try {
    // CR-01: `fs.mkdirSync(dir, { mode })` ONLY sets perms on a NEWLY-
    // created dir. If `cacheDir` pre-exists with looser perms (inherited
    // from a shared parent, or a prior install) the cache files inside
    // go in at 0o600 but the parent dir's perms — which control whether
    // a different user can list/replace files — stay loose. `chmodSync`
    // enforces the tight 0o700 on existing dirs too.
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(cacheDir, 0o700);
    const tmpPath = `${cachePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(result), { mode: 0o600 });
    renameSync(tmpPath, cachePath);
  } catch (error: unknown) {
    logger.warn(
      {
        packageName,
        ecosystem,
        err: error instanceof Error ? error.message : String(error),
        hint: "OSV cache write failed; lookup will repeat on next connect",
        errorKind: "resource" as const,
      },
      "OSV cache write failed",
    );
  }

  return { verdict: result.verdict, advisoryIds: result.advisoryIds };
}

/**
 * Extract `{ ecosystem, name }` from an MCP server's `command + args`.
 * Recognized: `npx [-y] <pkg>` (npm), `uvx <pkg>` (pypi),
 * `pnpm dlx <pkg>` (npm). Absolute paths match via `endsWith`;
 * version suffixes (`pkg@1.2.3`) stripped. Returns `null` for unrecognized
 * commands (`node`, `python3`, `/bin/sh`) — caller logs INFO and skips
 * OSV check. Per RESEARCH.md §"Pattern 4" + Pitfall 4.
 */
export function extractMcpPackageName(
  command: string,
  args: readonly string[] | undefined,
): { ecosystem: "npm" | "pypi"; name: string } | null {
  const argList = args ?? [];

  // npx [-y|--yes] <pkg> [args...]
  if (command.endsWith("npx")) {
    const idx = argList[0] === "-y" || argList[0] === "--yes" ? 1 : 0;
    const pkg = argList[idx];
    if (pkg && !pkg.startsWith("-")) {
      // Last `@` + version-shape suffix; scoped names ("@org/pkg") survive.
      const name = pkg.replace(/@[\d.^~><=*]+$/, "");
      return { ecosystem: "npm", name };
    }
    return null;
  }

  // uvx <pkg> [args...]
  if (command.endsWith("uvx")) {
    const pkg = argList[0];
    if (pkg && !pkg.startsWith("-")) {
      return { ecosystem: "pypi", name: pkg };
    }
    return null;
  }

  // pnpm dlx <pkg> [args...]
  if (command.endsWith("pnpm") && argList[0] === "dlx") {
    const pkg = argList[1];
    if (pkg && !pkg.startsWith("-")) {
      const name = pkg.replace(/@[\d.^~><=*]+$/, "");
      return { ecosystem: "npm", name };
    }
    return null;
  }

  return null;
}
