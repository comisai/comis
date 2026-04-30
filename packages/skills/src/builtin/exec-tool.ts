// SPDX-License-Identifier: Apache-2.0
/**
 * Exec tool: execute shell commands in foreground or background mode.
 *
 * Foreground mode spawns a child process with streaming output capture,
 * tail-truncation for large outputs, temp file spillover, and process
 * tree kill on timeout/abort. Returns { exitCode, stdout, stderr } plus
 * optional { truncated, fullOutputPath } when output exceeds limits.
 *
 * Background mode spawns a detached process, registers it in the
 * ProcessRegistry, and returns immediately with { status, sessionId, pid }.
 *
 * Security:
 * - Command and environment validation delegated to exec-security.ts pipeline.
 * - Working directory is validated via safePath to prevent execution
 *   outside workspace bounds.
 *
 * Note: The command denylist is defense-in-depth, not a sandbox. Pattern
 * matching on raw command strings can be bypassed via shell quoting/encoding.
 * The actual security boundary is the builtinTools.exec toggle and tool policy.
 *
 * @module
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { safePath, PathTraversalError } from "@comis/core";
import type { SecretManager } from "@comis/core";
import type { ExecSandboxConfig } from "./sandbox/types.js";
import { resolvePaths } from "./file/safe-path-wrapper.js";
import {
  jsonResult,
  throwToolError,
  readStringParam,
  readNumberParam,
  readBooleanParam,
} from "./platform/tool-helpers.js";
import type { ProcessRegistry, ProcessSession } from "./process-registry.js";
import { generateSessionId, appendOutput } from "./process-registry.js";
import { truncateTail, formatSize, DEFAULT_MAX_BYTES } from "./truncate.js";
import { createOutputCleaner } from "./output-cleaner.js";
import { extractHeredoc, validateExecCommand, interpretExitCode } from "./exec-security.js";
import type { TypedEventBus } from "@comis/core";
import { tryGetContext } from "@comis/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to persist to disk for truncated output. */
const MAX_PERSIST_BYTES = 64 * 1024 * 1024;

/** Max output chars for background mode's ProcessSession rolling buffer. */
const BACKGROUND_MAX_OUTPUT_CHARS = 1024 * 1024; // 1MB

/** Rolling buffer size for foreground streaming (2x DEFAULT_MAX_BYTES). */
const ROLLING_BUFFER_MAX = DEFAULT_MAX_BYTES * 2; // 100KB

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ExecParams = Type.Object({
  command: Type.String({ description: "The shell command to execute (single-line only — use 'input' param for multi-line scripts)" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (defaults to workspace)" }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Timeout in ms (default 120000, max 600000)",
      default: 120_000,
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Environment variable overrides",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in background and return immediately" }),
  ),
  input: Type.Optional(
    Type.String({ description: "String to write to process stdin" }),
  ),
  autoBackgroundMs: Type.Optional(
    Type.Integer({
      description:
        "Auto-background threshold in ms. Foreground commands exceeding this duration transition to background. Default 15000. Set 0 to disable.",
      default: 15_000,
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Human-readable label for this command (e.g. 'Installing dependencies'). Appears in UI activity indicators and structured logs.",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Allocate a pseudo-terminal for the command. Required for interactive CLI tools that check process.stdout.isTTY. Wraps the command in 'script' to provide a real TTY.",
    }),
  ),
  secretRefs: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 8,
      description:
        "Secret/credential NAMES (not values) to inject as env vars into the subprocess. Use this to pass API tokens to CLI tools like wrangler/gh/gcloud/kubectl without tripping the env-var allowlist. Names are resolved server-side via SecretManager; values never flow through agent context. Call env_list first to discover available names. Platform-managed secrets (referenced by the daemon config, e.g. ANTHROPIC_API_KEY) are rejected. Raw-interpreter commands (python -c, node -e, bash -c, etc.) are rejected with secretRefs to prevent trivial echo-to-stdout leaks. Example: {command: 'npx wrangler pages deploy ./dist', secretRefs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']}",
    }),
  ),
});

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied `cwd` against the workspace root via safePath.
 *
 * Accepts either an absolute path (must still be inside workspace) or a
 * workspace-relative path. Returns the resolved absolute path for spawn().
 * Throws a tool error via throwToolError when the path escapes workspace
 * bounds — caller never needs to validate the string separately.
 *
 * Why this shape: the previous implementation kept the raw user input
 * (typically a workspace-relative string like "projects/foo") and passed
 * it to Node child_process.spawn, which resolves relative paths against
 * the DAEMON'S process.cwd (not the workspace). That produced the
 * misleading "spawn sandbox-exec ENOENT" when the agent's cwd didn't
 * exist under the daemon's cwd. Now every cwd flowing into spawn is an
 * absolute, workspace-anchored path.
 */
function resolveCwd(workspacePath: string, cwdParam: string): string {
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
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for structured tool logging. */
interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
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
      // Sandbox: kill bwrap directly (positive PID).
      // --die-with-parent + --unshare-pid cascade to all children.
      process.kill(pid, "SIGKILL");
    } else {
      // No sandbox: kill process group (negative PID) as before.
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
 * and/or a PTY via `script`.
 *
 * When sandboxConfig is undefined, returns the existing /bin/bash -c command.
 * When present, calls sandboxConfig.sandbox.buildArgs() and prefixes the command.
 *
 * When pty is true, wraps the entire command (including sandbox) in `script`
 * to allocate a pseudo-terminal. On macOS, uses positional args; on Linux,
 * reconstructs a command string for `script -c`.
 *
 * Exported for direct unit testing.
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
    // Pass cwd through to spawn() unless the provider handles it.
    const providerHandlesCwd = sandboxConfig.sandbox.name === "bwrap";

    result = {
      bin: sandboxArgs[0],
      args: [...sandboxArgs.slice(1), "/bin/bash", "-c", command],
      cwd: providerHandlesCwd ? undefined : cwd,
    };
  }

  // Wrap in PTY via Python pty.spawn() when requested.
  // Python runs OUTSIDE the sandbox — it creates a PTY pair via openpty(),
  // forks, connects the child to the PTY slave, and proxies I/O between
  // its piped stdin/stdout and the PTY master. Unlike `script`, Python's
  // pty.spawn() handles piped stdin gracefully (catches tcgetattr error
  // on non-TTY stdin and continues without raw mode).
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

/** Valid secret env var name (same rule as env.set). */
const SECRET_REF_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Detect raw-interpreter command shapes. When `secretRefs` is present,
 * these are refused because they make `echo $TOKEN` / `print(os.environ)`
 * trivial one-liners. Agents should put credential-bearing scripts into
 * workspace files and invoke those instead.
 *
 * Matches the command verb (first non-shell-prefix token) against known
 * interpreter binaries combined with a `-c` / `-e` flag. Heredoc-style
 * invocations (`python3 - <<PY ...`) are already split by extractHeredoc
 * before validation and reach this point with command === "python3", so
 * we also refuse the bare-dash form.
 */
function commandUsesRawInterpreter(command: string): boolean {
  // Normalize: drop leading `cd … && ` and `env … ` prefixes so we see the verb.
  const stripped = command
    .replace(/^\s*cd\s+\S+\s*&&\s*/i, "")
    .replace(/^\s*env\s+(?:[A-Z_][A-Z0-9_]*=\S+\s+)*/i, "")
    .trim();

  // Match: <interpreter> (-c "…") or (-e "…") or (-) for stdin scripts.
  // Include common Python/Node/Ruby/Perl/PHP/Bash/Shell forms.
  const rawPattern =
    /^(python3?|node|nodejs|ruby|perl|php|bash|sh|zsh|dash|lua|deno|bun)(?:\s+-[cCeE](?:\s+|$)|\s+-(?:\s|$))/i;
  return rawPattern.test(stripped);
}

/**
 * Resolve a list of secret names into an env-var record.
 *
 * Validates each name, rejects platform-managed names, rejects missing
 * names, and calls `secretManager.get` once per name. Returns an error
 * string on any rejection; otherwise returns the resolved record.
 *
 * The returned record is merged into the child's env AFTER the normal
 * userEnv merge, so `secretRefs` wins on collision — agents can't
 * override a server-resolved secret with a stale value by passing the
 * same name via `env`.
 */
function resolveSecretRefs(
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
    if (seen.has(name)) continue; // dedup silently
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an exec tool for shell command execution.
 *
 * @param workspacePath - Default working directory for commands
 * @param registry - ProcessRegistry for background process tracking
 * @param logger - Optional structured logger for DEBUG-level operation logging
 * @param subprocessEnv - Optional filtered env for subprocesses (defense-in-depth)
 * @param sandboxConfig - Optional sandbox configuration for OS-level isolation
 * @param eventBus - Optional TypedEventBus for emitting command:blocked audit events
 * @param getToolResultsDir - Optional getter for session tool-results directory
 * @returns AgentTool implementing the exec interface
 */
export function createExecTool(
  workspacePath: string,
  registry: ProcessRegistry,
  secretManager: SecretManager,
  platformSecretNames: ReadonlySet<string>,
  logger?: ToolLogger,
  subprocessEnv?: Record<string, string>,
  sandboxConfig?: ExecSandboxConfig,
  eventBus?: TypedEventBus,
  getToolResultsDir?: () => string | undefined,
): AgentTool<typeof ExecParams> {
  // Comis extension: promptGuidelines is not part of AgentTool type, use object
  // spread to avoid excess property checks in the return statement.
  const guidelines = {
    promptGuidelines: [
      "Prefer dedicated file tools over exec for file operations: " +
        "use `read` instead of `cat`/`head`/`tail`, " +
        "`edit` instead of `sed`/`awk`, " +
        "`write` instead of `echo >`/`cat <<EOF`, " +
        "`grep` instead of `grep`/`rg`, " +
        "`find` instead of `find`/`ls`.",
      "When issuing multiple commands: chain dependent commands with `&&`, " +
        "use `;` when you don't care if earlier commands fail. " +
        "DO NOT use newlines to separate commands.",
      "For git commands: prefer new commits over amending, " +
        "never skip hooks (--no-verify) or bypass signing unless explicitly asked. " +
        "Before running destructive operations (reset --hard, push --force, checkout --), " +
        "consider safer alternatives first.",
      "Avoid unnecessary `sleep` commands. Use `background: true` for long-running " +
        "commands instead of sleep loops. Do not retry failing commands in a sleep " +
        "loop — diagnose the root cause.",
      "Use `background: true` for commands expected to run longer than 15 seconds " +
        "(servers, builds, installs). The `autoBackgroundMs` threshold (default 15s) " +
        "will auto-promote foreground commands that exceed it.",
      "Default timeout is 120 seconds. For longer operations (builds, test suites), " +
        "set `timeoutMs` explicitly up to 600000 (10 minutes).",
      "For multi-line scripts (Python, Node, etc.), pipe the script body via " +
        "the `input` parameter instead of embedding it in the command string. " +
        "Example: command=\"python3 -\", input=\"import json\\nprint(json.dumps({...}))\". " +
        "Newlines in the command string are rejected by security validation. " +
        "For large data payloads, write data to a file first with the `write` tool, " +
        "then exec a command that reads it.",
    ],
  };
  return {
    ...guidelines,
    name: "exec",
    label: "Exec",
    description:
      "Execute a shell command. Supports background mode, environment overrides, stdin input, and PTY allocation (pty=true for interactive CLI tools that require a TTY).",
    parameters: ExecParams,

    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;
        let command = readStringParam(p, "command");
        if (!command) {
          throwToolError("missing_param", "Missing required parameter: command");
        }

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
        // LLMs send `python3 - <<'PY'\n...\nPY` which Gate 0 blocks
        // due to newlines. Split into clean command + stdin input.
        const heredoc = extractHeredoc(command, input ?? undefined);
        if (heredoc) {
          command = heredoc.command;
          input = heredoc.input;
        }

        // Validate command and env through security pipeline
        const validationError = validateExecCommand(command, userEnv);
        if (validationError) {
          // Emit command:blocked audit event before throwing
          // Note: RequestContext has no agentId field; sessionKey carries agent identity
          eventBus?.emit("command:blocked", {
            agentId: tryGetContext()?.sessionKey ?? "unknown",
            commandPrefix: command.slice(0, 200),
            reason: validationError.message,
            blocker: validationError.blocker as "sanitize" | "substitution" | "pipe" | "denylist" | "path" | "redirect" | "env",
            timestamp: Date.now(),
          });
          throwToolError("permission_denied", validationError.message);
        }

        // Detect --break-system-packages for post-execution warning
        const breakSystemWarning = command.includes("--break-system-packages")
          ? "\u26a0\ufe0f WARNING: --break-system-packages modifies the system Python. Use a virtualenv instead: python3 -m venv .venv && .venv/bin/pip install ...\n\n"
          : "";

        // Log command start (truncate command to 200 chars for security)
        logger?.debug({ toolName: "exec", command: command.slice(0, 200), background, pty, ...(description && { description }) }, "Exec command start");

        // Log env override (keys only, never values)
        if (userEnv) {
          logger?.debug({ toolName: "exec", envOverrides: Object.keys(userEnv) }, "Exec env override applied");
        }

        // Clamp timeout
        const timeoutMs = Math.min(
          Math.max(rawTimeout ?? DEFAULT_TIMEOUT_MS, 100),
          MAX_TIMEOUT_MS,
        );

        // Resolve working directory against the workspace (not the daemon's
        // process.cwd). Throws via throwToolError if out-of-bounds.
        const cwd = cwdParam ? resolveCwd(workspacePath, cwdParam) : workspacePath;

        // Resolve secretRefs (if any). Raw-interpreter guard runs first to
        // fail fast before touching the SecretManager. secretRefs values
        // override userEnv on collision — a server-resolved secret always
        // wins so the agent can't pin a stale value.
        let resolvedSecretEnv: Record<string, string> | undefined;
        if (secretRefs && secretRefs.length > 0) {
          if (commandUsesRawInterpreter(command)) {
            throwToolError(
              "invalid_value",
              `Raw-interpreter commands (python -c, node -e, bash -c, ruby -e, etc.) ` +
                `are not allowed with secretRefs because they make secret echo trivial. ` +
                `Write your script to a workspace file (write tool) and invoke that instead, ` +
                `e.g. "python3 projects/foo/deploy.py".`,
            );
          }
          const resolved = resolveSecretRefs(secretRefs, secretManager, platformSecretNames);
          if (!resolved.ok) {
            throwToolError("invalid_value", resolved.error);
          } else {
            resolvedSecretEnv = resolved.env;
            // Audit: emit one event per resolved name (value never logged).
            const agentId = tryGetContext()?.sessionKey ?? "unknown";
            for (const name of Object.keys(resolvedSecretEnv)) {
              eventBus?.emit("secret:accessed", {
                secretName: name,
                agentId,
                outcome: "success",
                timestamp: Date.now(),
              });
            }
            logger?.info(
              {
                toolName: "exec",
                secretRefs: Object.keys(resolvedSecretEnv),
                commandPrefix: command.slice(0, 80),
              },
              "Exec resolved secretRefs for subprocess",
            );
          }
        }

        // Build environment (use filtered subprocess env instead of raw process.env)
        const baseEnv = subprocessEnv ?? (process.env as Record<string, string>);
        const env: Record<string, string> = {
          ...baseEnv,
          ...(userEnv ?? {}),
          ...(resolvedSecretEnv ?? {}),
        };

        // Wrap env for sandbox (e.g., redirect cache dirs into workspace)
        const finalEnv = sandboxConfig?.sandbox.wrapEnv?.(env as Record<string, string>, workspacePath) ?? env;

        // Compute temp directory: workspace-based when sandboxed, os.tmpdir() when not
        const tempDir = sandboxConfig
          ? safePath(workspacePath, ".comis-tmp")
          : tmpdir();
        if (sandboxConfig) {
          mkdirSync(tempDir, { recursive: true });
        }

        // Log stdin write (length only, never content)
        if (input) {
          logger?.debug({ toolName: "exec", stdinLength: input.length }, "Exec stdin write");
        }

        if (background) {
          return executeBackground(command, cwd, finalEnv as NodeJS.ProcessEnv, input, registry, logger, sandboxConfig, workspacePath, tempDir, description, pty);
        }

        const result = await executeForeground(command, cwd, finalEnv as NodeJS.ProcessEnv, timeoutMs, input, signal, onUpdate, logger, sandboxConfig, workspacePath, tempDir, registry, autoBackgroundMs, pty, description, toolCallId, getToolResultsDir);

        // Prepend --break-system-packages warning to stdout so the LLM sees it
        if (breakSystemWarning && result.details) {
          const details = result.details as Record<string, unknown>;
          if (typeof details.stdout === "string") {
            details.stdout = breakSystemWarning + details.stdout;
          }
        }

        return result;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-background escalation helper
// ---------------------------------------------------------------------------

interface EscalationContext {
  command: string;
  child: ReturnType<typeof spawn>;
  startTime: number;
  stdoutBuf: string;
  stderrBuf: string;
  registry: ProcessRegistry;
  sandboxConfig?: ExecSandboxConfig;
  logger?: ToolLogger;
  spillStream: ReturnType<typeof createWriteStream> | null;
  signal?: AbortSignal;
  onAbort: () => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  resolve: (value: AgentToolResult<unknown>) => void;
  setResolved: () => void;
  description?: string;
}

/**
 * Execute auto-background escalation: create a ProcessRegistry session from
 * the running child, re-wire output streams, and resolve with a
 * "backgrounded" status containing the sessionId for polling.
 */
function escalateToBackground(ctx: EscalationContext): void {
  ctx.setResolved();
  clearTimeout(ctx.timeoutTimer);
  if (ctx.signal) ctx.signal.removeEventListener("abort", ctx.onAbort);

  const session: ProcessSession = {
    id: generateSessionId(),
    command: ctx.command,
    pid: ctx.child.pid,
    startedAt: Math.round(ctx.startTime),
    status: "running",
    exitCode: undefined,
    stdout: ctx.stdoutBuf,
    stderr: ctx.stderrBuf,
    child: ctx.child,
    maxOutputChars: BACKGROUND_MAX_OUTPUT_CHARS,
    sandboxed: !!ctx.sandboxConfig,
    autoBackgrounded: true,
    ...(ctx.description && { description: ctx.description }),
  };

  // Re-wire stdout/stderr from rolling buffer to session append
  const bgStdoutCleaner = createOutputCleaner();
  const bgStderrCleaner = createOutputCleaner();
  ctx.child.stdout?.removeAllListeners("data");
  ctx.child.stderr?.removeAllListeners("data");
  ctx.child.stdout?.on("data", (chunk: Buffer) => {
    appendOutput(session, "stdout", bgStdoutCleaner.process(chunk));
  });
  ctx.child.stderr?.on("data", (chunk: Buffer) => {
    appendOutput(session, "stderr", bgStderrCleaner.process(chunk));
  });
  ctx.child.on("close", (code: number | null) => {
    const stdoutFlush = bgStdoutCleaner.flush();
    const stderrFlush = bgStderrCleaner.flush();
    if (stdoutFlush) appendOutput(session, "stdout", stdoutFlush);
    if (stderrFlush) appendOutput(session, "stderr", stderrFlush);
    session.status = code === 0 ? "completed" : "failed";
    session.exitCode = code;
    session.child = undefined;
  });
  ctx.registry.add(session);

  ctx.logger?.info(
    { toolName: "exec", sessionId: session.id, pid: ctx.child.pid, durationMs: Math.round(performance.now() - ctx.startTime), ...(ctx.description && { description: ctx.description }) },
    "Exec auto-backgrounded after threshold",
  );
  if (ctx.spillStream) ctx.spillStream.end();
  ctx.resolve(jsonResult({
    status: "backgrounded",
    sessionId: session.id,
    pid: ctx.child.pid,
    stdoutSoFar: truncateTail(ctx.stdoutBuf).content,
    stderrSoFar: truncateTail(ctx.stderrBuf).content,
    ...(ctx.description && { description: ctx.description }),
  }));
}

// ---------------------------------------------------------------------------
// Foreground execution
// ---------------------------------------------------------------------------

function executeForeground(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  input: string | undefined,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
  logger?: ToolLogger,
  sandboxConfig?: ExecSandboxConfig,
  workspacePath?: string,
  tempDir?: string,
  registry?: ProcessRegistry,
  autoBackgroundMs?: number,
  pty?: boolean,
  description?: string,
  toolCallId?: string,
  getToolResultsDir?: () => string | undefined,
): Promise<AgentToolResult<unknown>> {
  const startTime = performance.now();

  return new Promise((resolve) => {
    const { bin, args, cwd: spawnCwd } = buildSpawnCommand(
      command, cwd, sandboxConfig, workspacePath ?? cwd, tempDir ?? tmpdir(), pty,
    );
    const child = spawn(bin, args, {
      cwd: spawnCwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pid = child.pid;

    // Rolling buffers for stdout, stderr, and combined (for onUpdate)
    let stdoutBuf = "";
    let stderrBuf = "";
    let combinedBuf = "";
    let totalBytes = 0;
    let resolved = false;

    // Output cleaners for stateful UTF-8 decode + ANSI strip + CR normalize + binary sanitize
    const stdoutCleaner = createOutputCleaner();
    const stderrCleaner = createOutputCleaner();

    // Temp file spillover state
    let spillStream: ReturnType<typeof createWriteStream> | null = null;
    let spillPath: string | null = null;
    let _spillCapped = false;

    function appendRolling(buf: string, chunk: string): string {
      const combined = buf + chunk;
      if (combined.length > ROLLING_BUFFER_MAX) {
        return combined.slice(-ROLLING_BUFFER_MAX);
      }
      return combined;
    }

    function ensureSpillFile(): void {
      if (spillStream) return;
      const hex = randomBytes(8).toString("hex");
      const filename = `comis-exec-${hex}.log`;
      spillPath = safePath(tempDir ?? tmpdir(), filename);
      spillStream = createWriteStream(spillPath, { flags: "a" });
    }

    // Wire stdout
    child.stdout?.on("data", (chunk: Buffer) => {
      const str = stdoutCleaner.process(chunk);
      stdoutBuf = appendRolling(stdoutBuf, str);
      combinedBuf = appendRolling(combinedBuf, str);
      totalBytes += chunk.length;

      // Spill to temp file when output exceeds DEFAULT_MAX_BYTES, cap at MAX_PERSIST_BYTES
      if (totalBytes > DEFAULT_MAX_BYTES && totalBytes <= MAX_PERSIST_BYTES) {
        ensureSpillFile();
        spillStream!.write(chunk);
      } else if (totalBytes > MAX_PERSIST_BYTES && spillStream) {
        spillStream.end();
        spillStream = null;
        _spillCapped = true;
      }

      // Stream onUpdate with truncated-tail of combined buffer
      // EXEC-ABORT: guard with !resolved to prevent late onUpdate calls
      // after tool resolution (orphaned child process output)
      if (onUpdate && !resolved) {
        const truncated = truncateTail(combinedBuf);
        onUpdate({
          content: [{ type: "text", text: truncated.content }],
          details: undefined,
        });
      }
    });

    // Wire stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      const str = stderrCleaner.process(chunk);
      stderrBuf = appendRolling(stderrBuf, str);
      combinedBuf = appendRolling(combinedBuf, str);
      totalBytes += chunk.length;

      if (totalBytes > DEFAULT_MAX_BYTES && totalBytes <= MAX_PERSIST_BYTES) {
        ensureSpillFile();
        spillStream!.write(chunk);
      } else if (totalBytes > MAX_PERSIST_BYTES && spillStream) {
        spillStream.end();
        spillStream = null;
        _spillCapped = true;
      }

      // EXEC-ABORT: guard with !resolved to prevent late onUpdate calls
      // after tool resolution (orphaned child process output)
      if (onUpdate && !resolved) {
        const truncated = truncateTail(combinedBuf);
        onUpdate({
          content: [{ type: "text", text: truncated.content }],
          details: undefined,
        });
      }
    });

    // Close stdin to prevent hang on stdin-reading commands (e.g., bare `cat`)
    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    // Manual timeout via setTimeout + killTree
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      if (resolved) return;
      timedOut = true;
      if (pid) killTree(pid, !!sandboxConfig);
    }, timeoutMs);

    // Manual abort via signal
    let aborted = false;
    function onAbort(): void {
      if (resolved) return;
      aborted = true;
      if (pid) killTree(pid, !!sandboxConfig);
    }

    if (signal) {
      if (signal.aborted) {
        // Already aborted before spawn
        aborted = true;
        if (pid) killTree(pid, !!sandboxConfig);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Auto-background escalation timer
    const effectiveAutoMs = autoBackgroundMs ?? 15_000;
    const escalationTimer = (effectiveAutoMs > 0 && registry)
      ? setTimeout(() => {
          if (resolved) return;
          escalateToBackground({
            command, child, startTime, stdoutBuf, stderrBuf,
            registry, sandboxConfig, logger, spillStream,
            signal, onAbort, timeoutTimer, resolve,
            setResolved: () => { resolved = true; },
            description,
          });
        }, effectiveAutoMs)
      : null;

    // Handle close event
    child.on("close", (code: number | null, sig: string | null) => {
      if (resolved) return;
      resolved = true;
      // EXEC-ABORT: remove data listeners to prevent late onUpdate calls
      // after tool resolution (orphaned child process output)
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (spillStream) spillStream.end();

      // Determine exit code
      let exitCode: number;
      if (timedOut) {
        exitCode = 124; // Unix convention for timeout
      } else if (aborted) {
        exitCode = 130; // Unix convention for SIGINT
      } else if (code !== null) {
        exitCode = code;
      } else if (sig) {
        exitCode = 1; // Unknown signal kill
      } else {
        exitCode = 1;
      }

      // Flush any remaining buffered UTF-8 bytes from the output cleaners
      const stdoutFlush = stdoutCleaner.flush();
      const stderrFlush = stderrCleaner.flush();
      if (stdoutFlush) stdoutBuf = appendRolling(stdoutBuf, stdoutFlush);
      if (stderrFlush) stderrBuf = appendRolling(stderrBuf, stderrFlush);

      // Apply tail truncation to stdout/stderr
      const stdoutResult = truncateTail(stdoutBuf);
      const stderrResult = truncateTail(stderrBuf);

      let finalStdout = stdoutResult.content;
      let finalStderr = stderrResult.content;

      // Append truncation notices
      if (stdoutResult.truncated) {
        const notice = `\n[stdout truncated: kept last ${stdoutResult.outputLines} of ${stdoutResult.totalLines} lines, ${formatSize(stdoutResult.outputBytes)} of ${formatSize(stdoutResult.totalBytes)}]`;
        finalStdout += notice;
      }
      if (stderrResult.truncated) {
        const notice = `\n[stderr truncated: kept last ${stderrResult.outputLines} of ${stderrResult.totalLines} lines, ${formatSize(stderrResult.outputBytes)} of ${formatSize(stderrResult.totalBytes)}]`;
        finalStderr += notice;
      }

      // Append timeout/abort messages to stderr
      if (timedOut) {
        finalStderr += (finalStderr ? "\n" : "") + `Process timed out after ${timeoutMs}ms`;
      }
      if (aborted) {
        finalStderr += (finalStderr ? "\n" : "") + "Process aborted by signal";
      }

      const durationMs = Math.round(performance.now() - startTime);
      logger?.debug({ toolName: "exec", durationMs, exitCode, ...(description && { description }) }, "Exec command complete");

      const result: Record<string, unknown> = {
        exitCode,
        stdout: finalStdout,
        stderr: finalStderr,
        ...(description && { description }),
      };

      // Add semantic exit code interpretation
      const exitCodeMeaning = interpretExitCode(command, exitCode);
      if (exitCodeMeaning) {
        result.exitCodeMeaning = exitCodeMeaning;
      }

      // Add truncation metadata when applicable
      if (stdoutResult.truncated || stderrResult.truncated) {
        result.truncated = true;
      }
      if (spillPath) {
        result.fullOutputPath = spillPath;
      }

      // Persist full output to session tool-results dir when truncated
      if ((stdoutResult.truncated || stderrResult.truncated) && getToolResultsDir) {
        const toolResultsDir = getToolResultsDir();
        if (toolResultsDir && toolCallId) {
          try {
            mkdirSync(toolResultsDir, { recursive: true });
            const persistPath = safePath(toolResultsDir, `exec-${toolCallId}.txt`);

            if (spillPath && totalBytes > ROLLING_BUFFER_MAX) {
              // Large output (>100KB): copy spill file which has up to 64MB of content.
              // The rolling buffers only hold the last 100KB tail, so spill file is
              // the best source for persistence.
              copyFileSync(spillPath, persistPath);
              const stats = statSync(persistPath);
              result.fullOutputPath = persistPath;
              result.fullOutputSize = stats.size;
              if (_spillCapped) {
                // Output exceeded MAX_PERSIST_BYTES (64MB), spill stream was capped
                result.fullOutputTruncatedOnDisk = true;
                finalStdout += `\n[Full output exceeded 64MB limit; last 64MB saved to disk]`;
              }
            } else {
              // Small-to-medium output (50-100KB): in-memory rolling buffers have complete content
              const fullOutput = stdoutBuf + (stderrBuf ? "\n--- STDERR ---\n" + stderrBuf : "");
              const fullOutputBuf = Buffer.from(fullOutput, "utf-8");
              writeFileSync(persistPath, fullOutputBuf);
              result.fullOutputPath = persistPath;
              result.fullOutputSize = fullOutputBuf.length;
            }

            const sizeStr = formatSize(result.fullOutputSize as number);
            finalStdout += `\n[Full output (${sizeStr}) saved to: ${persistPath}]`;
            finalStdout += `\n[Use the file read tool with offset/limit to access specific sections]`;
            result.stdout = finalStdout;
          } catch {
            // Persistence is best-effort -- don't fail the command
            logger?.debug({ toolName: "exec" }, "Failed to persist truncated output");
          }
        }
      }

      resolve(jsonResult(result));
    });

    // Handle spawn errors
    child.on("error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (spillStream) spillStream.end();

      const durationMs = Math.round(performance.now() - startTime);
      logger?.debug({ toolName: "exec", durationMs, exitCode: 1, ...(description && { description }) }, "Exec command complete");

      resolve(
        jsonResult({
          exitCode: 1,
          stdout: "",
          stderr: err.message,
        }),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Background execution
// ---------------------------------------------------------------------------

function executeBackground(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  input: string | undefined,
  registry: ProcessRegistry,
  logger?: ToolLogger,
  sandboxConfig?: ExecSandboxConfig,
  workspacePath?: string,
  tempDir?: string,
  description?: string,
  pty?: boolean,
): AgentToolResult<unknown> {
  const sessionId = generateSessionId();
  const { bin, args, cwd: spawnCwd } = buildSpawnCommand(
    command, cwd, sandboxConfig, workspacePath ?? cwd, tempDir ?? tmpdir(), pty,
  );
  const child = spawn(bin, args, {
    cwd: spawnCwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session: ProcessSession = {
    id: sessionId,
    command,
    pid: child.pid,
    startedAt: Date.now(),
    status: "running",
    exitCode: undefined,
    stdout: "",
    stderr: "",
    child,
    maxOutputChars: BACKGROUND_MAX_OUTPUT_CHARS,
    sandboxed: !!sandboxConfig,
    ...(description && { description }),
  };

  // Output cleaners for stateful UTF-8 decode + ANSI strip + CR normalize + binary sanitize
  const stdoutCleaner = createOutputCleaner();
  const stderrCleaner = createOutputCleaner();

  // Wire stdout/stderr data events
  child.stdout?.on("data", (chunk: Buffer) => {
    appendOutput(session, "stdout", stdoutCleaner.process(chunk));
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    appendOutput(session, "stderr", stderrCleaner.process(chunk));
  });

  // Wire close event
  child.on("close", (code: number | null) => {
    const stdoutFlush = stdoutCleaner.flush();
    const stderrFlush = stderrCleaner.flush();
    if (stdoutFlush) appendOutput(session, "stdout", stdoutFlush);
    if (stderrFlush) appendOutput(session, "stderr", stderrFlush);
    if (code === 0) {
      session.status = "completed";
    } else {
      session.status = "failed";
    }
    session.exitCode = code;
    session.child = undefined;
  });

  // Handle spawn errors
  child.on("error", () => {
    session.status = "failed";
    session.child = undefined;
  });

  // Write stdin if provided
  if (input && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }

  // Unref to allow parent process to exit independently.
  // Skip for sandboxed processes to maintain ProcessRegistry tracking.
  if (!sandboxConfig) {
    child.unref();
  }

  // Register in ProcessRegistry
  registry.add(session);

  logger?.debug({ toolName: "exec", sessionId, pid: child.pid }, "Background process spawned");

  return jsonResult({
    status: "started",
    sessionId,
    pid: child.pid,
    ...(description && { description }),
  });
}
