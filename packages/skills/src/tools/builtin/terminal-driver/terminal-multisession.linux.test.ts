// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the OPTIONAL live multi-session isolation proof. Spawns 2-3
 * REAL jailed bash sessions under ONE owner, drives a DISTINCT marker into each via
 * the `send_text` TOOL path, settles, then reads each interleaved and asserts every
 * session read returns ONLY its OWN marker — no cross-bleed (the live analog of the
 * in-process isolation test).
 *
 * `describe.skipIf(process.platform !== "linux")` so it COMPILES + SKIPS CLEAN on the
 * macOS author box (the established `.linux.test.ts` pattern) and runs live on
 * `comisvps` (where forkpty + bwrap work). This is the OPTIONAL live corroboration:
 * the BINDING proof is the in-process 3-session isolation test (via the
 * fake worker keying each read reply to its sessionId). This file is NOT a required gate —
 * it is VPS-only and must not fail the macOS suite.
 *
 * The send_text path now runs the cap check before forwarding, so
 * the toolDeps wire a no-limit SessionCaps (every send is audited but never
 * rejected/evicted) — the isolation, not the caps, is under test here.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionSendTextTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import {
  createTerminalSessionRegistry,
  type FakeWorkerChild,
} from "./terminal-session-registry.js";
import { createSessionCaps } from "./terminal-caps.js";
import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike, TerminalScope } from "./allowlist-matcher.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Resolve the daemon's bwrap path once (the seam the registry threads to the worker). */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/** The operator-declared least-privilege scope — sourced from the entry, never params. */
const WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  uid: "dedicated",
};

function realShell(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("no shell binary");
}

/**
 * The in-process bridge wiring the REAL node-pty loader (`defaultLoadPty`) so each
 * session drives a live PTY via forkpty on the VPS — the same shape the live
 * round-trip test uses. ONE worker hosts all sessions (origin-keying is visibility,
 * not a second worker per session — spec §4.7).
 */
function makeBridgedPtyWorkerChild(): FakeWorkerChild {
  const worker = createTerminalWorker({ loadPty: defaultLoadPty, logger: noopLogger });
  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  const child: FakeWorkerChild = {
    pid: 4321,
    stdin: {
      write(chunk: Buffer): boolean {
        for (const frame of decoder.push(chunk)) {
          void worker.handle(frame as TerminalRequestFrame).then((reply) => onStdout?.(encodeFrame(reply)));
        }
        return true;
      },
    },
    stdout: {
      on(_event: "data", cb: (chunk: Buffer) => void): void {
        onStdout = cb;
      },
    },
    on(): FakeWorkerChild {
      return child;
    },
    kill(): void {},
  };
  return child;
}

function toolDeps(registry: ReturnType<typeof createTerminalSessionRegistry>, entry: AllowEntryLike): TerminalToolDeps {
  return {
    registry,
    allowEntries: [entry],
    detectProvider: () => ({}) as never,
    logger: noopLogger,
    eventBus: { emit: () => true },
    nowMs: () => Date.now(),
    agentId: "agent-multisession-linux",
    // no-limit caps: the markers must not be cap-rejected (isolation is under test, not caps).
    caps: createSessionCaps(undefined, () => Date.now()),
  };
}

describe.skipIf(!isLinux())("(Linux) — live multi-session isolation (each session reads ONLY its own bytes)", () => {
  it("spawns 3 real jailed sessions, sends a distinct marker into each, and each read returns only its own marker (no cross-bleed)", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedPtyWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
      // The registry threads bwrapPath onto the create frame so the worker jails bash.
      bwrapPath: resolveBwrapPath(),
    });
    // An interactive bash (no -c) so each session is a live, writable shell we can type into.
    const entry: AllowEntryLike = {
      id: "bash",
      match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-i"] },
      scope: WORKSPACE_SCOPE,
    };

    const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
    const sendTextTool = createTerminalSessionSendTextTool(toolDeps(registry, entry));
    const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));

    // Create 3 real jailed sessions under ONE owner (no RequestContext on the stack →
    // they share the (agentId, "") owner, so each tool call sees all three of its own).
    const sessionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await createTool.execute(`create-${i}`, { allowId: "bash", command: shell, cols: 100, rows: 30 });
      const { sessionId } = created.details as { sessionId: string };
      expect(sessionId.length).toBeGreaterThan(0);
      sessionIds.push(sessionId);
    }
    expect(new Set(sessionIds).size).toBe(3); // three DISTINCT sessions

    // Drive a DISTINCT marker into each session, interleaved (round-robin) so the
    // worker is multiplexing all three at once — the isolation stress.
    const marker = (i: number): string => `SESSION_${i}_MARKER_${sessionIds[i].slice(0, 6)}`;
    for (let round = 0; round < 1; round++) {
      for (let i = 0; i < 3; i++) {
        await sendTextTool.execute(`send-${i}`, { sessionId: sessionIds[i], text: `echo ${marker(i)}`, submit: true });
      }
    }

    // Settle, then read each interleaved and assert each screen carries ONLY its own
    // marker — never a sibling's (the live cross-bleed check).
    for (let i = 0; i < 3; i++) {
      let screen = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await readTool.execute(`read-${i}`, { sessionId: sessionIds[i] });
        screen = (res.details as { screen: string }).screen;
        if (screen.includes(marker(i))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // This read goes through the TOOL layer → the redact + wrap as untrusted
      // external content applies; assert the wrap is present AND the OWN marker is
      // framed inside it (we do NOT weaken that wrapping).
      expect(screen).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(screen).toContain(marker(i)); // its OWN marker rendered
      // … and NONE of the OTHER sessions' markers leaked onto this session's screen.
      for (let j = 0; j < 3; j++) {
        if (j === i) continue;
        expect(screen).not.toContain(marker(j));
      }
    }

    await registry.cleanup();
  });
});
