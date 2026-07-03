// SPDX-License-Identifier: Apache-2.0
// @allow-throw: builtin tool boundary; throws caught by AgentTool wrapper.
/**
 * Exec tool shared helpers.
 *
 * Extracted from `exec-tool.ts` (1,626L monolith). Block-move of the 10
 * module-level helpers (resolveCwd, killTree, buildSpawnCommand,
 * resolveDataEnv, commandUsesRawInterpreter, resolveSecretRefs, ecosystemFor,
 * buildInstallDetourHint, buildSoftStopErrorTemplate, buildInstallDetourEventPayload)
 * plus two factory-body extractions (evaluateInstallDetourGate, buildExecEnv)
 * required to keep `index.ts` thin.
 *
 * @module
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PathTraversalError, safePath, systemEnvSnapshot, systemNowMs, tryGetContext } from "@comis/core";
import type { SecretManager, ToolCapabilityPort, ApprovalGate, TypedEventBus } from "@comis/core";
import type { ExecSandboxConfig } from "../sandbox/types.js";
import { resolvePaths } from "../file/safe-path-wrapper.js";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";
import { parseInstallDetour, type InstallDetourDecision, type DetourOverlap } from "../install-detour.js";
import { SECRET_REF_NAME_PATTERN, type ToolLogger } from "./exec-types.js";

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied `cwd` against the workspace root via safePath.
 * Throws via throwToolError when the path escapes workspace bounds.
 */
export function resolveCwd(workspacePath: string, cwdParam: string): string {
  try {
    return safePath(workspacePath, cwdParam);
  } catch (error) {
    if (error instanceof PathTraversalError) {
      throwToolError(
        "invalid_value",
        `Working directory outside workspace bounds: ${cwdParam}`,
      );
    }
    throw error;
  }
  // unreachable — throwToolError never returns, but TS needs this
  return workspacePath;
}

// ---------------------------------------------------------------------------
// Process tree kill
// ---------------------------------------------------------------------------

/**
 * Kill a process tree. When sandboxed, uses positive PID kill (bwrap's
 * --die-with-parent + --unshare-pid cascade to all children). When not
 * sandboxed, uses negative PID (process group kill) with fallback to
 * direct PID kill.
 */
export function killTree(pid: number, sandboxed: boolean): void {
  try {
    if (sandboxed) {
      process.kill(pid, "SIGKILL");
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead
    }
  }
}

// ---------------------------------------------------------------------------
// Sandbox spawn command builder
// ---------------------------------------------------------------------------

/**
 * Build spawn command arguments, optionally wrapping in the platform sandbox
 * and/or a PTY via Python pty.spawn. Exported for direct unit testing.
 */
export function buildSpawnCommand(
  command: string,
  cwd: string,
  sandboxConfig: ExecSandboxConfig | undefined,
  workspacePath: string,
  tempDir: string,
  pty?: boolean,
): { bin: string; args: string[]; cwd: string | undefined } {
  let result: { bin: string; args: string[]; cwd: string | undefined };

  if (!sandboxConfig) {
    result = { bin: "/bin/bash", args: ["-c", command], cwd };
  } else {
    const allReadOnlyPaths = [
      ...sandboxConfig.readOnlyPaths,
      ...sandboxConfig.configReadOnlyPaths,
    ];
    const resolvedShared = resolvePaths(sandboxConfig.sharedPaths);
    const sandboxArgs = sandboxConfig.sandbox.buildArgs({
      workspacePath,
      sharedPaths: resolvedShared,
      readOnlyPaths: allReadOnlyPaths,
      cwd,
      tempDir,
      // Forward network + secureCredentialHome from ExecSandboxConfig to
      // SandboxOptions. Undefined = open/unsecured (no regression).
      network: sandboxConfig.network,
      secureCredentialHome: sandboxConfig.secureCredentialHome,
    });
    // bwrap handles cwd internally via --chdir; sandbox-exec does not.
    const providerHandlesCwd = sandboxConfig.sandbox.name === "bwrap";
    result = {
      bin: sandboxArgs[0],
      args: [...sandboxArgs.slice(1), "/bin/bash", "-c", command],
      cwd: providerHandlesCwd ? undefined : cwd,
    };
  }

  // PTY via Python pty.spawn(): creates a PTY pair via openpty(), forks,
  // connects the child to the PTY slave, and proxies I/O between piped
  // stdin/stdout and the PTY master. Handles piped stdin gracefully where
  // `script` would fail with tcgetattr on non-TTY stdin.
  if (pty) {
    result = {
      bin: "python3",
      args: ["-c", "import pty,sys;sys.exit(pty.spawn(sys.argv[1:]))", result.bin, ...result.args],
      cwd: result.cwd,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// secretRefs helpers
// ---------------------------------------------------------------------------

/** Workspace-local data env — python/matplotlib subprocesses only, not inheriting daemon PATH. */
function resolveDataEnv(opts: { workspaceDir: string }): Record<string, string> {
  const venvBin = safePath(opts.workspaceDir, "venv", "bin");
  const cacheDir = safePath(opts.workspaceDir, ".cache");
  const mplDir = safePath(cacheDir, "matplotlib");
  return {
    PATH: venvBin,
    MPLCONFIGDIR: mplDir,
    XDG_CACHE_HOME: cacheDir,
    MPLBACKEND: "Agg",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

/**
 * Detect raw-interpreter command shapes (python -c, node -e, bash -c, etc.).
 * Used to refuse secretRefs on commands where `echo $TOKEN` would be trivial.
 */
export function commandUsesRawInterpreter(command: string): boolean {
  const stripped = command
    .replace(/^\s*cd\s+\S+\s*&&\s*/i, "")
    .replace(/^\s*env\s+(?:[A-Z_][A-Z0-9_]*=\S+\s+)*/i, "")
    .trim();
  const rawPattern =
    /^(python3?|node|nodejs|ruby|perl|php|bash|sh|zsh|dash|lua|deno|bun)(?:\s+-[cCeE](?:\s+|$)|\s+-(?:\s|$))/i;
  return rawPattern.test(stripped);
}

/**
 * Resolve a list of secret names into an env-var record via SecretManager.
 * Rejects invalid names, platform-managed names, and missing names.
 * The returned record is merged into the child's env AFTER userEnv so
 * `secretRefs` wins on collision.
 */
export function resolveSecretRefs(
  refs: string[],
  secretManager: SecretManager,
  platformSecretNames: ReadonlySet<string>,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {};
  const seen = new Set<string>();

  for (const name of refs) {
    if (typeof name !== "string" || !SECRET_REF_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `Invalid secretRefs name "${String(name)}". Names must match /^[A-Z][A-Z0-9_]*$/ (e.g. CLOUDFLARE_API_TOKEN).`,
      };
    }
    if (seen.has(name)) continue;
    seen.add(name);

    if (platformSecretNames.has(name)) {
      return {
        ok: false,
        error:
          `Secret "${name}" is referenced by the daemon config and is platform-managed — ` +
          `exec cannot expose it. This rule prevents agents from exfiltrating credentials ` +
          `the daemon uses to talk to providers. Ask the user to store a separate ` +
          `user-task secret under a different name, or invoke this command locally.`,
      };
    }

    const value = secretManager.get(name);
    if (value === undefined || value.length === 0) {
      return {
        ok: false,
        error:
          `Secret "${name}" is not configured. Call gateway(action:"env_list", filter:"${name.split("_")[0]}*") ` +
          `to see available names, or ask the user to store it via env_set.`,
      };
    }
    env[name] = value;
  }

  return { ok: true, env };
}

// ---------------------------------------------------------------------------
// Install-detour helpers
// ---------------------------------------------------------------------------

function ecosystemFor(pm: "pip" | "npm" | "pnpm" | "yarn"): "python" | "node" {
  return pm === "pip" ? "python" : "node";
}

/**
 * Build the structured install-detour hint augmentation for advise mode.
 * Returns BOTH a string (for `details.installDetourHint`) AND a sibling
 * `[hint]` content block (for the `result.content` array).
 */
export function buildInstallDetourHint(decision: InstallDetourDecision): {
  installDetourHint: string;
  hintContentBlock: { type: "text"; text: string };
} {
  const lines = decision.overlaps.map((o) => {
    const cluster = o.cluster ? ` (cluster: ${o.cluster})` : "";
    return o.sourceType === "mcp"
      ? `- ${o.packageName} -> connected MCP server "${o.sourceName}"${cluster}`
      : `- ${o.packageName} -> available skill "${o.sourceName}"${cluster}`;
  });
  const text =
    `[hint] Installed packages overlap available capabilities:\n${lines.join("\n")}\n` +
    `If you can use these capabilities directly, do so before relying on the install.`;
  return {
    installDetourHint: text,
    hintContentBlock: { type: "text", text },
  };
}

/**
 * Build the soft-stop error template. Returns null when no overlap source
 * remains connected/visible at error-build time (overlaps disappeared
 * mid-call; refusal no longer justified — caller falls through to spawn).
 */
function buildSoftStopErrorTemplate(
  decision: InstallDetourDecision,
  port: ToolCapabilityPort,
): string | null {
  const connectedServers = new Set(port.getConnectedMcpServers());
  const visibleSkills = new Set(port.getPromptSkillCapabilities().map((s) => s.name));
  const filtered = decision.overlaps.filter((o) =>
    o.sourceType === "mcp" ? connectedServers.has(o.sourceName) : visibleSkills.has(o.sourceName),
  );
  if (filtered.length === 0) return null;

  const bullets = filtered.map((o) => {
    const cluster = o.cluster ? ` (cluster: ${o.cluster})` : "";
    return o.sourceType === "mcp"
      ? `- ${o.packageName} -> connected MCP server "${o.sourceName}"${cluster}`
      : `- ${o.packageName} -> available skill "${o.sourceName}"${cluster}`;
  });

  return [
    "Refused: install overlaps with available capability source(s).",
    "",
    "Overlapping packages:",
    ...bullets,
    "",
    "To proceed, choose one:",
    "1. Use the connected tool(s) or available skill(s) listed above for the overlapping work.",
    "2. If you only need the non-overlapping packages, rerun exec with the overlapping ones removed.",
    "3. If you genuinely need the install despite the overlap, ask the user/operator to approve the install-detour override, then rerun this exact command with `allowInstallDetour: true`.",
  ].join("\n");
}

/**
 * Build the closed `tool:install_detour_detected` event payload. Sanitized
 * only: NEVER includes `command`, `rawCommand`, `stdout`, `stderr`, raw shell
 * fragments, URLs, paths, or credentials.
 */
function buildInstallDetourEventPayload(
  decision: InstallDetourDecision,
  mode: "observe" | "advise" | "soft-stop",
  action:
    | "observed"
    | "hinted"
    | "soft_stopped"
    | "override_requested"
    | "overridden"
    | "override_denied",
): {
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly traceId?: string;
  readonly packageManager: "pip" | "npm" | "pnpm" | "yarn";
  readonly commandDigest: string;
  readonly packages: ReadonlyArray<{ readonly normalizedName: string; readonly ecosystem: "python" | "node" }>;
  readonly overlaps: ReadonlyArray<{
    readonly packageName: string;
    readonly sourceType: "mcp" | "skill";
    readonly sourceName: string;
    readonly reason: DetourOverlap["reason"];
  }>;
  readonly mode: "observe" | "advise" | "soft-stop";
  readonly action: "observed" | "hinted" | "soft_stopped" | "override_requested" | "overridden" | "override_denied";
  readonly timestamp: number;
} {
  const ctx = tryGetContext();
  return {
    // RequestContext has no `agentId` field — `userId` is the agent
    // identity (matches evaluateInstallDetourGate's approval-gate precedent
    // below). sessionKey is a separate formatted key and must not shadow it.
    agentId: ctx?.userId ?? "unknown",
    sessionKey: ctx?.sessionKey ?? "unknown",
    traceId: ctx?.traceId,
    packageManager: decision.packageManager,
    commandDigest: decision.commandDigest,
    packages: decision.packages.map((p) => ({
      normalizedName: p,
      ecosystem: ecosystemFor(decision.packageManager),
    })),
    overlaps: decision.overlaps.map((o) => ({
      packageName: o.packageName,
      sourceType: o.sourceType,
      sourceName: o.sourceName,
      reason: o.reason,
    })),
    mode,
    action,
    timestamp: systemNowMs(),
  };
}

// ---------------------------------------------------------------------------
// Factory-body extractions (keep index.ts thin)
// ---------------------------------------------------------------------------

/**
 * Result of the install-detour mode policy gate. `errorMessage !== null` =>
 * caller throws via `throwToolError("permission_denied", errorMessage)`.
 */
export interface InstallDetourGateOutcome {
  decision: InstallDetourDecision | null;
  mode: "observe" | "advise" | "soft-stop";
  errorMessage: string | null;
}

/**
 * Run the install-detour policy gate BEFORE any subprocess spawn. Decision
 * computed ONCE here, propagated to event emission + ProcessSession + envelope.
 * Block-extracted from the createExecTool factory.
 */
export async function evaluateInstallDetourGate(deps: {
  command: string;
  allowInstallDetourOverride: boolean;
  toolCapabilityPort: ToolCapabilityPort;
  approvalGate?: ApprovalGate;
  eventBus?: TypedEventBus;
  logger?: ToolLogger;
}): Promise<InstallDetourGateOutcome> {
  const { command, allowInstallDetourOverride, toolCapabilityPort, approvalGate, eventBus, logger } = deps;
  const installDetourMode = toolCapabilityPort.getInstallDetourMode();
  const installDetourDecision = parseInstallDetour(command, toolCapabilityPort);
  let terminalAction:
    | "observed" | "hinted" | "soft_stopped"
    | "override_requested" | "overridden" | "override_denied"
    | "no-decision" = "no-decision";

  let errorMessage: string | null = null;

  if (installDetourDecision !== null) {
    if (installDetourMode === "observe") {
      for (const overlap of installDetourDecision.overlaps) {
        eventBus?.emit("tool:install_detour_detected",
          buildInstallDetourEventPayload({ ...installDetourDecision, overlaps: [overlap] }, "observe", "observed"));
        terminalAction = "observed";
      }
    } else if (installDetourMode === "advise") {
      for (const overlap of installDetourDecision.overlaps) {
        eventBus?.emit("tool:install_detour_detected",
          buildInstallDetourEventPayload({ ...installDetourDecision, overlaps: [overlap] }, "advise", "hinted"));
        terminalAction = "hinted";
      }
    } else if (installDetourMode === "soft-stop") {
      if (!allowInstallDetourOverride) {
        eventBus?.emit("tool:install_detour_detected",
          buildInstallDetourEventPayload(installDetourDecision, "soft-stop", "soft_stopped"));
        terminalAction = "soft_stopped";
        const built = buildSoftStopErrorTemplate(installDetourDecision, toolCapabilityPort);
        if (built === null) {
          logger?.debug(
            { toolName: "exec", commandDigest: installDetourDecision.commandDigest, mode: "soft-stop", outcome: "overlaps-disappeared" },
            "install-detour overlap sources disappeared mid-call; falling through to spawn",
          );
        } else {
          errorMessage = built;
        }
      } else {
        const ctx = tryGetContext();
        if (!approvalGate || !ctx) {
          eventBus?.emit("tool:install_detour_detected",
            buildInstallDetourEventPayload(installDetourDecision, "soft-stop", "override_denied"));
          terminalAction = "override_denied";
          const built = buildSoftStopErrorTemplate(installDetourDecision, toolCapabilityPort);
          errorMessage = built ?? "Install-detour override denied: missing approval gate or request context.";
        } else {
          // override_requested event is emitted BEFORE the await (event-pair
          // contract). terminalAction is NOT set here because both downstream
          // branches (resolution.approved / !approved) reassign it; the
          // event-bus emit is the observable signal of the override-request.
          eventBus?.emit("tool:install_detour_detected",
            buildInstallDetourEventPayload(installDetourDecision, "soft-stop", "override_requested"));
          const resolution = await approvalGate.requestApproval({
            toolName: "exec",
            action: `exec.install_detour.override:${installDetourDecision.commandDigest}`,
            params: {
              packageManager: installDetourDecision.packageManager,
              packages: installDetourDecision.packages,
              overlaps: installDetourDecision.overlaps,
              mode: "soft-stop",
              commandDigest: installDetourDecision.commandDigest,
            },
            agentId: ctx.userId ?? "unknown",
            sessionKey: ctx.sessionKey ?? "",
            trustLevel: (ctx.trustLevel ?? "admin") as "admin" | "user" | "guest",
            channelType: ctx.channelType,
          });
          if (!resolution.approved) {
            eventBus?.emit("tool:install_detour_detected",
              buildInstallDetourEventPayload(installDetourDecision, "soft-stop", "override_denied"));
            terminalAction = "override_denied";
            errorMessage = `Install-detour override denied: ${resolution.reason ?? "no reason given"}`;
          } else {
            eventBus?.emit("tool:install_detour_detected",
              buildInstallDetourEventPayload(installDetourDecision, "soft-stop", "overridden"));
            terminalAction = "overridden";
          }
        }
      }
    }

    logger?.info(
      {
        toolName: "exec",
        commandDigest: installDetourDecision.commandDigest,
        packageManager: installDetourDecision.packageManager,
        packageCount: installDetourDecision.packages.length,
        overlapCount: installDetourDecision.overlaps.length,
        mode: installDetourMode,
        action: terminalAction,
      },
      "install-detour policy gate evaluated",
    );
  }

  return { decision: installDetourDecision, mode: installDetourMode, errorMessage };
}

// ---------------------------------------------------------------------------
// Warm venv seed
// ---------------------------------------------------------------------------

/** Sentinel file written inside venv/ once seed packages are installed. */
const VENV_SEED_SENTINEL = ".seed-done";

/**
 * Lock directory serializing concurrent ensureWarmVenvSeed callers. Atomic
 * `mkdirSync(..., {recursive:false})` gives O_CREAT|O_EXCL semantics on POSIX:
 * the loser receives EEXIST and bails. Exported for tests.
 */
export const VENV_SEED_LOCK_DIR = ".seed-lock";

/**
 * Install seed packages into the workspace venv on first creation. Idempotent:
 * skips if `.seed-done` exists; no-op on empty packages.
 *
 * Concurrency: two callers passing existsSync would both spawn pip
 * (wasted CPU + risk on write-locked FS). The mkdir lock serializes; the
 * finally{} releases on success AND pip-failure so transient errors do not
 * wedge the venv.
 *
 * Packages come from operator config validated by Zod; spawned
 * via explicit array args (no shell string injection).
 */
export function ensureWarmVenvSeed(
  workspacePath: string,
  packages: string[],
  logger?: ToolLogger,
): void {
  if (packages.length === 0) return;
  const venvDir = safePath(workspacePath, "venv");
  const sentinelPath = safePath(venvDir, VENV_SEED_SENTINEL);
  if (existsSync(sentinelPath)) return;
  const lockPath = safePath(venvDir, VENV_SEED_LOCK_DIR);

  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const isEexist = code === "EEXIST";
    logger?.debug(
      {
        workspaceDir: workspacePath,
        err: isEexist ? undefined : err instanceof Error ? err.message : String(err),
        hint: isEexist
          ? "Concurrent seed caller holds the lock; bailing"
          : "Failed to acquire venv seed lock; skipping seed",
      },
      isEexist ? "Warm venv seed already in progress (lock held)" : "Warm venv seed skipped (lock acquisition failed)",
    );
    return;
  }

  try {
    const pip = safePath(safePath(workspacePath, "venv"), "bin", "pip");
    const result = spawnSync(pip, ["install", "--quiet", ...packages], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      // Sentinel content = seeded package list (one per line) for diagnostics.
      // Avoids `new Date()` (globals.test.ts gate).
      writeFileSync(sentinelPath, packages.join("\n") + "\n");
      logger?.debug({ workspaceDir: workspacePath, seeded: packages }, "Warm venv seed installed");
    } else {
      logger?.debug(
        { workspaceDir: workspacePath, packages, exitCode: result.status, hint: "pip seed failed; venv will work but may lack default packages" },
        "Warm venv seed skipped (pip error)",
      );
    }
  } finally {
    // Release unconditionally — transient pip failure must not wedge the venv.
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Build the subprocess env by merging: baseEnv → dataEnv → userEnv → resolvedSecretEnv → brokerSpawnEnv. */
export function buildExecEnv(deps: {
  workspacePath: string;
  subprocessEnv?: Record<string, string>;
  userEnv?: Record<string, string>;
  resolvedSecretEnv?: Record<string, string>;
  sandboxConfig?: ExecSandboxConfig;
  logger?: ToolLogger;
  // Broker proxy env + daemon placeholders — merged LAST; driven-CLI spawn only.
  // HTTPS_PROXY/NODE_EXTRA_CA_CERTS OPTIONAL (cap-lease path: placeholders only).
  brokerSpawnEnv?: {
    HTTPS_PROXY?: string;
    /** HTTP_PROXY intentionally omitted — broker is CONNECT-only (HTTPS). */
    HTTP_PROXY?: string;
    NODE_EXTRA_CA_CERTS?: string;
    placeholders: Record<string, string>;
  };
}): Record<string, string> {
  const { workspacePath, subprocessEnv, userEnv, resolvedSecretEnv, sandboxConfig, logger } = deps;
  const baseEnv = subprocessEnv ?? (systemEnvSnapshot() as Record<string, string>);
  const dataEnv = resolveDataEnv({ workspaceDir: workspacePath });
  const venvBin = safePath(workspacePath, "venv", "bin");
  if (existsSync(venvBin)) {
    logger?.debug(
      { toolName: "exec", workspaceDir: workspacePath, hint: "Prepending workspace-prewarmed venv/bin to PATH" },
      "Exec workspace venv detected",
    );
    if (dataEnv.PATH && baseEnv.PATH) {
      dataEnv.PATH = `${dataEnv.PATH}:${baseEnv.PATH}`;
    }
    // Seed the venv on first use when warmVenvSeed packages are configured
    const seedPackages = sandboxConfig?.warmVenvSeed;
    if (seedPackages !== undefined && seedPackages.length > 0) {
      ensureWarmVenvSeed(workspacePath, seedPackages, logger);
    }
  } else {
    delete dataEnv.PATH;
  }
  const env: Record<string, string> = {
    ...baseEnv,
    ...dataEnv,
    ...(userEnv ?? {}),
    ...(resolvedSecretEnv ?? {}),
  };
  const finalEnv = sandboxConfig?.sandbox.wrapEnv?.(env as Record<string, string>, workspacePath) ?? env;
  // Broker + cap-lease env LAST; proxy vars filtered to the defined ones (a cap-lease-only spawn has none).
  if (deps.brokerSpawnEnv) {
    const { HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS, placeholders } = deps.brokerSpawnEnv;
    Object.assign(finalEnv, placeholders, Object.fromEntries(Object.entries({ HTTPS_PROXY, NODE_EXTRA_CA_CERTS, HTTP_PROXY }).filter(([, v]) => v != null)));
  }
  return finalEnv;
}
