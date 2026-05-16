// SPDX-License-Identifier: Apache-2.0
// @allow-throw: builtin tool boundary; throws caught by AgentTool wrapper (Phase 41 TS-HYG-07).
/**
 * Exec tool shared helpers (Phase 43 split per FILE-SPLIT-02).
 *
 * Extracted from `exec-tool.ts` (1,626L monolith) on 2026-05-16. Block-move
 * of the 10 module-level helpers (resolveCwd, killTree, buildSpawnCommand,
 * resolveDataEnv, commandUsesRawInterpreter, resolveSecretRefs, ecosystemFor,
 * buildInstallDetourHint, buildSoftStopErrorTemplate, buildInstallDetourEventPayload)
 * plus two factory-body extractions (evaluateInstallDetourGate, buildExecEnv)
 * required to keep `index.ts` thin per the FILE-SPLIT-02 plan.
 *
 * @module
 */

import { existsSync } from "node:fs";
import {
  PathTraversalError,
  safePath,
  systemEnvSnapshot,
  systemNowMs,
  tryGetContext,
} from "@comis/core";
import type {
  SecretManager,
  ToolCapabilityPort,
  ApprovalGate,
  TypedEventBus,
} from "@comis/core";
import type { ExecSandboxConfig } from "../sandbox/types.js";
import { resolvePaths } from "../file/safe-path-wrapper.js";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";
import {
  parseInstallDetour,
  type InstallDetourDecision,
  type DetourOverlap,
} from "../install-detour.js";
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

/**
 * Workspace-internal data env resolver. Returns env vars derived from
 * `workspaceDir` so python/matplotlib subprocesses do NOT inherit the
 * daemon's host PATH or cache-dir defaults. Shape mirrors
 * `packages/agent/src/workspace/data-env.ts` verbatim; lifted inline to
 * avoid a cross-package agent import (skills + agent are siblings).
 */
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
    agentId: ctx?.sessionKey ?? "unknown",
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
// Factory-body extractions (Phase 43 — keep index.ts thin)
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
 * Block-extracted from createExecTool factory (lines 711-862 of pre-split).
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
            sessionKey: ctx.sessionKey,
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

/**
 * Build the final environment record for the subprocess by merging:
 *   baseEnv → dataEnv → userEnv → resolvedSecretEnv (last wins on collision).
 * Block-extracted from createExecTool factory (lines 931-978 of pre-split).
 */
export function buildExecEnv(deps: {
  workspacePath: string;
  subprocessEnv?: Record<string, string>;
  userEnv?: Record<string, string>;
  resolvedSecretEnv?: Record<string, string>;
  sandboxConfig?: ExecSandboxConfig;
  logger?: ToolLogger;
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
  return finalEnv;
}
