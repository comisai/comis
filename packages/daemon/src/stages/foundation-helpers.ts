// SPDX-License-Identifier: Apache-2.0
// @allow-throw: foundation-stage bootstrap helpers; throws are caught by daemon.ts main().catch at the composition root.
/**
 * Foundation-stage helpers for daemon.ts's stageFoundation.
 *
 * Holds:
 *   - seedBundledSkillCreator
 *   - bootstrapSecretsAndEnv
 *   - wireConfigGitManager
 *   - emitBootstrapConfigObserveRecords (OBS-REVIEW-03 fix —
 *     daemon-bootstrap config.observe wiring)
 *   - scrubProcessEnv + SENSITIVE_PREFIXES + SENSITIVE_EXACT_KEYS
 *     (co-located with bootstrapSecretsAndEnv to avoid an import cycle —
 *     bootstrapSecretsAndEnv is the sole caller; the scrub helper is internal
 *     to the secrets-bootstrap path)
 *
 * Each helper is a top-level function (not a closure). Consumed by
 * stageFoundation in daemon.ts.
 *
 * @module
 */

import { createConfigGitManager, safePath } from "@comis/core";
import {
  appendConfigObserveAuditRecord,
  createConfigObserveAuditRecord,
  resolveConfigAuditLogPath,
  getDefaultConfigAuditConfinedBase,
} from "@comis/observability";
import type { SecretStorePort } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createSqliteSecretStore, type setupSecrets as _setupSecretsImpl } from "@comis/memory";
import type { setupLogging } from "../wiring/index.js";
import type { createExecGit } from "../config/exec-git.js";
import { existsSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { writeFile as fsWriteFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";

// ---------------------------------------------------------------------------
// process.env scrub — bootstrapSecretsAndEnv is the sole caller; co-located
// here to avoid an import cycle through daemon.ts.
// ---------------------------------------------------------------------------

/**
 * Sensitive environment variable prefixes to remove from process.env after
 * the SecretManager snapshot captures them. Prevents leakage through
 * subprocess inheritance.
 */
const SENSITIVE_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WHATSAPP_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "DEEPGRAM_",
  "ELEVENLABS_",
  "SENDGRID_",
  "STRIPE_",
] as const;

/** Individual keys to scrub that don't match prefix patterns. */
const SENSITIVE_EXACT_KEYS = new Set([
  "SECRETS_MASTER_KEY",
]);

/**
 * Remove sensitive environment variables from process.env.
 * Called AFTER mergedEnv snapshot is built but BEFORE bootstrap().
 * Preserves operational vars: COMIS_*, PATH, HOME, NODE_ENV, etc.
 *
 * COMIS_* PRESERVATION: `COMIS_DATA_DIR` and `COMIS_CONFIG_PATHS` are
 * INTENTIONALLY preserved across the scrub. They are filesystem-layout
 * pointers, not credentials -- subprocesses (MCP stdio servers, exec tools,
 * the apply-patch helper) need them to locate the daemon's data dir.
 *
 * Filesystem-layout pointers are still mildly sensitive (a misbehaving
 * subprocess could log them, surfacing the daemon's on-disk location). The
 * mitigation is per-spawn-site: untrusted-child spawns (exec-tool, MCP stdio
 * adapters, ffmpeg, etc.) MUST go through `envSubset(secretManager,
 * [...SUBPROCESS_SYSTEM])` -- see stageAgents -- which yields a minimal env
 * (PATH, HOME, LANG, ...) and explicitly EXCLUDES COMIS_*. New subprocess
 * spawn sites MUST follow this pattern; do NOT pass `process.env` directly
 * to a child even after scrub, because COMIS_* values are still present.
 */
function scrubProcessEnv(): void {

  for (const key of Object.keys(process.env)) {
    if (SENSITIVE_EXACT_KEYS.has(key)) {
      // eslint-disable-next-line no-restricted-syntax -- see scrubProcessEnv comment above
      delete process.env[key];
      continue;
    }
    for (const prefix of SENSITIVE_PREFIXES) {
      if (key.startsWith(prefix)) {
        // eslint-disable-next-line no-restricted-syntax -- see scrubProcessEnv comment above
        delete process.env[key];
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Foundation helpers
// ---------------------------------------------------------------------------

/**
 * Seed the bundled skill-creator skill into the user's data directory.
 * Idempotent: only writes if the destination is missing OR the bundled
 * version is newer than the installed version (frontmatter `version:` field).
 */
export function seedBundledSkillCreator(deps: {
  dataDir: string;
  agentLogger: ReturnType<typeof setupLogging>["agentLogger"];
}): void {
  const { dataDir, agentLogger } = deps;
  const skillsTarget = safePath(dataDir, "skills");
  const skillCreatorDest = safePath(skillsTarget, "skill-creator");
  const __filename = fileURLToPath(import.meta.url);
  // Relative path resolves to packages/daemon/bundled-skills/skill-creator from
  // this file's location in packages/daemon/src/stages/.
  const bundledSrc = pathResolve(__filename, "../../../bundled-skills/skill-creator");
  if (!existsSync(bundledSrc)) return;
  const bundledSkillMd = safePath(bundledSrc, "SKILL.md");
  const installedSkillMd = safePath(skillCreatorDest, "SKILL.md");
  let shouldSeed = !existsSync(skillCreatorDest);
  if (!shouldSeed && existsSync(bundledSkillMd) && existsSync(installedSkillMd)) {
    const extractVersion = (path: string): string | undefined => {
      try {
        const head = readFileSync(path, "utf-8").slice(0, 512);
        const match = head.match(/^version:\s*["']?([^"'\n]+)/m);
        return match?.[1]?.trim();
      } catch { return undefined; }
    };
    const bundledVersion = extractVersion(bundledSkillMd);
    const installedVersion = extractVersion(installedSkillMd);
    if (bundledVersion && bundledVersion !== installedVersion) {
      shouldSeed = true;
      agentLogger.info(
        { skill: "skill-creator", installedVersion: installedVersion ?? "none", bundledVersion },
        "Bundled skill-creator version newer than installed — updating",
      );
    }
  }
  if (shouldSeed) {
    mkdirSync(skillsTarget, { recursive: true });
    cpSync(bundledSrc, skillCreatorDest, { recursive: true });
    agentLogger.info({ skill: "skill-creator" }, "Bundled skill-creator seeded into data directory");
  }
}

/**
 * Bootstrap secrets and build merged-env / process.env scrub. Returns a
 * bundle of the secret store + crypto + db handle and the merged-env map.
 * Control flow: decryptAll throws → fatal; null secretsBootResult → no-op.
 */
export function bootstrapSecretsAndEnv(deps: {
  setupSecrets: typeof _setupSecretsImpl;
  dataDir: string;
}): {
  mergedEnv: Record<string, string | undefined>;
  secretStore: SecretStorePort | undefined;
  secretsCrypto: import("@comis/core").SecretsCrypto | undefined;
  secretsDb: import("better-sqlite3").Database | undefined;
} {
  const secretsBootResult = deps.setupSecrets({
    env: process.env as Record<string, string | undefined>,
    dataDir: deps.dataDir,
  });
  if (!secretsBootResult.ok) {
    throw new Error(`Secrets bootstrap failed: ${secretsBootResult.error.message}`);
  }
  if (secretsBootResult.value === null) {
    return {
      mergedEnv: process.env as Record<string, string | undefined>,
      secretStore: undefined,
      secretsCrypto: undefined,
      secretsDb: undefined,
    };
  }
  const { crypto, dbPath } = secretsBootResult.value;
  const store = createSqliteSecretStore(dbPath, crypto);
  const decryptResult = store.decryptAll();
  if (!decryptResult.ok) {
    throw new Error(`Secret decryption failed: ${decryptResult.error.message}`);
  }
  const merged: Record<string, string | undefined> = {};
  for (const [name, value] of decryptResult.value) merged[name] = value;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  scrubProcessEnv();
  return {
    mergedEnv: merged,
    secretStore: store as SecretStorePort,
    secretsCrypto: crypto,
    secretsDb: store.db,
  };
}

/**
 * Build a `ConfigGitManager` bound to `configDir` (or `undefined` if no config
 * file was resolved).
 */
export function wireConfigGitManager(deps: {
  configDir: string;
  execGit: ReturnType<typeof createExecGit>;
}): ReturnType<typeof createConfigGitManager> | undefined {
  if (!deps.configDir) return undefined;
  return createConfigGitManager({
    configDir: deps.configDir,
    execGit: deps.execGit,
    writeFile: async (relativePath, content) => {
      try {
        const targetPath = safePath(deps.configDir, relativePath);
        await fsWriteFile(targetPath, content, "utf-8");
        return ok(undefined);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
    removeDir: async (relativePath) => {
      try {
        const targetPath = safePath(deps.configDir, relativePath);
        await rm(targetPath, { recursive: true, force: true });
        return ok(undefined);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// OBS-REVIEW-03: emit config.observe records at daemon bootstrap config-read
// path. RED STUB — the GREEN implementation will dispatch into
// @comis/observability's `createConfigObserveAuditRecord` +
// `appendConfigObserveAuditRecord` for each resolved configPath, with
// Promise.allSettled() so a single append failure cannot abort daemon boot.
// ---------------------------------------------------------------------------

/** Parameters for `emitBootstrapConfigObserveRecords`. */
export interface EmitBootstrapConfigObserveRecordsParams {
  /** The list of resolved config paths the daemon read at boot. */
  readonly configPaths: readonly string[];
  /**
   * Optional override for the audit-log path. Production callers omit
   * this and let the helper resolve it via `resolveConfigAuditLogPath`
   * (which honors `COMIS_CONFIG_AUDIT_LOG`). Tests pass an explicit
   * path so they don't write into the real `~/.comis/`.
   */
  readonly auditLogPath?: string;
  /**
   * Optional override for the confinement base. Production callers
   * omit this and let the helper compute it via
   * `getDefaultConfigAuditConfinedBase`. Tests pass an explicit base
   * tied to the test's tmp dir.
   */
  readonly confinedBaseDir?: string;
}

/**
 * Emit one `event: "config.observe"` audit-log record per resolved
 * configPath entry at daemon bootstrap. Closes OBS-REVIEW-03.
 *
 * Dispatch model: `Promise.allSettled` over per-path appends so a
 * single failure (audit log unwritable, dir permission, ENOSPC) does
 * not propagate and abort daemon startup. The audit log is a
 * forensics aid, not a correctness gate.
 *
 * No-op when `configPaths` is empty — the daemon may legitimately
 * bootstrap with no config files when the operator hasn't seeded
 * any (the build of `AppConfig` falls back to schema defaults).
 */
export async function emitBootstrapConfigObserveRecords(
  params: EmitBootstrapConfigObserveRecordsParams,
): Promise<void> {
  if (params.configPaths.length === 0) return;

  const auditLogPath = params.auditLogPath ?? resolveConfigAuditLogPath();
  const confinedBaseDir =
    params.confinedBaseDir ?? getDefaultConfigAuditConfinedBase(auditLogPath);

  const appendPromises = params.configPaths.map(async (cfgPath) => {
    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });
    return appendConfigObserveAuditRecord({
      filePath: auditLogPath,
      record,
      ...(confinedBaseDir !== undefined
        ? { confinedBaseDir }
        : {}),
    });
  });

  // Settle all appends — failures are recorded in the returned
  // results but never thrown back at the caller. Audit failures at
  // boot are non-fatal.
  await Promise.allSettled(appendPromises);
}
