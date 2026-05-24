// SPDX-License-Identifier: Apache-2.0
// @allow-throw: applyBundleInstall is invoked from RPC handler bodies whose
// @allow-throw header already covers throw → JSON-RPC error conversion.
/**
 * Phase 68 BUNDLE-05/06 (Plan 04) — applyBundleInstall: install-path hook.
 *
 * Invoked from the three skill install RPC handlers (skills.import,
 * skills.create, skills.upload) AFTER the existing file-write + registry.init()
 * steps. Reads the freshly-written SKILL.md, runs Phase A via resolveBundle
 * (Plan 03), and on success commits via persistMcpServers (Plan 01) + a
 * sequential per-entry manager.connect.
 *
 * Atomic two-phase invariant (BUNDLE-06 / 68-P5): Phase A reject ⇒ THROW
 * before any persist call. The throw fires before persistMcpServers and
 * before any deps.mcpClientManager.connect — so a partial OSV reject in a
 * 3-entry bundle commits ZERO writes and ZERO connects. The caller's outer
 * try block (rpc-dispatch.ts) surfaces the bracketed-code error to the RPC
 * client.
 *
 * Phase B per-entry connect failures are isolated: a single entry's connect
 * failure logs a WARN with errorKind:"dependency" and continues. The persist
 * call already succeeded — we do NOT unwind the YAML write because the entry
 * IS correctly persisted (the operator can re-connect later via
 * `mcp.reconnect` or, for OAuth, `mcp.login`).
 *
 * Extracted from skill-handlers.ts to keep that file under the 800-line cap.
 *
 * Cycle-safety note (mirrors bundle-mcp-resolver.ts): this file lives INSIDE
 * `packages/daemon/src/`, so persistMcpServers is imported via its LEAF
 * module path (`../api/shared/persist-mcp-servers.js`) rather than the
 * `@comis/daemon` barrel — a barrel import would close a self-cycle through
 * `packages/daemon/src/index.ts`.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { safePath } from "@comis/core";
import { parseSkillManifest } from "@comis/skills";
import type { McpServerEntry } from "@comis/core";
import { persistMcpServers, type PersistMcpResult } from "../api/shared/persist-mcp-servers.js";
import { resolveBundle } from "./bundle-mcp-resolver.js";
import type { BundleError } from "./bundle-types.js";
import type { WorkspaceApiDeps } from "../api/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to applyBundleInstall — assembled by the install RPC handler. */
export interface ApplyBundleInstallArgs {
  /** The freshly-installed skill's name (used as _bundleSource and audit entityId). */
  readonly skillId: string;
  /** Absolute path to the skill directory; the helper reads SKILL.md from here. */
  readonly skillDir: string;
  /** Optional --force flag from the RPC request (defaults via the caller). */
  readonly force: boolean;
  /** Internal _context bag from rawParams._context (optional userId + traceId). */
  readonly ctx: { userId?: string; traceId?: string } | undefined;
  /** Handler deps slice (must include persistDeps + container + mcpClientManager). */
  readonly deps: WorkspaceApiDeps;
}

/** Result of applyBundleInstall — forwarded for log/audit purposes. */
export interface ApplyBundleInstallResult {
  /** Persist outcome forwarded from persistMcpServers, or "skipped" when no bundle ran. */
  readonly persistence: PersistMcpResult["persistence"];
  /** Per-entry connect outcomes (operator-visible in install response logs). */
  readonly connectResults?: ReadonlyArray<{ name: string; ok: boolean; error?: string }>;
  /** Optional warning forwarded when persistence === "runtime_only" or manifest parse failed. */
  readonly warning?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a BundleError into a human-readable suffix appended to the
 * `[bundle_install_rejected:<kind>]` bracketed-code RPC error.
 *
 * The bracketed code is the machine-readable part; this string is the
 * operator-facing hint that follows.
 */
export function formatBundleError(error: BundleError): string {
  switch (error.kind) {
    case "name_collision":
      return error.collisions
        .map(({ name, existingBundleSource, thisSkill }) =>
          existingBundleSource !== undefined
            ? `'${name}' is already owned by skill '${existingBundleSource}' (this install: '${thisSkill}'); pass force=true to archive the prior entry`
            : `'${name}' is a user-owned entry; pass force=true to archive it under _bundleArchive`,
        )
        .join("; ");
    case "plaintext_secret":
      return `bundle entry '${error.serverName}' has a plaintext-secret-shaped value at env.${error.envKey}; reference secrets via \${KEY} env-refs instead`;
    case "osv_malware":
      return `bundle entry '${error.serverName}' depends on package '${error.packageName}' flagged by OSV: ${error.advisoryIds.join(",")}`;
    case "schema_invalid":
      return `bundle schema invalid: ${error.details}`;
  }
}

/**
 * Project a persisted McpServerEntry into an McpServerConfig for
 * manager.connect. Mirrors setup-mcp.ts's per-entry projection (the boot
 * path's connect site). Forwards the Phase 65/66/67 fields so the manager
 * sees the canonical runtime shape.
 *
 * Returns `unknown` to avoid a static import of the @comis/skills runtime
 * types — the manager.connect signature accepts the structurally compatible
 * McpServerConfig at the call site.
 */
function buildRuntimeConfig(
  entry: McpServerEntry,
  mcpConfigRoot:
    | {
        safetyAllowedEnvKeys?: readonly string[];
        osvCheckEnabled?: boolean;
        osvCacheTtlMs?: number;
      }
    | undefined,
): Record<string, unknown> {
  return {
    name: entry.name,
    transport: entry.transport,
    ...(entry.command !== undefined && { command: entry.command }),
    ...(entry.args !== undefined && { args: entry.args }),
    ...(entry.url !== undefined && { url: entry.url }),
    ...(entry.env !== undefined && { env: entry.env }),
    ...(entry.headers !== undefined && { headers: entry.headers }),
    ...(entry.maxConcurrency !== undefined && { maxConcurrency: entry.maxConcurrency }),
    enabled: true,
    // Phase 63 SAFETY-02/06/08: forward operator-level safety toggles.
    ...(mcpConfigRoot?.safetyAllowedEnvKeys !== undefined && {
      safetyAllowedEnvKeys: mcpConfigRoot.safetyAllowedEnvKeys,
    }),
    ...(mcpConfigRoot?.osvCheckEnabled !== undefined && {
      osvCheckEnabled: mcpConfigRoot.osvCheckEnabled,
    }),
    ...(mcpConfigRoot?.osvCacheTtlMs !== undefined && { osvCacheTtlMs: mcpConfigRoot.osvCacheTtlMs }),
    ...(entry.rlimits !== undefined && { rlimits: entry.rlimits }),
    // Phase 64 RELY-02/05: forward per-server reliability overrides.
    ...(entry.keepaliveIntervalMs !== undefined && {
      keepaliveIntervalMs: entry.keepaliveIntervalMs,
    }),
    ...(entry.circuitBreakerThreshold !== undefined && {
      circuitBreakerThreshold: entry.circuitBreakerThreshold,
    }),
    ...(entry.circuitBreakerCooldownMs !== undefined && {
      circuitBreakerCooldownMs: entry.circuitBreakerCooldownMs,
    }),
    // Phase 65 OPUX-08/09/10: forward per-server tool filtering + idle + utility opt-outs.
    ...(entry.idleTtlMs !== undefined && entry.idleTtlMs > 0 && { idleTtlMs: entry.idleTtlMs }),
    ...(entry.toolAllowlist !== undefined && { toolAllowlist: entry.toolAllowlist }),
    ...(entry.toolBlocklist !== undefined && { toolBlocklist: entry.toolBlocklist }),
    ...(entry.enableResources !== undefined && { enableResources: entry.enableResources }),
    ...(entry.enablePrompts !== undefined && { enablePrompts: entry.enablePrompts }),
    // Phase 67 CAP-02: forward parallel-tool-calls opt-in.
    ...(entry.supportsParallelToolCalls !== undefined && {
      supportsParallelToolCalls: entry.supportsParallelToolCalls,
    }),
    // Phase 66 OAUTH-10/11: forward auth/oauth so createTransport wires
    // the OAuthClientProvider for stdio→sse→http transports.
    ...(entry.auth !== undefined && { auth: entry.auth }),
    ...(entry.oauth !== undefined && { oauth: entry.oauth }),
  };
}

// ---------------------------------------------------------------------------
// Phase B commit orchestrator
// ---------------------------------------------------------------------------

/**
 * Phase A + Phase B orchestrator for the install-path bundle hook.
 *
 * Steps:
 *   1. Read freshly-written SKILL.md from `skillDir` (safePath-resolved).
 *   2. Parse the manifest — if parse fails OR the manifest carries no
 *      `mcpServers` block, return `{ persistence: "skipped" }` silently.
 *   3. PHASE A: call resolveBundle. On Result.err ⇒ THROW the bracketed
 *      `[bundle_install_rejected:<kind>]` error. NO persist call has fired
 *      yet; NO manager.connect has fired. Atomic invariant satisfied.
 *   4. PHASE B: call persistMcpServers ONCE with the merged nextServers.
 *   5. For each entry in `connectQueue`, await manager.connect(config). A
 *      per-entry failure logs WARN with errorKind:"dependency" and continues
 *      — the persist already succeeded; we do not unwind it because the
 *      entry IS persisted (the operator can `mcp.reconnect` or `mcp.login`
 *      later).
 *
 * @param args See ApplyBundleInstallArgs.
 * @returns ApplyBundleInstallResult with persist + connect outcomes.
 * @throws Error[bundle_install_rejected:<kind>] when Phase A rejects.
 */
export async function applyBundleInstall(
  args: ApplyBundleInstallArgs,
): Promise<ApplyBundleInstallResult> {
  const { skillId, skillDir, force, ctx, deps } = args;

  // STEP 1: read freshly-written SKILL.md from disk.
  const skillMdPath = safePath(skillDir, "SKILL.md");
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf-8");
  } catch (e) {
    // The skill file write step is the caller's responsibility; if SKILL.md
    // is unreadable at this point, the install itself succeeded but bundle
    // wiring is skipped. Surface a structured warning for the install
    // response payload.
    return {
      persistence: "skipped",
      warning: `SKILL.md unreadable at ${skillMdPath}: ${(e as Error).message}`,
    };
  }

  // STEP 2: parse + check for the mcpServers block.
  const manifestResult = parseSkillManifest(content);
  if (!manifestResult.ok) {
    // Manifest parse failed; the skill file is still installed but the
    // discovery sweep already logged the parse error. Skip the bundle hook.
    return {
      persistence: "skipped",
      warning: `manifest parse failed: ${manifestResult.error.message}`,
    };
  }

  const bundleServers = manifestResult.value.mcpServers;
  if (bundleServers === undefined || bundleServers.length === 0) {
    // No bundle block ⇒ pre-Phase-68 install behavior (silent no-op).
    return { persistence: "skipped" };
  }

  // STEP 3: PHASE A — pure validation + merge. NO side effects.
  const mcpConfigRoot = (
    deps.container?.config?.integrations as
      | {
          mcp?: {
            servers?: McpServerEntry[];
            safetyAllowedEnvKeys?: readonly string[];
            osvCheckEnabled?: boolean;
            osvCacheTtlMs?: number;
          };
        }
      | undefined
  )?.mcp;
  const currentServers = (mcpConfigRoot?.servers ?? []) as McpServerEntry[];

  const resolveResult = await resolveBundle({
    skillId,
    manifestMcpServers: bundleServers,
    currentServers,
    force,
    ...(mcpConfigRoot?.osvCheckEnabled !== undefined && {
      osvCheckEnabled: mcpConfigRoot.osvCheckEnabled,
    }),
    ...(mcpConfigRoot?.osvCacheTtlMs !== undefined && {
      osvCacheTtlMs: mcpConfigRoot.osvCacheTtlMs,
    }),
    logger: deps.logger,
  });

  if (!resolveResult.ok) {
    // BUNDLE-06 atomic invariant: Phase A reject ⇒ THROW before any
    // persistMcpServers or manager.connect call. The caller's outer
    // try/catch surfaces this as the bracketed-code RPC error.
    throw new Error(
      `[bundle_install_rejected:${resolveResult.error.kind}] ${formatBundleError(resolveResult.error)}`,
    );
  }

  const { nextServers, connectQueue, archivedOverrides } = resolveResult.value;

  // Log archived overrides (structured; never logs secret values — only
  // names + cause). This lands BEFORE persist so operators see the archive
  // intent even on a partial Phase B connect failure.
  if (archivedOverrides.length > 0) {
    deps.logger.info(
      {
        method: "skills.bundle.install",
        entityId: skillId,
        archivedCount: archivedOverrides.length,
        archived: archivedOverrides.map((a) => ({ name: a.name, cause: a.cause })),
        hint: "Bundle install archived prior entries under _bundleArchive",
      },
      "Bundle install: archived overrides",
    );
  }

  // STEP 4: PHASE B — commit. persistMcpServers is the single sanctioned
  // writer (Phase 62 / Plan 01 SSOT). One atomic write covers all N
  // bundled entries.
  const persistOutcome = await persistMcpServers(
    deps,
    [...nextServers] as McpServerEntry[],
    "skills.bundle.install",
    skillId,
    ctx,
  );

  // STEP 5: per-entry connect. Failures isolated (WARN + continue); do
  // NOT unwind the persist because the entry IS correctly persisted.
  const connectResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const entry of connectQueue) {
    if (deps.mcpClientManager === undefined) {
      connectResults.push({
        name: entry.name,
        ok: false,
        error: "no mcpClientManager wired in deps",
      });
      continue;
    }
    const config = buildRuntimeConfig(entry, mcpConfigRoot);
    try {
      const connectResult = await deps.mcpClientManager.connect(config as never);
      if (connectResult.ok) {
        connectResults.push({ name: entry.name, ok: true });
      } else {
        const errMsg = connectResult.error.message;
        connectResults.push({ name: entry.name, ok: false, error: errMsg });
        deps.logger.warn(
          {
            method: "skills.bundle.install",
            entityId: entry.name,
            skillId,
            err: errMsg,
            hint: `Bundle MCP '${entry.name}' failed to connect; entry persisted but offline (operator may run 'mcp.reconnect' or, for OAuth, 'mcp.login')`,
            errorKind: "dependency" as const,
          },
          "Bundled MCP connect failed (persist succeeded)",
        );
      }
    } catch (e) {
      const errMsg = (e as Error).message;
      connectResults.push({ name: entry.name, ok: false, error: errMsg });
      deps.logger.warn(
        {
          method: "skills.bundle.install",
          entityId: entry.name,
          skillId,
          err: errMsg,
          hint: `Bundle MCP '${entry.name}' connect threw; entry persisted but offline`,
          errorKind: "dependency" as const,
        },
        "Bundled MCP connect threw (persist succeeded)",
      );
    }
  }

  return {
    persistence: persistOutcome.persistence,
    connectResults,
    ...(persistOutcome.warning !== undefined && { warning: persistOutcome.warning }),
  };
}
