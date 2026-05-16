// SPDX-License-Identifier: Apache-2.0
/**
 * Exec foreground execution (Phase 43 split per FILE-SPLIT-02).
 *
 * Extracted from `exec-tool.ts` (1,626L monolith) on 2026-05-16. Pure
 * mechanical block-move of `executeForeground` (lines 1149-1497 of
 * pre-split exec-tool.ts). Calls `escalateToBackground` from exec-background
 * for the auto-bg escalation path; no cycle (background does not call back
 * into foreground).
 *
 * @module
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { safePath, systemClearTimeout, systemNowMs, systemSetTimeout } from "@comis/core";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExecSandboxConfig } from "../sandbox/types.js";
import type { ProcessRegistry } from "../process-registry.js";
import { truncateTail, formatSize, DEFAULT_MAX_BYTES } from "../truncate.js";
import { createOutputCleaner } from "../output-cleaner.js";
import { interpretExitCode } from "../exec-security.js";
import { matchExecRecoveryHint } from "../exec-diagnostics.js";
import {
  jsonResult,
} from "../../../platform-tools/tool-helpers.js";
import type { InstallDetourDecision } from "../install-detour.js";
import {
  MAX_PERSIST_BYTES,
  ROLLING_BUFFER_MAX,
  type ToolLogger,
} from "./exec-types.js";
import { buildSpawnCommand, killTree, buildInstallDetourHint } from "./exec-shared.js";
import { escalateToBackground } from "./exec-background.js";

// ---------------------------------------------------------------------------
// Foreground execution
// ---------------------------------------------------------------------------

export function executeForeground(
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
  installDetourDecision?: InstallDetourDecision,
  installDetourMode?: "observe" | "advise" | "soft-stop",
): Promise<AgentToolResult<unknown>> {
  const startTime = performance.now();
  const startTimeMs = systemNowMs();

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
    const timeoutTimer = systemSetTimeout(() => {
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
      ? systemSetTimeout(() => {
          if (resolved) return;
          escalateToBackground({
            command, child, startTime, startTimeMs, stdoutBuf, stderrBuf,
            registry, sandboxConfig, logger, spillStream,
            signal, onAbort, timeoutTimer, resolve,
            setResolved: () => { resolved = true; },
            description,
            // Forward install-detour spawn-time decision + mode
            ...(installDetourDecision !== undefined && { installDetourDecision }),
            ...(installDetourMode !== undefined && { installDetourMode }),
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
      systemClearTimeout(timeoutTimer);
      if (escalationTimer) systemClearTimeout(escalationTimer);
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

      // Recovery diagnostics: prepend a `RECOVERY HINT:` line for known-recoverable
      // failures (e.g. Python ModuleNotFoundError + missing pyproject.toml). Same
      // surfacing pattern as breakSystemWarning on stdout — gives the LLM an
      // actionable next step at the HEAD of stderr instead of buried in JSON.
      const recoveryHint = matchExecRecoveryHint({ stderr: finalStderr, exitCode, cwd });
      if (recoveryHint) {
        finalStderr = recoveryHint + (finalStderr ? "\n" + finalStderr : "");
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

      // Foreground completion envelope augmentation
      if (
        installDetourMode === "advise" &&
        installDetourDecision !== undefined &&
        installDetourDecision.overlaps.length > 0
      ) {
        const hint = buildInstallDetourHint(installDetourDecision);
        result.installDetourHint = hint.installDetourHint;
        const augmented = jsonResult(result);
        resolve({
          content: [...augmented.content, hint.hintContentBlock],
          details: augmented.details,
        });
        return;
      }
      resolve(jsonResult(result));
    });

    // Handle spawn errors
    child.on("error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      systemClearTimeout(timeoutTimer);
      if (escalationTimer) systemClearTimeout(escalationTimer);
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
