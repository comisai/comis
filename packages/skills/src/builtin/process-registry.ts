// SPDX-License-Identifier: Apache-2.0
/**
 * ProcessRegistry: shared in-memory store for background process sessions.
 *
 * Created per-agent via factory function (NOT a global singleton).
 * Injected into both exec and process tool factories for shared state.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_CHARS = 1024 * 1024; // 1MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessSession {
  readonly id: string;
  readonly command: string;
  pid: number | undefined;
  readonly startedAt: number;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null | undefined;
  stdout: string;
  stderr: string;
  child: ChildProcess | undefined;
  readonly maxOutputChars: number;
  readonly sandboxed: boolean;  // true when process runs inside bwrap/sandbox-exec
  readonly autoBackgrounded?: boolean; // true when session created by auto-background escalation
  readonly description?: string; // human-readable activity label (e.g. "Installing dependencies")
}

export interface ProcessRegistry {
  add(session: ProcessSession): void;
  get(id: string): ProcessSession | undefined;
  list(): Array<{
    sessionId: string;
    status: string;
    pid: number | undefined;
    command: string;
    startedAt: number;
    runtimeMs: number;
    tail: string;
  }>;
  kill(id: string): Promise<{ exitCode: number | null; killed: boolean }>;
  status(id: string):
    | {
        sessionId: string;
        status: string;
        exitCode: number | null | undefined;
        stdoutLength: number;
        stderrLength: number;
        command: string;
        startedAt: number;
        runtimeMs: number;
      }
    | undefined;
  getLog(
    id: string,
    offset?: number,
    limit?: number,
  ): { lines: string[]; total: number } | undefined;
  cleanup(): Promise<number>;
  size(): number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Append a chunk to a session output field, truncating from the beginning
 * if total length exceeds maxOutputChars.
 */
export function appendOutput(
  session: ProcessSession,
  field: "stdout" | "stderr",
  chunk: string,
): void {
  session[field] += chunk;
  if (session[field].length > session.maxOutputChars) {
    session[field] = session[field].slice(-session.maxOutputChars);
  }
}

/**
 * Kill a process group: SIGTERM first, then SIGKILL after 5 seconds.
 * Returns a promise that resolves when the process is confirmed dead
 * or after the SIGKILL escalation.
 */
function killProcessGroup(
  session: ProcessSession,
): Promise<{ exitCode: number | null; killed: boolean }> {
  return new Promise((resolve) => {
    const child = session.child;
    const pid = session.pid;

    // No child or pid -- already dead or never started
    if (!child || !pid) {
      session.status = "killed";
      return resolve({ exitCode: session.exitCode ?? null, killed: true });
    }

    // Already exited
    if (child.exitCode !== null && child.exitCode !== undefined) {
      session.status = "killed";
      session.exitCode = child.exitCode;
      return resolve({ exitCode: child.exitCode, killed: true });
    }

    let resolved = false;

    const onExit = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(escalationTimer);
      session.status = "killed";
      session.exitCode = code;
      resolve({ exitCode: code, killed: true });
    };

    child.once("exit", onExit);

    // Send SIGTERM: positive PID for sandboxed (bwrap --die-with-parent cascades),
    // negative PID for unsandboxed (process group kill).
    try {
      if (session.sandboxed) {
        process.kill(pid, "SIGTERM");
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      // Process may already be dead
      if (!resolved) {
        resolved = true;
        session.status = "killed";
        resolve({ exitCode: session.exitCode ?? null, killed: true });
        return;
      }
    }

    // Escalate to SIGKILL after 5 seconds
    const escalationTimer = setTimeout(() => {
      if (resolved) return;
      try {
        if (session.sandboxed) {
          process.kill(pid, "SIGKILL");
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch {
        // Process already dead
      }
      // Give a brief moment for the exit event
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.removeListener("exit", onExit);
          session.status = "killed";
          resolve({ exitCode: session.exitCode ?? null, killed: true });
        }
      }, 500);
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new ProcessRegistry instance backed by an in-memory Map.
 *
 * Each registry is independent -- created per-agent in daemon wiring.
 *
 * @param maxOutputChars - Max chars to retain per output field (default 1MB)
 */
export function createProcessRegistry(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
): ProcessRegistry {
  const sessions = new Map<string, ProcessSession>();

  function add(session: ProcessSession): void {
    sessions.set(session.id, session);
  }

  function get(id: string): ProcessSession | undefined {
    return sessions.get(id);
  }

  function list() {
    const now = Date.now();
    return Array.from(sessions.values()).map((s) => {
      const lines = s.stdout.split("\n").filter((l) => l.length > 0);
      const tail = lines.slice(-5).join("\n");
      return {
        sessionId: s.id,
        status: s.status,
        pid: s.pid,
        command: s.command,
        startedAt: s.startedAt,
        runtimeMs: now - s.startedAt,
        tail,
        ...(s.description && { description: s.description }),
      };
    });
  }

  async function kill(
    id: string,
  ): Promise<{ exitCode: number | null; killed: boolean }> {
    const session = sessions.get(id);
    if (!session) {
      throw new Error(`Process session not found: ${id}`);
    }
    if (session.status !== "running") {
      throw new Error(
        `Process session ${id} is not running (status: ${session.status})`,
      );
    }
    return killProcessGroup(session);
  }

  function status(id: string) {
    const session = sessions.get(id);
    if (!session) return undefined;
    return {
      sessionId: session.id,
      status: session.status,
      exitCode: session.exitCode,
      stdoutLength: session.stdout.length,
      stderrLength: session.stderr.length,
      command: session.command,
      startedAt: session.startedAt,
      runtimeMs: Date.now() - session.startedAt,
      ...(session.description && { description: session.description }),
    };
  }

  function getLog(id: string, offset?: number, limit?: number) {
    const session = sessions.get(id);
    if (!session) return undefined;

    const combined = session.stdout + (session.stderr ? "\n" + session.stderr : "");
    const allLines = combined.split("\n");
    const total = allLines.length;
    const effectiveLimit = limit ?? 200;

    if (offset !== undefined) {
      // Explicit offset: return lines from offset with limit
      const slice = allLines.slice(offset, offset + effectiveLimit);
      return { lines: slice, total };
    }

    // No offset: return last N lines
    const slice = allLines.slice(-effectiveLimit);
    return { lines: slice, total };
  }

  async function cleanup(): Promise<number> {
    let killed = 0;
    const killPromises: Promise<void>[] = [];

    for (const session of sessions.values()) {
      if (session.status === "running") {
        killed++;
        killPromises.push(
          killProcessGroup(session).then(() => {
            /* void */
          }),
        );
      }
    }

    await Promise.all(killPromises);
    sessions.clear();
    return killed;
  }

  function size(): number {
    return sessions.size;
  }

  return { add, get, list, kill, status, getLog, cleanup, size };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a unique session ID using crypto.randomUUID().
 */
export function generateSessionId(): string {
  return randomUUID();
}
