// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth 2.1 token store — the persistence + correctness core for MCP OAuth.
 *
 * Three files per server under `~/.comis/mcp-tokens/`, each mapping 1:1 to a
 * pair of SDK `OAuthClientProvider` methods:
 *   - `<server>.json`        ← saveTokens / tokens          (access+refresh+expiresAt)
 *   - `<server>.client.json` ← saveClientInformation / ...  (RFC 7591 DCR result)
 *   - `<server>.meta.json`   ← saveDiscoveryState / ...      (RFC 8414/9728 metadata)
 * There is NO `code_verifier` file — the PKCE verifier is closure-only,
 * never written to disk (owned by the browser-callback module).
 *
 * ── ABSOLUTE expiry ──────────────────────────────────────────────────────────
 * The SDK `OAuthTokens` wire shape carries a RELATIVE `expires_in` (seconds).
 * Storing that verbatim causes a bug: after a daemon restart the "remaining"
 * seconds are re-interpreted from a fresh `now`, so the token looks valid
 * forever (or instantly expired). `saveTokens()` therefore computes
 * `expiresAt = now() + expires_in*1000` and persists ONLY the absolute epoch-ms
 * value. The stored {@link TokenFile} schema has NO `expiresIn`/`expires_in`
 * field; the compile-time `_NoRelativeExpiry` guard below makes a regression a
 * build error (the `*.test.ts` is excluded from `tsc`, so the load-bearing type
 * guard lives here in source — the test carries a runtime mirror).
 *
 * ── fs-safe substrate ────────────────────────────────────────────────────────
 * Every write routes through `@comis/observability` `writeRegularFile`
 * (unlink → O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW → fchmod 0o600 → write → fstat →
 * close) and the dir through `ensureContainedDir({ mode: 0o700 })`. This file
 * issues no raw low-level fs writes — an architecture-grep test enforces the
 * substrate is the sole write path. The substrate is a symlink-safe primitive
 * (O_EXCL + O_NOFOLLOW + fchmod + parent lstat + `confinedBaseDir` ancestor
 * check) but writes IN-PLACE in the target dir — no temp-file + move, hence no
 * cross-device `EXDEV`. A crash mid-write is acceptable: tokens are
 * re-fetchable on next login, so durability-on-crash is not required.
 *
 * ── Single-writer invariant (cross-process lock deferred) ────────────────────
 * `~/.comis/mcp-tokens/` assumes a SINGLE daemon writer. Two daemons sharing
 * the dir without a cross-process lock can both refresh with the same
 * refresh_token and trip a provider's refresh-token-reuse detection, nuking the
 * chain. The chokidar disk-watch below keeps a single daemon current with an
 * EXTERNAL cron/sibling rotation (picked up on the next read). The cross-process
 * `FileLockPort.withLock` hardening is explicitly deferred — do not add it here.
 *
 * ── Disk-watch ───────────────────────────────────────────────────────────────
 * A chokidar watcher on the tokens dir (`atomic:100`, 100ms debounce) clears
 * the in-memory cache on external `change`/`unlink`/`add`; the next read
 * re-reads from disk. Self-triggering on our own writes is a non-issue:
 * invalidate-and-lazily-reload means a self-fired event just causes a redundant
 * re-read on next access, never a partial-file read. A parse failure during
 * re-read is fail-soft — the last-good cache is kept and a WARN is logged.
 *
 * SECURITY: token values and the PKCE `code_verifier` are NEVER logged at any
 * level (Pino redaction is a safety net, not a license).
 *
 * @module
 */

import { watch, type FSWatcher } from "chokidar";
import { readFileSync as nodeReadFileSync, unlinkSync as nodeUnlinkSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";

import {
  safePath,
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
  type SystemTimeoutHandle,
} from "@comis/core";
import { writeRegularFile, ensureContainedDir } from "@comis/observability";
import type {
  OAuthTokens,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

// ---------------------------------------------------------------------------
// Stored schemas (Comis-owned — SEPARATE from the SDK wire shapes).
// ---------------------------------------------------------------------------

/**
 * The on-disk `<server>.json` shape. ABSOLUTE `expiresAt` (epoch ms) ONLY —
 * there is intentionally NO `expiresIn`/`expires_in` field.
 */
const TokenFileSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().int().positive(),
  scope: z.string().optional(),
  tokenType: z.string(),
});
export type TokenFile = z.infer<typeof TokenFileSchema>;

/**
 * Compile-time guard: the stored {@link TokenFile} must NOT carry a
 * relative-expiry field. If a future edit adds `expiresIn`/`expires_in` to
 * {@link TokenFileSchema}, the corresponding key type resolves to a non-`never`
 * type and this line becomes a type error. `keyof TokenFile & ("expiresIn" |
 * "expires_in")` is `never` while the schema is clean, so `_NoRelativeExpiry`
 * is satisfiable; it stops compiling the instant a relative key is introduced.
 * `*.test.ts` is excluded from `packages/skills/tsconfig.json`, so this
 * source-side assertion (NOT the test's `expectTypeOf`) is the build-time gate.
 */
type _NoRelativeExpiry = (keyof TokenFile & ("expiresIn" | "expires_in")) extends never
  ? true
  : never;
const _noRelativeExpiry: _NoRelativeExpiry = true;

/**
 * Thin local schema for the DCR client-information file. The SDK ships a Zod
 * schema (`OAuthClientInformationFullSchema`) but it coerces URL strings into
 * `URL` objects, which do not JSON-round-trip; we persist the raw JSON shape
 * and re-validate the structural minimum (`client_id` + `redirect_uris`).
 */
const ClientInfoFileSchema = z
  .object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
    redirect_uris: z.array(z.string()),
  })
  .passthrough();

/** Thin local schema for the discovery-state file (structural minimum). */
const DiscoveryStateFileSchema = z
  .object({
    authorizationServerUrl: z.string(),
    resourceMetadataUrl: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Public contract.
// ---------------------------------------------------------------------------

/** Logger contract — matches the MCP client manager's structural logger. */
interface TokenStoreLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies injected into {@link createTokenStore}. */
export interface TokenStoreDeps {
  /**
   * Tokens directory. Defaults to `safePath(homedir(), ".comis", "mcp-tokens")`.
   * Tests pass a tmpdir.
   */
  readonly tokensDir?: string;
  /**
   * Real-path confinement base for the fs-safe substrate (closes the
   * ancestor-symlink gap). Defaults to `safePath(homedir(), ".comis")`. Tests
   * pass the tmpdir itself.
   */
  readonly confinedBaseDir?: string;
  /** Injectable clock (epoch ms). Defaults to {@link systemNowMs}. */
  readonly now?: () => number;
  /** Structural logger. */
  readonly logger: TokenStoreLogger;
  /**
   * chokidar `persistent` flag. Defaults to `false` so the watcher does NOT
   * keep the daemon's event loop alive on SIGTERM (clean shutdown — matches the
   * `oauth-token-manager.ts` precedent). On Linux (inotify) `persistent:false`
   * still reports ongoing external changes. macOS FSEvents tears the watch down
   * after the initial scan under `persistent:false`, so tests on the dev
   * platform set this to `true`; production (Linux-only) keeps the default.
   */
  readonly watchPersistent?: boolean;
  /** chokidar `usePolling` for the disk-watch. Default `false` (native events — production keeps this). Tests set `true`: stat-polling the few token files stays deterministic where a saturated machine delays macOS FSEvents past any poll budget. */
  readonly watchUsePolling?: boolean;
}

/** The OAuth token store surface (disk-backed `OAuthClientProvider` glue). */
export interface TokenStore {
  /** Read `<server>.json`; reconstruct the SDK-shaped tokens (relative `expires_in` rebuilt from absolute `expiresAt`). */
  tokens(server: string): Promise<OAuthTokens | undefined>;
  /** Persist tokens to `<server>.json`, computing ABSOLUTE `expiresAt`. */
  saveTokens(server: string, sdkTokens: OAuthTokens): Promise<void>;
  /** Read `<server>.client.json` (DCR result). */
  clientInformation(server: string): Promise<OAuthClientInformationFull | undefined>;
  /** Persist DCR client information to `<server>.client.json`. */
  saveClientInformation(server: string, info: OAuthClientInformationFull): Promise<void>;
  /** Read `<server>.meta.json` (discovery state). */
  discoveryState(server: string): Promise<OAuthDiscoveryState | undefined>;
  /** Persist discovery state to `<server>.meta.json`. */
  saveDiscoveryState(server: string, state: OAuthDiscoveryState): Promise<void>;
  /** Remove all three files for a server (logout). */
  deleteAll(server: string): Promise<void>;
  /**
   * Start the chokidar disk-watch (idempotent). Resolves once the watcher has
   * completed its initial scan (chokidar `ready`) — await this before relying
   * on external-change detection so a near-simultaneous external write is seen
   * as a `change` rather than coalesced into the initial scan.
   */
  startWatch(): Promise<void>;
  /** Stop the watcher + clear the debounce timer (idempotent). */
  close(): Promise<void>;
}

const TOKEN_SUFFIX = ".json";
const CLIENT_SUFFIX = ".client.json";
const META_SUFFIX = ".meta.json";
const DIR_MODE = 0o700;
const WATCH_DEBOUNCE_MS = 100;
/**
 * Sentinel TTL (seconds) when the SDK omits `expires_in`. Per RFC 6749 §5.1
 * `expires_in` is RECOMMENDED, not required; a provider that omits it grants a
 * token with no server-stated lifetime. We still persist an ABSOLUTE value (no
 * relative drift) but pick a long horizon (~10 years) so the pre-flight treats
 * it as long-lived rather than instantly-expired (which would force a pointless
 * refresh the provider may not support). The disk-watch still picks up an
 * external rotation, and a real 401 still drives re-auth.
 */
const SENTINEL_TTL_SEC = 10 * 365 * 24 * 60 * 60;

/**
 * Construct an OAuth token store rooted at `tokensDir`
 * (default `~/.comis/mcp-tokens/`). The directory is created `0o700` on
 * construction via the fs-safe substrate.
 */
export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const tokensDir = deps.tokensDir ?? safePath(homedir(), ".comis", "mcp-tokens");
  const confinedBaseDir = deps.confinedBaseDir ?? safePath(homedir(), ".comis");
  const now = deps.now ?? systemNowMs;
  const { logger } = deps;
  const watchPersistent = deps.watchPersistent ?? false;
  const watchUsePolling = deps.watchUsePolling ?? false;

  // In-memory read cache of parsed file contents keyed by ABSOLUTE file path.
  // The watcher clears it wholesale on any external change; reads repopulate
  // lazily. Entries may be the `undefined` sentinel (file absent) — distinguish
  // present-vs-absent via `cache.has`.
  const cache = new Map<string, unknown>();

  // Last-good values keyed by ABSOLUTE file path. Unlike `cache`, this map is
  // NOT wiped by the watcher — it holds the most recent SUCCESSFULLY-parsed
  // value so a fail-soft re-read (truncated/partial external write)
  // can fall back to it instead of returning undefined. Cleared only on an
  // explicit deleteAll (the file is genuinely gone).
  const lastGood = new Map<string, unknown>();

  // Step 1: ensure the dir exists at 0o700 (defensive chmod re-asserts mode if
  // a prior creator used a wider umask). Confinement closes the ancestor gap.
  const dirResult = ensureContainedDir({ dir: tokensDir, mode: DIR_MODE, confinedBaseDir });
  if (!dirResult.ok) {
    // The dir is the root of the whole subsystem — a hard failure here is fatal
    // to OAuth, but it must not crash construction (the manager surfaces the
    // first read/write error). Log and continue; the first write will re-error.
    logger.warn(
      { submodule: "oauth-token-store", errorKind: "internal" as const, err: dirResult.error },
      "Failed to ensure mcp-tokens dir at 0o700",
    );
  }

  function filePath(server: string, suffix: string): string {
    // `<server>` is regex-constrained `^[a-zA-Z0-9_-]+$` upstream; still route
    // through safePath so a future caller cannot smuggle a traversal segment.
    return safePath(tokensDir, `${server}${suffix}`);
  }

  /** Read + JSON-parse + zod-validate a file via the cache; fail-soft. */
  function readValidated<T>(path: string, schema: z.ZodType<T>): T | undefined {
    // Cache may hold the `undefined` sentinel (file absent) — `undefined` is a
    // legitimate cached state, so distinguish present-vs-absent via `has`.
    if (cache.has(path)) {
      return cache.get(path) as T | undefined;
    }
    let raw: string;
    try {
      raw = readFileTextSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        cache.set(path, undefined);
        return undefined;
      }
      // Unexpected read error — fail-soft: do not cache, return undefined.
      logger.warn(
        { submodule: "oauth-token-store", errorKind: "internal" as const, err: e },
        "Failed to read OAuth token-store file",
      );
      return undefined;
    }
    const parsed = schema.safeParse(safeJsonParse(raw));
    if (!parsed.success) {
      // Fail-soft: a truncated/partial external write must NOT crash.
      // Fall back to the last SUCCESSFULLY-parsed value (which survives the
      // watcher's cache.clear()) and log WARN. NEVER log the raw content (it
      // may contain tokens). We deliberately do NOT cache the bad value, so a
      // subsequent complete write is re-read on the next access.
      logger.warn(
        { submodule: "oauth-token-store", errorKind: "validation" as const },
        "OAuth token-store file failed schema validation; serving last-good value",
      );
      return lastGood.get(path) as T | undefined;
    }
    cache.set(path, parsed.data);
    lastGood.set(path, parsed.data);
    return parsed.data;
  }

  /**
   * Write JSON via the fs-safe substrate; throw on failure. The substrate
   * always `fchmod`s the fd to 0o600 (owner-only) — there is no `mode` option,
   * the 0o600 enforcement is unconditional.
   */
  function writeValidated(path: string, value: unknown): void {
    const result = writeRegularFile({
      path,
      content: JSON.stringify(value),
      confinedBaseDir,
    });
    if (!result.ok) {
      // @allow-throw: write failure (symlink swap, confinement escape, ENOSPC)
      // is a hard error the OAuthClientProvider caller must observe; the SDK's
      // saveTokens/saveClientInformation hooks treat a throw as a flow failure.
      throw result.error;
    }
    // Warm the read cache AND record last-good with the just-written value so
    // an immediate read does not re-parse disk. The value is exactly what
    // readValidated would parse back (it is the validated file shape). A
    // self-triggered watcher event later clears the read cache (a harmless
    // redundant re-read); last-good persists as the fail-soft fallback.
    cache.set(path, value);
    lastGood.set(path, value);
  }

  /** Best-effort unlink via the substrate-less node primitive (delete is not a write of secret content). */
  function unlinkIfExists(path: string): void {
    try {
      unlinkPathSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn(
          { submodule: "oauth-token-store", errorKind: "internal" as const, err: e },
          "Failed to unlink OAuth token-store file",
        );
      }
    }
    // Delete BOTH caches: the file is genuinely gone (logout), so the fail-soft
    // fallback must not resurrect a deleted token. The next read returns the
    // ENOENT sentinel (undefined).
    cache.delete(path);
    lastGood.delete(path);
  }

  // -------------------------------------------------------------------------
  // chokidar watcher. Pattern mirrors
  // packages/agent/src/model/oauth-token-manager.ts: atomic:100 coalesces the
  // substrate's unlink+create mtime churn; 100ms debounce; invalidate-and-
  // lazily-reload (no self-suppression needed — see module header).
  // -------------------------------------------------------------------------
  let watcher: FSWatcher | undefined;
  let debounceTimer: SystemTimeoutHandle | null = null;

  function scheduleCacheInvalidation(): void {
    if (debounceTimer) systemClearTimeout(debounceTimer);
    debounceTimer = systemSetTimeout(() => {
      debounceTimer = null;
      cache.clear();
      logger.debug?.(
        { submodule: "oauth-token-store", debouncedMs: WATCH_DEBOUNCE_MS },
        "mcp-tokens change detected; cache invalidated",
      );
    }, WATCH_DEBOUNCE_MS);
  }

  return {
    async tokens(server: string): Promise<OAuthTokens | undefined> {
      const file = readValidated(filePath(server, TOKEN_SUFFIX), TokenFileSchema);
      if (!file) return undefined;
      // Reconstruct the SDK-shaped object. The adapter's pre-flight relies on
      // Comis's own absolute `expiresAt`; we still rebuild a RELATIVE
      // `expires_in` (clamped at 0) for SDK code that inspects it.
      const remainingSec = Math.max(0, Math.floor((file.expiresAt - now()) / 1000));
      return {
        access_token: file.accessToken,
        token_type: file.tokenType,
        expires_in: remainingSec,
        ...(file.refreshToken !== undefined ? { refresh_token: file.refreshToken } : {}),
        ...(file.scope !== undefined ? { scope: file.scope } : {}),
      };
    },

    async saveTokens(server: string, sdkTokens: OAuthTokens): Promise<void> {
      // Compute ABSOLUTE expiry from the SDK's relative expires_in.
      // When expires_in is absent, fall back to a long sentinel TTL (see
      // SENTINEL_TTL_SEC) — the field is always populated with an absolute
      // value so there is never any relative-drift, while a token of unknown
      // lifetime is treated as long-lived rather than instantly expired.
      const ttlSec = sdkTokens.expires_in ?? SENTINEL_TTL_SEC;
      const expiresAt = now() + ttlSec * 1000;
      const file: TokenFile = {
        accessToken: sdkTokens.access_token,
        expiresAt,
        tokenType: sdkTokens.token_type,
        ...(sdkTokens.refresh_token !== undefined
          ? { refreshToken: sdkTokens.refresh_token }
          : {}),
        ...(sdkTokens.scope !== undefined ? { scope: sdkTokens.scope } : {}),
      };
      writeValidated(filePath(server, TOKEN_SUFFIX), file);
    },

    async clientInformation(server: string): Promise<OAuthClientInformationFull | undefined> {
      const file = readValidated(filePath(server, CLIENT_SUFFIX), ClientInfoFileSchema);
      // The persisted JSON is structurally an OAuthClientInformationFull (the
      // SDK validates it on use); the local schema is a structural minimum.
      return file as OAuthClientInformationFull | undefined;
    },

    async saveClientInformation(
      server: string,
      info: OAuthClientInformationFull,
    ): Promise<void> {
      writeValidated(filePath(server, CLIENT_SUFFIX), info);
    },

    async discoveryState(server: string): Promise<OAuthDiscoveryState | undefined> {
      const file = readValidated(filePath(server, META_SUFFIX), DiscoveryStateFileSchema);
      return file as OAuthDiscoveryState | undefined;
    },

    async saveDiscoveryState(server: string, state: OAuthDiscoveryState): Promise<void> {
      writeValidated(filePath(server, META_SUFFIX), state);
    },

    async deleteAll(server: string): Promise<void> {
      unlinkIfExists(filePath(server, TOKEN_SUFFIX));
      unlinkIfExists(filePath(server, CLIENT_SUFFIX));
      unlinkIfExists(filePath(server, META_SUFFIX));
    },

    startWatch(): Promise<void> {
      if (watcher) return Promise.resolve();
      const w = watch(tokensDir, {
        persistent: watchPersistent,
        ignoreInitial: true,
        atomic: WATCH_DEBOUNCE_MS,
        awaitWriteFinish: false,
        ...(watchUsePolling ? { usePolling: true, interval: 50 } : {}),
      });
      watcher = w;
      w.on("change", scheduleCacheInvalidation);
      w.on("unlink", scheduleCacheInvalidation);
      w.on("add", scheduleCacheInvalidation);
      w.on("error", (watchErr: unknown) => {
        logger.warn(
          { submodule: "oauth-token-store", errorKind: "internal" as const, err: watchErr },
          "mcp-tokens watcher errored",
        );
      });
      // Resolve once the initial scan completes so callers can await a watcher
      // that will reliably report subsequent external changes (chokidar
      // coalesces writes that race the initial scan under `atomic`).
      return new Promise<void>((resolve) => {
        w.once("ready", () => resolve());
      });
    },

    async close(): Promise<void> {
      if (debounceTimer) {
        systemClearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Thin node:fs READ/unlink indirections. The fs-safe substrate owns every
// WRITE of secret content; reads and unlinks carry no payload to leak, so they
// use node primitives directly (kept as named helpers so the arch-grep test has
// a stable target — it asserts the substrate is the sole write path).
// ---------------------------------------------------------------------------

function readFileTextSync(path: string): string {
  return nodeReadFileSync(path, "utf8");
}

function unlinkPathSync(path: string): void {
  nodeUnlinkSync(path);
}

/** JSON.parse that returns `undefined` on truncated/garbage input (fail-soft). */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
