// SPDX-License-Identifier: Apache-2.0
/**
 * Exec background execution.
 *
 * Hosts `escalateToBackground` and `executeBackground`, extracted from
 * the exec-tool monolith.
 *
 * Note: foreground.ts calls escalateToBackground from this module; this
 * module does NOT call back into foreground.ts — no cycle.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { systemClearTimeout, systemNowMs } from "@comis/core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecSandboxConfig } from "../sandbox/types.js";
import type { ProcessRegistry, ProcessSession } from "../process-registry.js";
import { generateSessionId, appendOutput } from "../process-registry.js";
import { truncateTail } from "../truncate.js";
import { createOutputCleaner } from "../output-cleaner.js";
import { jsonResult } from "../../../platform-tools/tool-helpers.js";
import type { InstallDetourDecision } from "../install-detour.js";
import {
  BACKGROUND_MAX_OUTPUT_CHARS,
  type EscalationContext,
  type ToolLogger,
} from "./exec-types.js";
import { buildSpawnCommand, buildInstallDetourHint } from "./exec-shared.js";

// ---------------------------------------------------------------------------
// Auto-background escalation helper
// ---------------------------------------------------------------------------

/**
 * Execute auto-background escalation: create a ProcessRegistry session from
 * the running child, re-wire output streams, and resolve with a
 * "backgrounded" status containing the sessionId for polling.
 */
export function escalateToBackground(ctx: EscalationContext): void {
  ctx.setResolved();
  systemClearTimeout(ctx.timeoutTimer);
  if (ctx.signal) ctx.signal.removeEventListener("abort", ctx.onAbort);

  const session: ProcessSession = {
    id: generateSessionId(),
    command: ctx.command,
    pid: ctx.child.pid,
    startedAt: ctx.startTimeMs,
    status: "running",
    exitCode: undefined,
    stdout: ctx.stdoutBuf,
    stderr: ctx.stderrBuf,
    child: ctx.child,
    maxOutputChars: BACKGROUND_MAX_OUTPUT_CHARS,
    sandboxed: !!ctx.sandboxConfig,
    autoBackgrounded: true,
    ...(ctx.description && { description: ctx.description }),
    // Spawn-time decision capture (advise+overlap only).
    // observe-mode runs unchanged with no retroactive hint; soft-stop refused calls
    // never reach a session-creation site (refused pre-spawn).
    ...(ctx.installDetourDecision !== null
      && ctx.installDetourDecision !== undefined
      && ctx.installDetourDecision.overlaps.length > 0
      && ctx.installDetourMode === "advise"
      && { installDetourDecision: ctx.installDetourDecision }),
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
  // Auto-bg envelope augmentation in advise mode
  if (
    ctx.installDetourMode === "advise" &&
    ctx.installDetourDecision !== null &&
    ctx.installDetourDecision !== undefined &&
    ctx.installDetourDecision.overlaps.length > 0
  ) {
    const hint = buildInstallDetourHint(ctx.installDetourDecision);
    const augmented = jsonResult({
      status: "backgrounded",
      sessionId: session.id,
      ...(ctx.sandboxConfig ? {} : { pid: ctx.child.pid }),
      stdoutSoFar: truncateTail(ctx.stdoutBuf).content,
      stderrSoFar: truncateTail(ctx.stderrBuf).content,
      ...(ctx.description && { description: ctx.description }),
      installDetourHint: hint.installDetourHint,
    });
    ctx.resolve({
      content: [...augmented.content, hint.hintContentBlock],
      details: augmented.details,
    });
    return;
  }
  ctx.resolve(jsonResult({
    status: "backgrounded",
    sessionId: session.id,
    ...(ctx.sandboxConfig ? {} : { pid: ctx.child.pid }),
    stdoutSoFar: truncateTail(ctx.stdoutBuf).content,
    stderrSoFar: truncateTail(ctx.stderrBuf).content,
    ...(ctx.description && { description: ctx.description }),
  }));
}

// ---------------------------------------------------------------------------
// Background execution
// ---------------------------------------------------------------------------

export function executeBackground(
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
  installDetourDecision?: InstallDetourDecision,
  installDetourMode?: "observe" | "advise" | "soft-stop",
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
    startedAt: systemNowMs(),
    status: "running",
    exitCode: undefined,
    stdout: "",
    stderr: "",
    child,
    maxOutputChars: BACKGROUND_MAX_OUTPUT_CHARS,
    sandboxed: !!sandboxConfig,
    ...(description && { description }),
    // Spawn-time decision capture (advise+overlap only).
    ...(installDetourDecision !== undefined
      && installDetourDecision.overlaps.length > 0
      && installDetourMode === "advise"
      && { installDetourDecision }),
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

  // Explicit-bg envelope augmentation in advise mode
  if (
    installDetourMode === "advise" &&
    installDetourDecision !== undefined &&
    installDetourDecision.overlaps.length > 0
  ) {
    const hint = buildInstallDetourHint(installDetourDecision);
    const augmented = jsonResult({
      status: "started",
      sessionId,
      ...(sandboxConfig ? {} : { pid: child.pid }),
      ...(description && { description }),
      installDetourHint: hint.installDetourHint,
    });
    return {
      content: [...augmented.content, hint.hintContentBlock],
      details: augmented.details,
    };
  }

  return jsonResult({
    status: "started",
    sessionId,
    ...(sandboxConfig ? {} : { pid: child.pid }),
    ...(description && { description }),
  });
}
