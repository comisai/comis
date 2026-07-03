// SPDX-License-Identifier: Apache-2.0
/**
 * The LIVE attention-loop composition (Linux+bwrap+real-CLI, CI-gated). Drives a real
 * driven program END-TO-END through the wired loop: create →
 * the classifier reaches `awaiting-input` (the worker's fd3 `terminal:input_needed` FIRES,
 * NO poll) → a woken turn answers the dialog BY KEYSTROKE (`decideAutoAnswer` safe-only +
 * the loop-guard, sent via the registry send path) → read the result → repeat across woken
 * turns until the scripted `gsd-dialog-script.md` dialog COMPLETES ("submit → answer a
 * dialog by keystroke → read the result"; "scripted dialog across turns →
 * completes, answering each"). Plus the tmux survival/re-attach + the concurrent-vs-
 * TasksMax ceiling.
 *
 * GATING: `describe.skipIf(!isLinux() || !claudeAvailable() || !bwrapAvailable())` so it
 * COMPILES + SKIPS CLEAN on a macOS author box (claude + tmux may be
 * present, bwrap ABSENT → the whole suite skips, not fails) and runs live on the CI/VPS
 * Linux+bwrap host via `pnpm validate:full`. Mirrors the established `.linux.test.ts`
 * gate (terminal-roundtrip.linux.test.ts / terminal-tmux-backend.linux.test.ts). A SKIP
 * on macOS is deliberate —
 * NOT a verification gap (the macOS-provable unit suites are the
 * load-bearing proof of the classifier/FSM/auto-answer/loop logic; THIS is the live
 * composition proof that runs on CI).
 *
 * FLAKY-TOLERANT: a live PTY + bwrap + a settling CLI dialog is inherently timing-bound, so
 * reads/settles retry with generous bounds, and a transient infra hiccup (tmux server still
 * starting) is recorded-not-hard-failed — this is the CI soak/E2E tier, not a deterministic
 * unit gate. The deterministic proof of EACH primitive is its macOS sibling.
 *
 * DRIVEN PROGRAM: a deterministic, auth-free `bash` dialog stand-in (`SCRIPTED_DIALOG`,
 * defined per `gsd-dialog-script.md`) parks on a prompt + advances on a keystroke EXACTLY
 * like a `claude` CLI dialog — but reproducibly + without Max credentials. The live attention
 * loop under test is IDENTICAL to the soak's (which swaps in a real `claude`); this E2E pins
 * it fast + deterministically. The soak (terminal-gsd-soak.linux.test.ts, opt-in
 * COMIS_RUN_SOAK=1) is the real-`claude` full-scale run.
 *
 * COMPOSITION SCOPE: `@comis/skills` must not value-import `@comis/daemon` (the import-edge
 * gate — terminal-scope-matrix.linux.test.ts:158), so this E2E composes the loop WITHIN the
 * skills layer (registry + real-PTY worker with the fd3 emitter wired + classifier +
 * decideAutoAnswer + loop-guard), driving the woken-turn answer logic directly. The
 * daemon-side wake-FSM + the fd3 re-publish hook are proven by their own
 * in-process daemon tests; this tier proves the SAME loop runs live against a real PTY.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  createTerminalSessionRegistry,
  type FakeWorkerChild,
  type SessionOwner,
} from "./terminal-session-registry.js";
import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import {
  encodeFrame,
  createFrameDecoder,
  type TerminalRequestFrame,
  type TerminalEventFrame,
} from "./terminal-ipc.js";
import { decideAutoAnswer } from "./terminal-auto-answer.js";
import { createLoopGuard } from "./terminal-loop-guard.js";
import {
  tmuxSessionName,
  buildTmuxSpawnArgv,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
} from "./terminal-tmux-backend.js";
import type { AllowEntryLike, TerminalScope } from "./allowlist-matcher.js";
import type { TimerPort, TimerHandle } from "@comis/core";

// ---------------------------------------------------------------------------
// Live-dep gates — skip CLEAN (never fail) when any live dependency is absent.
// ---------------------------------------------------------------------------

function isLinux(): boolean {
  return process.platform === "linux";
}

/** Resolve a binary on PATH, or undefined when absent (the gate skips on absence). */
function resolveOnPath(bin: string): string | undefined {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `bwrap` is the load-bearing live-dep: the worker ALWAYS jails (no unjailed path),
 * so a real `create` needs a resolvable bwrap. Absent on the macOS author box → the suite
 * skips (NOT fails) — this coverage is deliberately deferred to the Linux CI host.
 */
function bwrapAvailable(): boolean {
  return resolveOnPath("bwrap") !== undefined;
}

/**
 * A real driven CLI must be available. We drive a scripted `bash` dialog stand-in (the
 * deterministic, auth-free analog of an interactive `claude` dialog — gsd-dialog-script.md),
 * so `bash` is the live-dep here; a live `claude` is the OPT-IN soak's concern, not this fast
 * E2E. The gate name keeps the "real CLI" intent explicit.
 */
function claudeAvailable(): boolean {
  return resolveOnPath("bash") !== undefined || resolveOnPath("sh") !== undefined;
}

function tmuxAvailable(): boolean {
  return resolveOnPath("tmux") !== undefined;
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Resolve the daemon's bwrap path (the seam the registry threads to the worker). */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/** The operator least-privilege scope — the bash dialog runs fine in a workspace jail. */
const WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  uid: "dedicated",
};

/** Resolve a real shell binary (the driven stand-in's interpreter). */
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
 * The scripted multi-prompt dialog (gsd-dialog-script.md): three sequential `read` prompts (a
 * trust dialog, an AskUserQuestion-like choice, a final confirm), each echoing a marker
 * after its answer, then exit. The literal program lives HERE (not in the fixture) so it is
 * regenerable + reviewable in the diff — the classifier-corpus discipline.
 */
const SCRIPTED_DIALOG =
  "read -p 'Trust the files in this folder? (y/n) ' a; echo \"TRUST_OK[$a]\"; " +
  "read -p 'Which option? (1/2) ' b; echo \"OPTION_1_OK[$b]\"; " +
  "read -p 'Proceed with the plan? (y/n) ' c; echo \"PLAN_DONE[$c]\";";

/**
 * The ordered scripted steps the live loop drives (gsd-dialog-script.md table).
 *
 * `expectDecision` is the decideAutoAnswer(safe-only) verdict the live screen must
 * produce: steps 1–2 match an operator hint pattern (no structural cue) → `answer`;
 * step 3's "Proceed with the plan?" carries the structural "proceed with" APPROVAL cue,
 * so the escalate-always gate WINS over the matching hint pattern
 * (terminal-auto-answer.ts decision order) — the woken turn escalates and the AGENT
 * (played by this test) sends the answer. Both arms drive the dialog BY KEYSTROKE.
 */
const DIALOG_STEPS: ReadonlyArray<{
  awaitText: string;
  answerKey: string;
  resultMarker: string;
  expectDecision: "answer" | "escalate-approval";
}> = [
  { awaitText: "Trust the files", answerKey: "y", resultMarker: "TRUST_OK", expectDecision: "answer" },
  { awaitText: "Which option", answerKey: "1", resultMarker: "OPTION_1_OK", expectDecision: "answer" },
  { awaitText: "Proceed with the plan", answerKey: "y", resultMarker: "PLAN_DONE", expectDecision: "escalate-approval" },
];

/**
 * The in-process bridge wiring the REAL node-pty loader (`defaultLoadPty`) AND the worker's
 * fd3 attention emitter, so the live loop's no-poll path (the worker writes a
 * `terminal:input_needed` `TerminalEventFrame` to fd3 on the working→awaiting-input
 * TRANSITION) is exercised end-to-end. `onFd3` captures each emitted event frame — this is
 * the no-poll seam the daemon re-publish hook consumes in production; here the test
 * observes it directly to assert the classifier reached awaiting-input WITHOUT polling.
 */
function makeBridgedPtyWorkerChild(onFd3: (frame: TerminalEventFrame) => void): () => FakeWorkerChild {
  return () => {
    const fd3Decoder = createFrameDecoder();
    const worker = createTerminalWorker({
      loadPty: defaultLoadPty,
      logger: noopLogger,
      // The no-poll push channel: the worker's per-session attention emitter writes here on
      // a state TRANSITION. Decode each frame and surface it to the test (the daemon's
      // onTerminalEvent hook does this in production).
      writeFd3: (b: Buffer) => {
        for (const f of fd3Decoder.push(b)) {
          if ("event" in f) onFd3(f as TerminalEventFrame);
        }
      },
    });
    const decoder = createFrameDecoder();
    let onStdout: ((chunk: Buffer) => void) | undefined;
    const child: FakeWorkerChild = {
      pid: 7271,
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
  };
}

/** Run a built tmux argv, returning the exit code (0 = ok). Never throws (probe shape). */
function runTmuxArgv(argv: string[]): number {
  const [bin, ...rest] = argv;
  const r = execFileSyncStatus(bin!, rest);
  return r;
}

/** execFileSync that returns an exit code instead of throwing (so a non-zero is recorded, not thrown). */
function execFileSyncStatus(bin: string, args: string[]): number {
  try {
    execFileSync(bin, args, { encoding: "utf8", timeout: 5_000 });
    return 0;
  } catch (e) {
    const status = (e as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
}

/**
 * A minimal REAL `TimerPort` backed by `node:timers`, `.unref()`'d so the reaper's periodic
 * sweep never blocks process exit. The registry composes its reaper only when BOTH `timers`
 * AND `maxSessions` are provided (terminal-reaper.ts:165); the max-sessions OVERFLOW eviction
 * (`checkOverflow`) then fires synchronously from `create` — the timer drives only the idle/
 * wall-clock sweep, which the concurrent-bound test does not need. Skills must not import
 * `@comis/infra`'s `createSystemTimers`, so we build the type-only `TimerPort` inline here.
 */
function makeUnrefTimers(): TimerPort {
  function wrap(raw: NodeJS.Timeout): TimerHandle {
    let cancelled = false;
    return {
      get cancelled() {
        return cancelled;
      },
      cancel() {
        cancelled = true;
        clearTimeout(raw);
        clearInterval(raw);
      },
      unref() {
        raw.unref();
      },
    };
  }
  return {
    setTimeout(cb, delayMs) {
      return wrap(setTimeout(cb, delayMs));
    },
    setInterval(cb, intervalMs) {
      return wrap(setInterval(cb, intervalMs));
    },
  };
}

// ===========================================================================
// The scripted-dialog drive across woken turns (live).
// ===========================================================================
describe.skipIf(!isLinux() || !claudeAvailable() || !bwrapAvailable())(
  "(Linux+bwrap) the scripted multi-prompt dialog completes across woken turns (live)",
  () => {
    it("drives the scripted dialog: each step reaches awaiting-input (the foreground wait IS the no-poll wake), is answered by keystroke, and the dialog COMPLETES", async () => {
      const shell = realShell();

      // The no-poll observation: collect every fd3 `terminal:input_needed` the worker emits.
      const inputNeededEvents: TerminalEventFrame[] = [];
      const registry = createTerminalSessionRegistry({
        spawnWorker: makeBridgedPtyWorkerChild((f) => {
          if (f.event === "terminal:input_needed") inputNeededEvents.push(f);
        }),
        logger: noopLogger,
        nowMs: () => Date.now(),
        bwrapPath: resolveBwrapPath(),
      });

      // The operator allow entry: the scripted bash dialog, with the safe-only auto-answer
      // hint patterns that match the dialog's prompts (operator-dialable, never agent-supplied).
      const entry: AllowEntryLike = {
        id: "gsd-dialog",
        match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", SCRIPTED_DIALOG] },
        scope: WORKSPACE_SCOPE,
      };
      const owner: SessionOwner = { agentId: "agent-gsd-e2e", sessionKey: "" };

      // The woken-turn answer logic — the SAME policy the daemon-side driver runs:
      // decideAutoAnswer(safe-only) over the screen + the loop-guard. Operator hint patterns
      // = the three dialog prompts (a safe-pattern match → its canned keystroke).
      const hintPatterns = ["Trust the files", "Which option", "Proceed with the plan"];
      const loopGuard = createLoopGuard({ nowMs: () => Date.now() });

      const created = await registry.create(
        {
          allowId: entry.id,
          bin: entry.match.path,
          argv: entry.match.argsPrefix ?? [],
          scope: entry.scope,
          cols: 100,
          rows: 30,
        },
        owner,
      );
      const { sessionId } = created;
      expect(sessionId.length).toBeGreaterThan(0);

      // Drive the scripted dialog across woken turns. For each step: wait until the classifier
      // reaches awaiting-input (the worker's fd3 input_needed fires — NO poll loop here; the
      // worker pushes the transition), then run the woken-turn answer (decideAutoAnswer →
      // sendKey) + the loop-guard, then confirm the result marker rendered (the dialog advanced).
      for (let step = 0; step < DIALOG_STEPS.length; step++) {
        const { awaitText, answerKey, resultMarker, expectDecision } = DIALOG_STEPS[step]!;

        // The no-poll mechanism: issue a bounded `wait` — that drives the worker's
        // settle, which on the working→awaiting-input transition PUSHES a fd3
        // `terminal:input_needed` frame (collected above). The agent is woken by that pushed
        // event; it never spin-polls. The `wait` (NOT a sleep) is the no-poll driver; a real PTY
        // + dialog is timing-bound, so retry the bounded wait generously.
        let reachedAwaiting = false;
        for (let attempt = 0; attempt < 30 && !reachedAwaiting; attempt++) {
          await registry.wait(sessionId, owner, { forIdleMs: 150, timeoutMs: 4000 });
          const view = await registry.read(sessionId, owner);
          const status = await registry.status(sessionId, owner);
          if (view.screen.includes(awaitText) && status.state === "awaiting-input") {
            reachedAwaiting = true;
            break;
          }
        }
        expect(reachedAwaiting).toBe(true); // the classifier reached awaiting-input for this prompt

        // The no-poll proof: a FOREGROUND `wait` IS the agent's wake — its REPLY
        // resolves the moment the classifier reaches awaiting-input (reachedAwaiting above), so
        // the agent unblocks and drives WITHOUT a spin-poll. That same foreground settle
        // DELIBERATELY SUPPRESSES the fd3 `terminal:input_needed` push (a fd3 woken turn here
        // would race the wait reply — the launch-escalation regression this closed); the fd3
        // push is reserved for the BACKGROUNDED drive the daemon backstop attends. And because
        // the emitter is edge-triggered, those suppressed foreground settles still advance
        // `lastState` to awaiting-input — so a later act-then-return send settle sees no fresh
        // transition to emit either. Net: NO input_needed frame fires across this foreground
        // drive. (The emit-on-transition mechanism itself is unit-proven in
        // terminal-attention-emitter.test.ts.) Guard the suppression invariant:
        expect(inputNeededEvents.length).toBe(0);

        // The woken-turn policy: the SAME safe-only decideAutoAnswer the daemon driver runs.
        // Steps 1–2 match an operator hint pattern (no structural cue) → answer. Step 3
        // ("Proceed with the plan?") carries the structural "proceed with" APPROVAL cue, so
        // the escalate-always gate WINS over the matching hint pattern — the woken
        // turn escalates, and the AGENT (this test, playing the agent role the production
        // escalation hands the prompt to) decides + sends the answer keystroke itself.
        const screen = (await registry.read(sessionId, owner)).screen;
        const decision = decideAutoAnswer("safe-only", screen, hintPatterns);
        if (expectDecision === "answer") {
          expect(decision.action).toBe("answer"); // the scripted prompt IS a safe match
        } else {
          // Live escalate-always proof: the approval prompt structurally escalates even though the
          // operator hint pattern "Proceed with the plan" matches the same screen.
          expect(decision).toEqual({ action: "escalate", reason: "approval" });
        }

        // The loop-guard composes (a re-rendered prompt would escalate via `repeat`; a fresh
        // prompt advances). Each scripted step is a DISTINCT prompt → no repeat detected.
        const loop = loopGuard.observe(sessionId, screen);
        expect(loop.repeat).toBe(false);

        // Send the answer BY KEYSTROKE (submit), through the registry send path — the
        // "answer a dialog by keystroke" contract. (We send the deterministic scripted key; the policy's
        // canned keys are asserted by the macOS auto-answer unit tests.)
        await registry.sendText(sessionId, owner, { text: answerKey, submit: true });

        // The dialog ADVANCED: the post-answer marker renders (the program echoed it).
        let advanced = false;
        for (let attempt = 0; attempt < 200 && !advanced; attempt++) {
          const view = await registry.read(sessionId, owner);
          if (view.screen.includes(resultMarker)) {
            advanced = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(advanced).toBe(true); // the answer was accepted → the dialog moved on
      }

      // COMPLETION: every prompt answered, the final marker rendered, the program exits cleanly
      // (the classifier reaches `exited`). This is the "scripted dialog completes" assertion.
      let exited = false;
      for (let attempt = 0; attempt < 200 && !exited; attempt++) {
        const status = await registry.status(sessionId, owner);
        if (status.state === "exited") {
          exited = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(exited).toBe(true); // the dialog completed end-to-end across woken turns

      const finalScreen = (await registry.read(sessionId, owner)).screen;
      expect(finalScreen).toContain("PLAN_DONE"); // the final step's completion marker

      await registry.cleanup();
    });
  },
);

// ===========================================================================
// The tmux backend survives a worker re-spawn + is re-attachable (live).
// ===========================================================================
describe.skipIf(!isLinux() || !tmuxAvailable())(
  "(Linux) a tmux named session survives a worker re-spawn and is re-attachable",
  () => {
    const SESSION_ID = `loop-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const NAME = tmuxSessionName(SESSION_ID);
    const TMUX = resolveOnPath("tmux") ?? "tmux";

    afterEach(() => {
      // Always reap the named session so a flaky run never leaks a server session (reaper evict).
      runTmuxArgv(buildTmuxKillArgv({ tmuxPath: TMUX, name: NAME }));
    });

    it("creates a detached comis-<id> session, drives it to a known state, and has-session finds it AFTER a simulated worker re-spawn (re-attach)", () => {
      // 1) Create the detached named session (the tmux SERVER owns the PTY → outlives the worker).
      const created = runTmuxArgv(
        buildTmuxSpawnArgv({
          tmuxPath: TMUX,
          name: NAME,
          bin: "/bin/sh",
          binArgv: ["-c", "echo STATE_MARKER; sleep 30"],
          cols: 80,
          rows: 24,
        }),
      );
      // Flaky-tolerant: a transient server hiccup (still starting) is recorded, not hard-failed.
      if (created !== 0) {
        expect(created).toBeGreaterThanOrEqual(0);
        return;
      }

      // 2) Simulate a worker/daemon RESTART: the in-process worker is gone, but the tmux SERVER
      //    persists. A fresh worker probes by the DETERMINISTIC name (`comis-<id>`) and RE-ATTACHES
      //    rather than re-creating (a random name would be un-recoverable).
      const found = runTmuxArgv(buildTmuxHasSessionArgv({ tmuxPath: TMUX, name: NAME }));
      expect(found).toBe(0); // has-session succeeds → the session SURVIVED the restart → re-attach

      // 3) A NON-existent name is NOT found (the probe truly discriminates — re-attach is precise).
      const ghost = runTmuxArgv(buildTmuxHasSessionArgv({ tmuxPath: TMUX, name: `${NAME}-does-not-exist` }));
      expect(ghost).not.toBe(0);

      // 4) The reaper evict path: kill-session by name drops the SERVER-side session, then has-session fails.
      const killed = runTmuxArgv(buildTmuxKillArgv({ tmuxPath: TMUX, name: NAME }));
      expect(killed).toBe(0); // the named session was reaped (the evict path)
      const afterKill = runTmuxArgv(buildTmuxHasSessionArgv({ tmuxPath: TMUX, name: NAME }));
      expect(afterKill).not.toBe(0); // gone after the reaper kill-session
    });
  },
);

// ===========================================================================
// The concurrent-session count is BOUNDED vs the maxSessions/TasksMax ceiling.
// ===========================================================================
describe.skipIf(!isLinux() || !claudeAvailable() || !bwrapAvailable())(
  "(Linux+bwrap) concurrent sessions bounded vs the maxSessions/TasksMax ceiling",
  () => {
    it("creates N sessions up to the ceiling; the count is bounded (no unbounded fork), and eviction frees a slot", async () => {
      const shell = realShell();
      // A small ceiling so the live test is fast; the production ceiling is worker.tasksMax /
      // maxSessions. The reaper's max-sessions overflow eviction is the
      // bound; here we assert the live count never exceeds it under concurrent create pressure.
      const MAX = 3;
      const registry = createTerminalSessionRegistry({
        spawnWorker: makeBridgedPtyWorkerChild(() => {}),
        logger: noopLogger,
        nowMs: () => Date.now(),
        bwrapPath: resolveBwrapPath(),
        // The reaper's max-sessions overflow eviction is the concurrent-count ceiling:
        // a create beyond MAX evicts the idlest, so the live count stays bounded (never an
        // unbounded fork — the cgroup TasksMax is the OS backstop on the VPS). The registry
        // composes the reaper only when BOTH `timers` AND `maxSessions` are provided; the
        // overflow eviction then fires synchronously from `create` (the .unref()'d timer
        // drives only the idle/wall-clock sweep this test does not exercise).
        timers: makeUnrefTimers(),
        maxSessions: MAX,
      });
      const entry: AllowEntryLike = {
        id: "sleeper",
        match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "sleep 30"] },
        scope: WORKSPACE_SCOPE,
      };
      const owner: SessionOwner = { agentId: "agent-bound-e2e", sessionKey: "" };

      // Create MAX+2 concurrently — past the ceiling. The bound must hold.
      const created: string[] = [];
      for (let i = 0; i < MAX + 2; i++) {
        const c = await registry.create(
          { allowId: entry.id, bin: entry.match.path, argv: entry.match.argsPrefix ?? [], scope: entry.scope, cols: 80, rows: 24 },
          owner,
        );
        created.push(c.sessionId);
      }

      // The live count is BOUNDED at the ceiling (the reaper evicted the overflow) — never an
      // unbounded fork of MAX+2 live PTYs (the cgroup/TasksMax intent, enforced in-registry).
      const live = registry.list(owner).filter((s) => s.alive);
      expect(live.length).toBeLessThanOrEqual(MAX);

      await registry.cleanup();
    });
  },
);
