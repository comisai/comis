// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the transition-only in-worker attention emitter (spec §2.3, TR-11).
 *
 * `createAttentionEmitter({ sessionId, writeFd3 })` is the no-poll mechanism's
 * WORKER half: the worker calls `observe(classification)` after each `classifyFrame`
 * on a settled frame; the emitter writes a length-prefixed {@link TerminalEventFrame}
 * to the injected `writeFd3` ONLY when the classified state TRANSITIONS (working →
 * awaiting-input, etc.) — never on an unchanged state, never on a timer. These tests
 * prove the EDGE-TRIGGERED contract (the load-bearing TR-11 invariant: the agent is
 * woken by the event, never spun) using a capturing fake fd3-writer (RESEARCH A1) — so
 * the logic is provable on macOS regardless of the `--permission` fd3 posture.
 *
 * Pure-JS / fully-injected → runs green without forking. Decodes each captured fd3
 * Buffer with the symmetric framer so the wire shape is asserted end-to-end.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { createAttentionEmitter } from "./terminal-attention-emitter.js";
import { decodeFrames, type TerminalEventFrame } from "./terminal-ipc.js";
import type { Classification, ClassifierState } from "./terminal-classifier.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Build a {@link Classification} for a state (the emitter keys ONLY on `c.state`). */
function classification(state: ClassifierState, reason = `${state}_reason`): Classification {
  return { state, confidence: "high", reason };
}

/**
 * A capturing fake fd3-writer + a decoder over everything written, so a test reads
 * the emitted {@link TerminalEventFrame}s back off the wire (the framer is symmetric).
 */
function makeFd3Capture(): {
  writeFd3: (b: Buffer) => void;
  buffers: Buffer[];
  frames: () => TerminalEventFrame[];
} {
  const buffers: Buffer[] = [];
  return {
    writeFd3: (b: Buffer) => {
      buffers.push(b);
    },
    buffers,
    frames: () =>
      buffers.length === 0
        ? []
        : (decodeFrames(Buffer.concat(buffers)) as TerminalEventFrame[]),
  };
}

describe("createAttentionEmitter — TR-11 transition-only fd3 emit (the no-poll mechanism)", () => {
  it("emits exactly ONE terminal:input_needed frame on the working -> awaiting-input transition", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    // working, working, awaiting-input → a single transition (the LAST step).
    emitter.observe(classification("working"));
    emitter.observe(classification("working"));
    emitter.observe(classification("awaiting-input", "settled_cursor_parked"));

    const frames = cap.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].sessionId).toBe("s1");
    expect(frames[0].event).toBe("terminal:input_needed");
    expect(frames[0].payload).toMatchObject({ state: "awaiting-input", reason: "settled_cursor_parked" });
  });

  it("does NOT re-emit on an unchanged state — repeated awaiting-input after the first is a no-op (edge-triggered, not level-triggered)", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe(classification("working"));
    emitter.observe(classification("awaiting-input")); // the ONE transition
    emitter.observe(classification("awaiting-input")); // no-change → no frame
    emitter.observe(classification("awaiting-input")); // no-change → no frame

    expect(cap.frames()).toHaveLength(1);
  });

  it("emits exactly one terminal:stuck frame carrying {noProgressMs} on the working -> stuck transition", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe(classification("working"));
    emitter.observe(classification("stuck", "no_progress"), { noProgressMs: 45_000 });

    const frames = cap.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("terminal:stuck");
    expect(frames[0].payload).toMatchObject({ noProgressMs: 45_000 });
  });

  it("emits a session_state(exited) frame the registry can act on, on the transition to exited (single-homed; the worker hosts other sessions so a per-session exit needs its own signal)", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe(classification("working"));
    emitter.observe(classification("exited", "pty_exit"));

    const frames = cap.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("terminal:session_state");
    expect(frames[0].payload).toMatchObject({ state: "exited" });
  });

  it("re-emits on a DISTINCT transition (awaiting-input -> working -> awaiting-input is two input_needed frames)", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe(classification("awaiting-input")); // transition #1 (from the implicit unknown start)
    emitter.observe(classification("working")); // working is not an attention state → no frame, but updates last-state
    emitter.observe(classification("awaiting-input")); // transition #2 (working → awaiting-input again)

    const frames = cap.frames();
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.event === "terminal:input_needed")).toBe(true);
  });

  it("the emitted payload is redaction-safe — it carries state/reason/counts ONLY, never a screen or text field", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe(classification("awaiting-input", "settled_cursor_parked"));
    emitter.observe(classification("stuck"), { noProgressMs: 31_000 });

    for (const frame of cap.frames()) {
      const payload = frame.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty("screen");
      expect(payload).not.toHaveProperty("text");
      expect(payload).not.toHaveProperty("snapshot");
      expect(payload).not.toHaveProperty("cursor");
    }
  });

  it("exposes NO timer/interval — it is driven by observe() calls alone (the no-poll guarantee)", () => {
    // The emitter must never schedule work. We assert the FACTORY touches no timer
    // global by spying on the globals the architecture gate forbids; a single observe
    // drives an emit synchronously with zero scheduling.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const cap = makeFd3Capture();

    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });
    emitter.observe(classification("awaiting-input"));

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(cap.frames()).toHaveLength(1); // the emit happened synchronously, in-line with observe
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it("two emitter instances do not share last-state (closure-local, no module-global) — each emits its own first transition", () => {
    const capA = makeFd3Capture();
    const capB = makeFd3Capture();
    const a = createAttentionEmitter({ sessionId: "sA", writeFd3: capA.writeFd3 });
    const b = createAttentionEmitter({ sessionId: "sB", writeFd3: capB.writeFd3 });

    a.observe(classification("awaiting-input"));
    b.observe(classification("awaiting-input"));

    expect(capA.frames()).toHaveLength(1);
    expect(capB.frames()).toHaveLength(1);
    expect(capA.frames()[0].sessionId).toBe("sA");
    expect(capB.frames()[0].sessionId).toBe("sB");
  });
});

// ---------------------------------------------------------------------------
// CLASS-02 (163-04) Task 1 — the core↔skills MIRROR-PARITY guard.
//
// `terminal-events-attention.ts` mirrors the core `TerminalEvents` keys
// one-for-one so the daemon's `TypedEventBus` stays structurally compatible with
// the bus the skills layer emits on. There is NO existing parity guard for these
// shapes, so a `confidence` added to the core type but MISSED on the skills mirror
// would be a silent no-op (the project_mcp_field_plumbing bug class) — caught only
// at build:clean, not in vitest. This source-introspection assertion makes a missed
// mirror RED in THIS plan's vitest verify (esbuild strips type annotations, so the
// source layer is the genuinely-RED one). RED on pre-patch: the mirror has neither
// `confidence` (input_needed + stuck) nor `reason` (stuck) yet.
// ---------------------------------------------------------------------------
describe("CLASS-02 — terminal-events-attention.ts mirrors confidence (+ stuck reason) one-for-one", () => {
  /** Slice an `export interface <Name> { ... }` block out of the mirror source. */
  function ifaceBlock(src: string, name: string): string {
    const match = src.match(new RegExp(`export interface ${name}\\s*\\{[\\s\\S]*?\\n\\}`));
    expect(match, `${name} interface must exist in terminal-events-attention.ts`).toBeTruthy();
    return match![0];
  }

  it("TerminalInputNeededEvent (skills mirror) declares confidence (CLASS-02 source RED on pre-patch)", () => {
    const src = readFileSync(resolve(here, "./terminal-events-attention.ts"), "utf8");
    expect(ifaceBlock(src, "TerminalInputNeededEvent"), "input_needed mirror declares confidence").toMatch(
      /confidence/,
    );
  });

  it("TerminalStuckEvent (skills mirror) declares confidence AND reason (CLASS-02 source RED on pre-patch)", () => {
    const src = readFileSync(resolve(here, "./terminal-events-attention.ts"), "utf8");
    const block = ifaceBlock(src, "TerminalStuckEvent");
    expect(block, "stuck mirror declares confidence").toMatch(/confidence/);
    expect(block, "stuck mirror declares reason").toMatch(/reason/);
  });

  it("the skills mirror stays a PURE type-decl file — it value-imports nothing", () => {
    const src = readFileSync(resolve(here, "./terminal-events-attention.ts"), "utf8");
    // Only `import type` (or no import) is allowed — a value `import …` would breach
    // the worker ↛ @comis/infra boundary the module's doc-comment promises.
    expect(src, "no value import in the mirror").not.toMatch(/^import\s+(?!type\b)/m);
  });
});

// ---------------------------------------------------------------------------
// CLASS-02 (163-04) Task 2 — frameForState threads c.confidence (+ c.reason on
// stuck) onto the fd3 frame payload.
//
// The Classification `c` already carries `.confidence` + `.reason` (it is the
// observe() input). Today the input_needed payload drops `confidence` and the
// stuck payload drops BOTH. These tests decode the captured fd3 frame and assert
// the payload now carries the verdict's confidence (and stuck's reason) — while
// staying content-free (no screen/text/cursor field). RED on pre-patch (the
// stuck payload has no confidence/reason; input_needed has no confidence).
// ---------------------------------------------------------------------------
describe("CLASS-02 — frameForState carries confidence (+ stuck reason), content-free", () => {
  it("input_needed frame payload carries the verdict confidence (not a hardcoded default)", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    // A `medium`-confidence dialog detection (the CLASS-01 shape) — prove the ACTUAL
    // value threads through, not a constant.
    emitter.observe({ state: "awaiting-input", confidence: "medium", reason: "dialog_detected" });

    const frames = cap.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("terminal:input_needed");
    expect(frames[0].payload).toMatchObject({
      state: "awaiting-input",
      reason: "dialog_detected",
      confidence: "medium",
    });
  });

  it("stuck frame payload carries confidence AND reason AND noProgressMs (stuck currently drops confidence + reason)", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe(
      { state: "stuck", confidence: "medium", reason: "no_progress" },
      { noProgressMs: 30_000 },
    );

    const frames = cap.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("terminal:stuck");
    expect(frames[0].payload).toMatchObject({
      noProgressMs: 30_000,
      reason: "no_progress",
      confidence: "medium",
    });
  });

  it("neither the input_needed nor the stuck payload leaks a screen/text/cursor field (redaction-safe by construction)", () => {
    const cap = makeFd3Capture();
    const emitter = createAttentionEmitter({ sessionId: "s1", writeFd3: cap.writeFd3 });

    emitter.observe({ state: "awaiting-input", confidence: "medium", reason: "dialog_detected" });
    emitter.observe({ state: "stuck", confidence: "high", reason: "no_progress" }, { noProgressMs: 31_000 });

    for (const frame of cap.frames()) {
      const payload = frame.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty("screen");
      expect(payload).not.toHaveProperty("text");
      expect(payload).not.toHaveProperty("snapshot");
      expect(payload).not.toHaveProperty("cursor");
    }
  });
});
