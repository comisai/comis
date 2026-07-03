// SPDX-License-Identifier: Apache-2.0
// @allow-throw: builtin tool boundary; throws caught by AgentTool wrapper.
/**
 * Exec tool module.
 *
 * Barrel + thin createExecTool factory. The factory body delegates to:
 *   - `evaluateInstallDetourGate` / `buildExecEnv` (exec-shared.ts)
 *   - `executeForeground` (exec-foreground.ts)
 *   - `executeBackground` (exec-background.ts)
 *
 * No aliases — every export keeps its canonical name.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { safePath, systemNowMs, tryGetContext, registerActivityLabelSpec } from "@comis/core";
import { redactSecretsInText, parseShellCommand } from "@comis/observability";
import {
  jsonResult,
  throwToolError,
  readStringParam,
  readNumberParam,
  readBooleanParam,
} from "../../../platform-tools/tool-helpers.js";
import { extractHeredoc, extractDashCArg, validateExecCommand } from "../exec-security/index.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, ExecParams, type ExecToolDeps } from "./exec-types.js";
import {
  resolveCwd,
  commandUsesRawInterpreter,
  resolveSecretRefs,
  evaluateInstallDetourGate,
  buildExecEnv,
} from "./exec-shared.js";
import { executeForeground } from "./exec-foreground.js";
import { executeBackground } from "./exec-background.js";

// Activity label spec. Descriptor name == emitted name
// (exec-tool/index.ts:75 → `name: "exec"`). The transform hook wires
// parseShellCommand for runtime completion; the fallback `label` literal
// renders when the transform returns "" (empty command).
//
// Security (defense-in-depth):
//   1) parseShellCommand self-redacts via redactValue at
//      shell-label-parser.ts:53 — `grep sk-… /tmp/log` renders as
//      `search for \`<redacted>\` in /tmp/log`.
//   2) applyTemplate step 4 (template-engine.ts:155) re-runs the transform
//      output through redactValue — a malicious or buggy transform still
//      cannot leak a secret shape.
// No detailKeys: the LLM-supplied command string is consumed by the
// transform (which handles its own redaction) — there is no `{key}`
// placeholder for the template-engine allowlist to police.
registerActivityLabelSpec("exec", {
  semanticPhase: "tool",
  label: "running command",
  transform: (params) => {
    const cmd = typeof params.command === "string" ? params.command : "";
    return cmd.length > 0 ? parseShellCommand(cmd) : "";
  },
});

export type { ExecToolDeps } from "./exec-types.js";
export { killTree, buildSpawnCommand, buildInstallDetourHint } from "./exec-shared.js";

/**
 * Create an exec tool for shell command execution.
 *
 * Backward compat NOT preserved.
 *
 * @param deps - Dependencies bundle. See `ExecToolDeps` for field semantics.
 *   `toolCapabilityPort` is REQUIRED; `approvalGate` is optional but
 *   required for the soft-stop override path.
 * @returns AgentTool implementing the exec interface.
 */
export function createExecTool(deps: ExecToolDeps): AgentTool<typeof ExecParams> {
  const {
    workspacePath, registry, secretManager, platformSecretNames,
    logger, subprocessEnv, sandboxConfig, eventBus, getToolResultsDir,
  } = deps;
  // Comis extension: promptGuidelines is not part of AgentTool type; use
  // object spread (preserved verbatim from pre-split exec-tool.ts) to avoid
  // excess property checks in the return statement.
  const guidelines = {
    promptGuidelines: [
      "Prefer dedicated file tools over exec for file operations: use `read` instead of `cat`/`head`/`tail`, `edit` instead of `sed`/`awk`, `write` instead of `echo >`/`cat <<EOF`, `grep` instead of `grep`/`rg`, `find` instead of `find`/`ls`.",
      "When issuing multiple commands: chain dependent commands with `&&`, use `;` when you don't care if earlier commands fail. DO NOT use newlines to separate commands.",
      "For git commands: prefer new commits over amending, never skip hooks (--no-verify) or bypass signing unless explicitly asked. Before running destructive operations (reset --hard, push --force, checkout --), consider safer alternatives first.",
      "Avoid unnecessary `sleep` commands. Use `background: true` for long-running commands instead of sleep loops. Do not retry failing commands in a sleep loop — diagnose the root cause.",
      "Use `background: true` for commands expected to run longer than 15 seconds (servers, builds, installs). The `autoBackgroundMs` threshold (default 15s) will auto-promote foreground commands that exceed it.",
      "Default timeout is 120 seconds. For longer operations (builds, test suites), set `timeoutMs` explicitly up to 600000 (10 minutes).",
      "For multi-line scripts (Python, Node, etc.), pipe the script body via the `input` parameter instead of embedding it in the command string. Example: command=\"python3 -\", input=\"import json\\nprint(json.dumps({...}))\". Newlines in the command string are rejected by security validation. For large data payloads, write data to a file first with the `write` tool, then exec a command that reads it.",
    ],
  };
  return {
    ...guidelines,
    name: "exec",
    label: "Exec",
    description: "Execute a shell command. Supports background mode, environment overrides, stdin input, and PTY allocation (pty=true for interactive CLI tools that require a TTY).",
    parameters: ExecParams,
    async execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;
        let command = readStringParam(p, "command");
        if (!command) throwToolError("missing_param", "Missing required parameter: command");
        const cwdParam = readStringParam(p, "cwd", false);
        const rawTimeout = readNumberParam(p, "timeoutMs", false);
        const userEnv = p.env as Record<string, string> | undefined;
        const background = readBooleanParam(p, "background", false) ?? false;
        let input = readStringParam(p, "input", false);
        const autoBackgroundMs = readNumberParam(p, "autoBackgroundMs", false) ?? 15_000;
        const description = readStringParam(p, "description", false);
        const pty = readBooleanParam(p, "pty", false) ?? false;
        const secretRefs = Array.isArray(p.secretRefs)
          ? (p.secretRefs as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;
        // Auto-extract heredoc patterns before security validation.
        const heredoc = extractHeredoc(command, input ?? undefined);
        if (heredoc) { command = heredoc.command; input = heredoc.input; }
        // Auto-rewrite `<interp> -c "<multiline body>"` to the stdin
        // form. Runs AFTER extractHeredoc so a `python3 - <<'PY'` heredoc
        // continues to take precedence (a command with BOTH forms is
        // malformed and falls through to Gate-0).
        const dashC = extractDashCArg(command, input ?? undefined);
        if (dashC) { command = dashC.command; input = dashC.input; }
        // Validate command and env through security pipeline
        const validationError = validateExecCommand(command, userEnv);
        if (validationError) {
          eventBus?.emit("command:blocked", {
            agentId: tryGetContext()?.sessionKey ?? "unknown",
            // Redact BEFORE slicing so a credential straddling the boundary char
            // is fully masked in the event payload sent to SSE consumers.
            commandPrefix: redactSecretsInText(command).slice(0, 200),
            reason: validationError.message,
            blocker: validationError.blocker as "sanitize" | "substitution" | "pipe" | "denylist" | "path" | "redirect" | "env",
            timestamp: systemNowMs(),
          });
          throwToolError("permission_denied", validationError.message);
        }
        // Install-detour mode policy gate
        const gate = await evaluateInstallDetourGate({
          command, allowInstallDetourOverride: readBooleanParam(p, "allowInstallDetour", false) ?? false,
          toolCapabilityPort: deps.toolCapabilityPort, approvalGate: deps.approvalGate, eventBus, logger,
        });
        if (gate.errorMessage) throwToolError("permission_denied", gate.errorMessage);
        // Detect --break-system-packages for post-execution warning
        const breakSystemWarning = command.includes("--break-system-packages")
          ? "⚠️ WARNING: --break-system-packages modifies the system Python. Use a virtualenv: the workspace's pre-warmed venv (venv/bin/pip install ...) or a per-project one (python3 -m venv projects/<name>/.venv).\n\n"
          : "";
        // Redact BEFORE slicing so a bare token straddling char 200 cannot
        // appear as a truncated-but-still-recognizable fragment in the log field.
        logger?.debug({ toolName: "exec", command: redactSecretsInText(command).slice(0, 200), background, pty, ...(description && { description }) }, "Exec command start");
        if (userEnv) logger?.debug({ toolName: "exec", envOverrides: Object.keys(userEnv) }, "Exec env override applied");
        const timeoutMs = Math.min(Math.max(rawTimeout ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
        const cwd = cwdParam ? resolveCwd(workspacePath, cwdParam) : workspacePath;
        // Resolve secretRefs (if any).
        let resolvedSecretEnv: Record<string, string> | undefined;
        if (secretRefs && secretRefs.length > 0) {
          if (commandUsesRawInterpreter(command)) {
            throwToolError("invalid_value",
              `Raw-interpreter commands (python -c, node -e, bash -c, ruby -e, etc.) are not allowed with secretRefs because they make secret echo trivial. Write your script to a workspace file (write tool) and invoke that instead, e.g. "python3 projects/foo/deploy.py".`);
          }
          const resolved = resolveSecretRefs(secretRefs, secretManager, platformSecretNames);
          if (!resolved.ok) throwToolError("invalid_value", resolved.error);
          else {
            resolvedSecretEnv = resolved.env;
            const agentId = tryGetContext()?.sessionKey ?? "unknown";
            for (const name of Object.keys(resolvedSecretEnv)) {
              eventBus?.emit("secret:accessed", { secretName: name, agentId, outcome: "success", timestamp: systemNowMs() });
            }
            // Redact BEFORE slicing to prevent boundary-straddle leaks.
            logger?.info({ toolName: "exec", secretRefs: Object.keys(resolvedSecretEnv), commandPrefix: redactSecretsInText(command).slice(0, 80) }, "Exec resolved secretRefs for subprocess");
          }
        }
        const finalEnv = buildExecEnv({ workspacePath, subprocessEnv, userEnv, resolvedSecretEnv, sandboxConfig, logger });
        const tempDir = sandboxConfig ? safePath(workspacePath, ".comis-tmp") : tmpdir();
        if (sandboxConfig) mkdirSync(tempDir, { recursive: true });
        if (input) logger?.debug({ toolName: "exec", stdinLength: input.length }, "Exec stdin write");
        if (background) {
          return executeBackground(command, cwd, finalEnv as NodeJS.ProcessEnv, input, registry, logger, sandboxConfig, workspacePath, tempDir, description, pty, gate.decision ?? undefined, gate.mode);
        }
        const result = await executeForeground(command, cwd, finalEnv as NodeJS.ProcessEnv, timeoutMs, input, signal, onUpdate, logger, sandboxConfig, workspacePath, tempDir, registry, autoBackgroundMs, pty, description, toolCallId, getToolResultsDir, gate.decision ?? undefined, gate.mode);
        if (breakSystemWarning && result.details) {
          const details = result.details as Record<string, unknown>;
          if (typeof details.stdout === "string") details.stdout = breakSystemWarning + details.stdout;
        }
        return result;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}

// Suppress unused-import lint: `jsonResult`, `Type`, `AgentToolResult` are
// re-exported by virtue of the AgentTool factory return type / Type schema.
void jsonResult;
void Type;
