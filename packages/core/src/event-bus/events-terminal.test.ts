// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The typed `terminal:*` events: the state-transition + spawn-failure pair,
 * plus the richer
 * `terminal:input_needed`/`terminal:stuck`/`terminal:escalated`/
 * `terminal:auto_answered` attention+audit set declared below.
 *
 * vitest transpiles via esbuild (types stripped) and `tsc` excludes `*.test.ts`,
 * so a bare type annotation alone is not runtime-observable. These tests
 * therefore source-introspect `events-terminal.ts` + `events.ts` (the same
 * pattern `events-agent.test.ts` uses) so a declaration dropped from the source
 * or from the `EventMap` extends list fails them. The bus-emit cases
 * additionally exercise the payload shape.
 */
describe("TerminalEvents source contract", () => {
  it("events-terminal.ts declares the TerminalEvents interface with both event keys", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "TerminalEvents interface must exist").toMatch(/export interface TerminalEvents/);
    expect(src, "terminal:session_state key must exist").toMatch(/"terminal:session_state":/);
    expect(src, "terminal:spawn_failed key must exist").toMatch(/"terminal:spawn_failed":/);
  });

  it("events.ts folds TerminalEvents into the EventMap extends list", () => {
    const src = readFileSync(resolve(here, "./events.ts"), "utf8");
    // Tolerant of single-line or multi-line `extends` formatting.
    expect(src, "EventMap must extend TerminalEvents").toMatch(
      /interface EventMap\s+extends[\s\S]*?TerminalEvents/,
    );
  });
});

describe("TerminalEvents payload structure", () => {
  it("terminal:session_state delivers sessionId, agentId, state, durationMs", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:session_state"] = {
      sessionId: "sess-1",
      agentId: "agent-1",
      state: "running",
      durationMs: 12,
      timestamp: 1,
    };

    bus.on("terminal:session_state", handler);
    bus.emit("terminal:session_state", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:session_state"];
    expect(received.sessionId).toBe("sess-1");
    expect(received.agentId).toBe("agent-1");
    expect(received.state).toBe("running");
    expect(received.durationMs).toBe(12);
  });

  it("terminal:spawn_failed delivers sessionId, agentId, hint, errorKind (failure branch)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:spawn_failed"] = {
      sessionId: "sess-2",
      agentId: "agent-1",
      hint: "no sandbox provider available",
      errorKind: "permission",
      timestamp: 2,
    };

    bus.on("terminal:spawn_failed", handler);
    bus.emit("terminal:spawn_failed", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:spawn_failed"];
    expect(received.hint).toBe("no sandbox provider available");
    expect(received.errorKind).toBe("permission");
  });

  it("terminal:session_state state union accepts created | running | exited | lost", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:session_state", (p) => seen.push(p.state));
    for (const state of ["created", "running", "exited", "lost"] as const) {
      bus.emit("terminal:session_state", {
        sessionId: "s",
        agentId: "a",
        state,
        durationMs: 0,
        timestamp: 0,
      });
    }
    expect(seen).toEqual(["created", "running", "exited", "lost"]);
  });
});

// ---------------------------------------------------------------------------
// terminal:keystroke + terminal:session_evicted.
//
// These two typed bus events let the tool layer and the reaper
// `emit(...)` them: `TypedEventBus` is a CLOSED union, so an undeclared event
// fails to typecheck. The source-introspection cases below are the
// runtime-observable layer — esbuild strips bare type annotations, so a
// type-only declaration cannot be asserted at runtime.
//
// Payloads are redaction-SAFE: counts / ids / a typed reason ONLY — NEVER the
// raw keystroke text/keys, screen, or command (the REDACTED payload rides the
// structured LOG, never the bus; the file's own doc-comment forbids it). The
// keystroke event's exact safe key-set is asserted so a leak field cannot creep
// in; the eviction reason union is exactly the four EvictReason values
// (idle | max_sessions | wall_clock | max_interactions).
// ---------------------------------------------------------------------------
describe("TerminalEvents — keystroke + eviction", () => {
  it("declares terminal:keystroke + terminal:session_evicted on TerminalEvents (source-introspected)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "terminal:keystroke key must be declared").toMatch(/"terminal:keystroke":/);
    expect(src, "terminal:session_evicted key must be declared").toMatch(
      /"terminal:session_evicted":/,
    );
  });

  it("terminal:keystroke delivers sessionId/agentId/kind/redactions/byteLength — redaction-safe summary only", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:keystroke"] = {
      sessionId: "sess-3",
      agentId: "agent-1",
      kind: "text",
      redactions: 2,
      byteLength: 17,
      timestamp: 3,
    };

    bus.on("terminal:keystroke", handler);
    bus.emit("terminal:keystroke", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:keystroke"];
    expect(typeof received.sessionId).toBe("string");
    expect(typeof received.agentId).toBe("string");
    expect(["text", "key"]).toContain(received.kind);
    expect(typeof received.redactions).toBe("number");
    expect(typeof received.byteLength).toBe("number");
    expect(typeof received.timestamp).toBe("number");
  });

  it("terminal:keystroke kind union accepts text | key", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:keystroke", (p) => seen.push(p.kind));
    for (const kind of ["text", "key"] as const) {
      bus.emit("terminal:keystroke", {
        sessionId: "s",
        agentId: "a",
        kind,
        redactions: 0,
        byteLength: 0,
        timestamp: 0,
      });
    }
    expect(seen).toEqual(["text", "key"]);
  });

  it("terminal:keystroke carries ONLY the redaction-safe key-set — no text/keys/screen/payload/command", () => {
    // The exact safe key-set. Constructed from EventMap so it tracks the type;
    // Object.keys proves no raw-payload field rides the bus.
    const payload: EventMap["terminal:keystroke"] = {
      sessionId: "s",
      agentId: "a",
      kind: "text",
      redactions: 0,
      byteLength: 0,
      timestamp: 0,
    };
    expect(Object.keys(payload).sort()).toEqual([
      "agentId",
      "byteLength",
      "kind",
      "redactions",
      "sessionId",
      "timestamp",
    ]);

    // Source-block guard (the events-agent.ts counts-only pattern): the declared
    // keystroke block must NOT contain a raw text/keys/screen/payload/command
    // field.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:keystroke":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:keystroke event block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "no raw text field").not.toMatch(/^\s*text[?]?:/m);
    expect(block, "no raw keys field").not.toMatch(/^\s*keys[?]?:/m);
    expect(block, "no screen field").not.toMatch(/^\s*screen[?]?:/m);
    expect(block, "no payload field").not.toMatch(/^\s*payload[?]?:/m);
    expect(block, "no command field").not.toMatch(/^\s*command[?]?:/m);
  });

  it("terminal:session_evicted delivers sessionId/agentId/reason/durationMs — audited reason only", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:session_evicted"] = {
      sessionId: "sess-4",
      agentId: "agent-1",
      reason: "idle",
      durationMs: 60_000,
      timestamp: 4,
    };

    bus.on("terminal:session_evicted", handler);
    bus.emit("terminal:session_evicted", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:session_evicted"];
    expect(typeof received.sessionId).toBe("string");
    expect(typeof received.agentId).toBe("string");
    expect(typeof received.durationMs).toBe("number");
    expect(typeof received.timestamp).toBe("number");
  });

  it("terminal:session_evicted reason union is exactly idle | max_sessions | wall_clock | max_interactions", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:session_evicted", (p) => seen.push(p.reason));
    for (const reason of [
      "idle",
      "max_sessions",
      "wall_clock",
      "max_interactions",
    ] as const) {
      bus.emit("terminal:session_evicted", {
        sessionId: "s",
        agentId: "a",
        reason,
        durationMs: 0,
        timestamp: 0,
      });
    }
    expect(seen).toEqual(["idle", "max_sessions", "wall_clock", "max_interactions"]);

    // Source guard: the declared reason union carries exactly those four members
    // and no screen/command/text leak.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:session_evicted":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:session_evicted event block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "no screen field").not.toMatch(/^\s*screen[?]?:/m);
    expect(block, "no command field").not.toMatch(/^\s*command[?]?:/m);
    expect(block, "no text field").not.toMatch(/^\s*text[?]?:/m);
    expect(block, "reason union exactly the four EvictReason values").toMatch(
      /reason:\s*"idle"\s*\|\s*"max_sessions"\s*\|\s*"wall_clock"\s*\|\s*"max_interactions"/,
    );
  });
});

// ---------------------------------------------------------------------------
// The attention + audit set:
// terminal:input_needed + terminal:stuck + terminal:escalated +
// terminal:auto_answered.
//
// These are the four typed bus events the worker classifier,
// the wake-FSM, and the auto-answer policy need so they can
// `emit(...)` against the CLOSED `TypedEventBus` union (an undeclared event
// fails to typecheck). The source-introspection cases below are the
// runtime-observable layer — esbuild strips bare type annotations, so a
// type-only declaration cannot be asserted at runtime.
//
// Payloads are redaction-SAFE BY CONSTRUCTION: counts / ids / a typed reason /
// a typed state ONLY — NEVER the raw screen text, keystroke, or command (the
// REDACTED detail rides the structured LOG, never the bus; the file's own doc-
// comment forbids it). Each new payload block's safe key-set is asserted so a
// leak field (text/keys/screen/payload) cannot creep in. auto_answered carries
// the matched-pattern INDEX + a keystroke COUNT, never the keystroke itself
// (mirrors terminal:keystroke).
// ---------------------------------------------------------------------------
describe("TerminalEvents — attention + audit set (input_needed/stuck/escalated/auto_answered)", () => {
  it("declares input_needed + stuck + escalated + auto_answered on TerminalEvents (source-introspected)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "terminal:input_needed key must be declared").toMatch(/"terminal:input_needed":/);
    expect(src, "terminal:stuck key must be declared").toMatch(/"terminal:stuck":/);
    expect(src, "terminal:escalated key must be declared").toMatch(/"terminal:escalated":/);
    expect(src, "terminal:auto_answered key must be declared").toMatch(/"terminal:auto_answered":/);
  });

  it("the source carries no 'intentionally NOT declared' reservation comment for the attention set", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "the 'intentionally NOT declared here' reservation must be removed").not.toMatch(
      /intentionally NOT declared/,
    );
  });

  it("input_needed declares confidence; stuck declares confidence + reason (source-introspected)", () => {
    // esbuild strips bare type annotations, so source introspection is the only
    // runtime-observable way to assert the declared fields.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");

    const inputNeeded = src.match(/"terminal:input_needed":\s*\{[\s\S]*?\n\s*\};/);
    expect(inputNeeded, "terminal:input_needed block must exist").toBeTruthy();
    expect(inputNeeded![0], "input_needed declares confidence").toMatch(/confidence:/);

    const stuck = src.match(/"terminal:stuck":\s*\{[\s\S]*?\n\s*\};/);
    expect(stuck, "terminal:stuck block must exist").toBeTruthy();
    expect(stuck![0], "stuck declares confidence").toMatch(/confidence:/);
    expect(stuck![0], "stuck declares reason").toMatch(/reason:/);
  });

  it("terminal:input_needed delivers sessionId/agentId/state/reason/confidence — the attention wake signal", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:input_needed"] = {
      sessionId: "sess-5",
      agentId: "agent-1",
      state: "awaiting-input",
      reason: "settled_cursor_parked",
      confidence: "medium",
      timestamp: 5,
    };

    bus.on("terminal:input_needed", handler);
    bus.emit("terminal:input_needed", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:input_needed"];
    expect(received.sessionId).toBe("sess-5");
    expect(received.agentId).toBe("agent-1");
    expect(received.state).toBe("awaiting-input");
    expect(received.reason).toBe("settled_cursor_parked");
    // The classifier confidence rides the wake event for the autonomous policy.
    expect(received.confidence).toBe("medium");
    expect(typeof received.timestamp).toBe("number");
  });

  it("terminal:input_needed state union accepts awaiting-input | stuck", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:input_needed", (p) => seen.push(p.state));
    for (const state of ["awaiting-input", "stuck"] as const) {
      bus.emit("terminal:input_needed", {
        sessionId: "s",
        agentId: "a",
        state,
        reason: "r",
        confidence: "medium",
        timestamp: 0,
      });
    }
    expect(seen).toEqual(["awaiting-input", "stuck"]);
  });

  it("terminal:input_needed confidence union accepts high | medium", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:input_needed", (p) => seen.push(p.confidence));
    for (const confidence of ["high", "medium"] as const) {
      bus.emit("terminal:input_needed", {
        sessionId: "s",
        agentId: "a",
        state: "awaiting-input",
        reason: "r",
        confidence,
        timestamp: 0,
      });
    }
    expect(seen).toEqual(["high", "medium"]);
  });

  it("terminal:stuck delivers sessionId/agentId/noProgressMs/reason/confidence — a duration + verdict signal, not content", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:stuck"] = {
      sessionId: "sess-6",
      agentId: "agent-1",
      noProgressMs: 30_000,
      reason: "no_progress",
      confidence: "medium",
      timestamp: 6,
    };

    bus.on("terminal:stuck", handler);
    bus.emit("terminal:stuck", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:stuck"];
    expect(received.sessionId).toBe("sess-6");
    expect(received.agentId).toBe("agent-1");
    expect(received.noProgressMs).toBe(30_000);
    // stuck carries the classifier reason + confidence (observability symmetry with input_needed).
    expect(received.reason).toBe("no_progress");
    expect(received.confidence).toBe("medium");
    expect(typeof received.timestamp).toBe("number");
  });

  it("terminal:escalated delivers sessionId/agentId/reason — the escalation audit signal", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:escalated"] = {
      sessionId: "sess-7",
      agentId: "agent-1",
      reason: "destructive",
      timestamp: 7,
    };

    bus.on("terminal:escalated", handler);
    bus.emit("terminal:escalated", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:escalated"];
    expect(received.sessionId).toBe("sess-7");
    expect(received.reason).toBe("destructive");
    expect(typeof received.timestamp).toBe("number");
  });

  it("terminal:escalated reason union is exactly the seven audited escalation reasons", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:escalated", (p) => seen.push(p.reason));
    for (const reason of [
      "destructive",
      "approval",
      "auth_login",
      "loop_detected",
      "hop_limit",
      "stuck",
      "no_safe_match",
    ] as const) {
      bus.emit("terminal:escalated", {
        sessionId: "s",
        agentId: "a",
        reason,
        timestamp: 0,
      });
    }
    expect(seen).toEqual([
      "destructive",
      "approval",
      "auth_login",
      "loop_detected",
      "hop_limit",
      "stuck",
      "no_safe_match",
    ]);

    // Source guard: the declared reason union carries exactly those seven members.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:escalated":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:escalated event block must exist").toBeTruthy();
    // Tolerant of the prettier multiline union form (optional leading `|`).
    expect(match![0], "reason union exactly the seven escalation reasons").toMatch(
      /reason:\s*\|?\s*"destructive"\s*\|\s*"approval"\s*\|\s*"auth_login"\s*\|\s*"loop_detected"\s*\|\s*"hop_limit"\s*\|\s*"stuck"\s*\|\s*"no_safe_match"/,
    );
  });

  it("terminal:auto_answered delivers matchedPatternIndex + keystrokeCount — the index/count, never the keystroke", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:auto_answered"] = {
      sessionId: "sess-8",
      agentId: "agent-1",
      matchedPatternIndex: 2,
      keystrokeCount: 1,
      timestamp: 8,
    };

    bus.on("terminal:auto_answered", handler);
    bus.emit("terminal:auto_answered", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:auto_answered"];
    expect(received.matchedPatternIndex).toBe(2);
    expect(received.keystrokeCount).toBe(1);
    expect(typeof received.timestamp).toBe("number");
  });

  it("every attention/audit payload carries ONLY a redaction-safe key-set — no text/keys/screen/payload/command field", () => {
    // Object.keys proves no raw-payload field rides the bus. Each
    // payload is constructed from EventMap so the set tracks the declared type.
    const inputNeeded: EventMap["terminal:input_needed"] = {
      sessionId: "s",
      agentId: "a",
      state: "awaiting-input",
      reason: "r",
      confidence: "medium",
      timestamp: 0,
    };
    expect(Object.keys(inputNeeded).sort()).toEqual([
      "agentId",
      "confidence",
      "reason",
      "sessionId",
      "state",
      "timestamp",
    ]);

    const stuck: EventMap["terminal:stuck"] = {
      sessionId: "s",
      agentId: "a",
      noProgressMs: 0,
      reason: "no_progress",
      confidence: "medium",
      timestamp: 0,
    };
    expect(Object.keys(stuck).sort()).toEqual([
      "agentId",
      "confidence",
      "noProgressMs",
      "reason",
      "sessionId",
      "timestamp",
    ]);

    const escalated: EventMap["terminal:escalated"] = {
      sessionId: "s",
      agentId: "a",
      reason: "stuck",
      timestamp: 0,
    };
    expect(Object.keys(escalated).sort()).toEqual(["agentId", "reason", "sessionId", "timestamp"]);

    const autoAnswered: EventMap["terminal:auto_answered"] = {
      sessionId: "s",
      agentId: "a",
      matchedPatternIndex: 0,
      keystrokeCount: 0,
      timestamp: 0,
    };
    expect(Object.keys(autoAnswered).sort()).toEqual([
      "agentId",
      "keystrokeCount",
      "matchedPatternIndex",
      "sessionId",
      "timestamp",
    ]);

    // Source-block guard (the counts-only pattern): NONE of the four declared
    // blocks may contain a raw text/keys/screen/payload/command field.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    for (const key of [
      "terminal:input_needed",
      "terminal:stuck",
      "terminal:escalated",
      "terminal:auto_answered",
    ]) {
      const match = src.match(new RegExp(`"${key}":\\s*\\{[\\s\\S]*?\\n\\s*\\};`));
      expect(match, `${key} event block must exist`).toBeTruthy();
      const block = match![0];
      expect(block, `${key}: no raw text field`).not.toMatch(/^\s*text[?]?:/m);
      expect(block, `${key}: no raw keys field`).not.toMatch(/^\s*keys[?]?:/m);
      expect(block, `${key}: no screen field`).not.toMatch(/^\s*screen[?]?:/m);
      expect(block, `${key}: no payload field`).not.toMatch(/^\s*payload[?]?:/m);
      expect(block, `${key}: no command field`).not.toMatch(/^\s*command[?]?:/m);
    }
  });
});

// ---------------------------------------------------------------------------
// The autonomous-drive PROMOTION signal:
// terminal:drive_promoted.
//
// The ONE typed bus event the drive-promotion seam needs. The
// skills wait tool (Context A, the agent's LLM turn) consults the pure
// `shouldPromoteDrive` predicate on its WaitResult and, on a qualifying
// wait, emits this CONTENT-FREE event; the fd3 wake dispatcher (Context B, the
// daemon) consumes it into a closure-local promoted-Set + fires exactly ONE
// "drive started (backgrounded)" notification (promote-once). It declares the
// event on the CLOSED `TypedEventBus` union so both the emit site (skills) and
// the `.on` consumer (daemon) typecheck — an undeclared event fails to compile.
//
// CONTENT-FREE BY CONSTRUCTION: sessionId / agentId / a typed `reason` enum
// (`producing` | `mode_detached` — WHY it promoted, NEVER the screen) / timestamp
// ONLY. The screen digest that drove the wait rides the structured LOG, never the
// bus. The source-introspection layer exists because esbuild strips bare type
// annotations — a type-only declaration cannot be asserted at runtime.
// ---------------------------------------------------------------------------
describe("TerminalEvents — promotion signal (terminal:drive_promoted)", () => {
  it("declares terminal:drive_promoted on TerminalEvents (source-introspected)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "terminal:drive_promoted key must be declared").toMatch(/"terminal:drive_promoted":/);
  });

  it("the module-doc event list mentions terminal:drive_promoted", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    // The header lists every event so a transition is reconstructable from the
    // bus alone; the event must be listed there too (AGENTS.md §2.7).
    const header = src.slice(0, src.indexOf("export interface TerminalEvents"));
    expect(header, "the module-doc must mention terminal:drive_promoted").toMatch(/drive_promoted/);
  });

  it("terminal:drive_promoted delivers sessionId/agentId/reason/timestamp — the promotion signal", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:drive_promoted"] = {
      sessionId: "sess-7",
      agentId: "agent-1",
      reason: "producing",
      timestamp: 7,
    };

    bus.on("terminal:drive_promoted", handler);
    bus.emit("terminal:drive_promoted", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:drive_promoted"];
    expect(received.sessionId).toBe("sess-7");
    expect(received.agentId).toBe("agent-1");
    expect(received.reason).toBe("producing");
  });

  it("terminal:drive_promoted reason union is exactly producing | mode_detached (the WHY enum, never screen text)", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:drive_promoted", (p) => seen.push(p.reason));
    for (const reason of ["producing", "mode_detached"] as const) {
      bus.emit("terminal:drive_promoted", {
        sessionId: "s",
        agentId: "a",
        reason,
        timestamp: 1,
      });
    }
    expect(seen).toEqual(["producing", "mode_detached"]);
  });

  it("terminal:drive_promoted carries ONLY a content-free key-set — no screen/text/keystroke/payload/command field", () => {
    // Object.keys proves no raw-payload field rides the bus. The payload
    // is constructed from EventMap so the set tracks the declared type.
    const promoted: EventMap["terminal:drive_promoted"] = {
      sessionId: "s",
      agentId: "a",
      reason: "mode_detached",
      timestamp: 0,
    };
    expect(Object.keys(promoted).sort()).toEqual(["agentId", "reason", "sessionId", "timestamp"]);

    // Source-block guard (the counts/ids/enums-only pattern): the declared block
    // may NOT contain a raw screen/text/keystroke/payload/command field.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:drive_promoted":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:drive_promoted event block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "no screen field").not.toMatch(/^\s*screen[?]?:/m);
    expect(block, "no raw text field").not.toMatch(/^\s*text[?]?:/m);
    expect(block, "no raw keystroke field").not.toMatch(/^\s*keystroke[?]?:/m);
    expect(block, "no raw keys field").not.toMatch(/^\s*keys[?]?:/m);
    expect(block, "no payload field").not.toMatch(/^\s*payload[?]?:/m);
    expect(block, "no command field").not.toMatch(/^\s*command[?]?:/m);
  });
});

// ---------------------------------------------------------------------------
// The autonomous-drive RE-ATTACH signal:
// terminal:drive_reattached.
//
// The ONE typed bus event the durability seam needs. On a daemon restart the
// session registry recovers a persisted descriptor whose detached tmux server
// SURVIVED and re-attaches it as `running` (NOT `lost`) WITHOUT a second create
// frame; the daemon binds the registry's `onReattached` hook to emit this
// CONTENT-FREE event so a 40h drive's restart/re-attach is reconstructable via
// `comis explain`. It MIRRORS terminal:drive_promoted's
// shape: sessionId/agentId/a typed `reason` enum/timestamp.
//
// CRITICAL — the genuinely-gone path does NOT get a new event: it REUSES the
// EXISTING terminal:session_state(state:"lost") + a content-free unrecoverable
// reason on the structured log. There is NO `state:"failed"` member (the union is
// created|running|exited|lost); the user-facing `failed` OUTCOME is the wake
// holder's job, derived downstream. This block ALSO pins that the session_state union is UNCHANGED.
//
// CONTENT-FREE BY CONSTRUCTION: sessionId / agentId / `reason:"tmux_alive"` /
// timestamp ONLY. The source-introspection layer exists because esbuild strips
// bare type annotations — a type-only declaration cannot be asserted at runtime.
// ---------------------------------------------------------------------------
describe("TerminalEvents — re-attach signal (terminal:drive_reattached)", () => {
  it("declares terminal:drive_reattached on TerminalEvents (source-introspected)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "terminal:drive_reattached key must be declared").toMatch(/"terminal:drive_reattached":/);
  });

  it("the module-doc event list mentions terminal:drive_reattached", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const header = src.slice(0, src.indexOf("export interface TerminalEvents"));
    expect(header, "the module-doc must mention terminal:drive_reattached").toMatch(/drive_reattached/);
  });

  it("terminal:drive_reattached delivers sessionId/agentId/reason/timestamp — the re-attach signal", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["terminal:drive_reattached"] = {
      sessionId: "sess-9",
      agentId: "agent-1",
      reason: "tmux_alive",
      timestamp: 9,
    };

    bus.on("terminal:drive_reattached", handler);
    bus.emit("terminal:drive_reattached", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:drive_reattached"];
    expect(received.sessionId).toBe("sess-9");
    expect(received.agentId).toBe("agent-1");
    expect(received.reason).toBe("tmux_alive");
  });

  it("terminal:drive_reattached carries ONLY a content-free key-set — no screen/text/keystroke/payload/command field", () => {
    const reattached: EventMap["terminal:drive_reattached"] = {
      sessionId: "s",
      agentId: "a",
      reason: "tmux_alive",
      timestamp: 0,
    };
    expect(Object.keys(reattached).sort()).toEqual(["agentId", "reason", "sessionId", "timestamp"]);

    // Source-block guard (the counts/ids/enums-only pattern).
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:drive_reattached":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:drive_reattached event block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "no screen field").not.toMatch(/^\s*screen[?]?:/m);
    expect(block, "no raw text field").not.toMatch(/^\s*text[?]?:/m);
    expect(block, "no raw keystroke field").not.toMatch(/^\s*keystroke[?]?:/m);
    expect(block, "no raw keys field").not.toMatch(/^\s*keys[?]?:/m);
    expect(block, "no payload field").not.toMatch(/^\s*payload[?]?:/m);
    expect(block, "no command field").not.toMatch(/^\s*command[?]?:/m);
  });

  it("the genuinely-gone path adds NO state:'failed' — the session_state union stays created|running|exited|lost (the type-pin)", () => {
    // A genuine death emits the EXISTING state:"lost", NOT a new union member.
    // The user-facing `failed` OUTCOME is the wake holder's, derived downstream.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:session_state":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:session_state block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "the state union must NOT gain a 'failed' member").not.toMatch(/"failed"/);
    expect(block, "the state union is exactly created|running|exited|lost").toMatch(
      /state:\s*"created"\s*\|\s*"running"\s*\|\s*"exited"\s*\|\s*"lost"/,
    );

    // The closed TypedEventBus union still rejects an off-union state at the TYPE level —
    // a bare runtime emit of a valid member proves the union compiles unchanged.
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("terminal:session_state", (p) => seen.push(p.state));
    for (const state of ["created", "running", "exited", "lost"] as const) {
      bus.emit("terminal:session_state", { sessionId: "s", agentId: "a", state, durationMs: 0, timestamp: 0 });
    }
    expect(seen).toEqual(["created", "running", "exited", "lost"]);
  });
});

// ---------------------------------------------------------------------------
// The genuine-death DISCRIMINATOR on
// terminal:session_state.
//
// `state:"lost"` has TWO sources that are otherwise indistinguishable on the
// bus: a GENUINE unrecoverable death (terminal-durable-wiring.ts onUnrecoverable
// — the durable tmux is truly gone on recover-on-boot, the ONLY legitimate
// source of a user-facing `failed`) and a TRANSIENT worker-process crash that
// respawns (the supervisor's "worker will re-spawn" path, re-published via the
// fd3 hook) / a durable session that re-attaches. The wake holder must map
// `lost` → user-facing `failed` ONLY for the genuine death, so the event carries
// an optional `unrecoverable?: boolean` discriminator (set ONLY at the
// genuine-death emit) + an optional content-free `reason?: string` (a closed
// structural tag, e.g. "tmux_session_gone") so the wake holder / `comis explain`
// can name the actual cause rather than a generic "session_lost".
//
// CONTENT-FREE: `unrecoverable` is a boolean flag; `reason` is a SHORT
// structural tag (NEVER screen text / keystrokes / command output — the redacted
// detail rides the structured LOG, never the bus). The source-introspection
// layer exists because esbuild strips bare type annotations — a type-only
// declaration cannot be asserted at runtime.
// ---------------------------------------------------------------------------
describe("TerminalEvents — genuine-death discriminator (session_state unrecoverable/reason)", () => {
  it("declares the optional unrecoverable + reason fields on terminal:session_state (source-introspected)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:session_state":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:session_state block must exist").toBeTruthy();
    const block = match![0];
    // The genuine-death discriminator — an OPTIONAL boolean (absent on a transient/recoverable lost).
    expect(block, "session_state must declare an optional unrecoverable?: boolean").toMatch(/unrecoverable\?:\s*boolean/);
    // The content-free unrecoverable reason — an OPTIONAL short structural tag (string).
    expect(block, "session_state must declare an optional reason?: string").toMatch(/reason\?:\s*string/);
  });

  it("the session_state block carries NO raw screen/text/keys/payload/command field even with the discriminator (content-free)", () => {
    // The discriminator fields are a boolean flag + a closed structural tag — they must
    // NOT open a raw-bytes door. The block remains counts/ids/enums/flags only.
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    const match = src.match(/"terminal:session_state":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "terminal:session_state block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "no screen field").not.toMatch(/^\s*screen[?]?:/m);
    expect(block, "no raw text field").not.toMatch(/^\s*text[?]?:/m);
    expect(block, "no raw keys field").not.toMatch(/^\s*keys[?]?:/m);
    expect(block, "no raw keystroke field").not.toMatch(/^\s*keystroke[?]?:/m);
    expect(block, "no payload field").not.toMatch(/^\s*payload[?]?:/m);
    expect(block, "no command field").not.toMatch(/^\s*command[?]?:/m);
  });

  it("terminal:session_state carries the genuine-death discriminator on a lost emit (unrecoverable + reason round-trip)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    // A genuine unrecoverable death: the durable tmux is gone on recover-on-boot.
    const payload: EventMap["terminal:session_state"] = {
      sessionId: "sess-gone",
      agentId: "agent-1",
      state: "lost",
      unrecoverable: true,
      reason: "tmux_session_gone",
      durationMs: 0,
      timestamp: 1,
    };

    bus.on("terminal:session_state", handler);
    bus.emit("terminal:session_state", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["terminal:session_state"];
    expect(received.state).toBe("lost");
    expect(received.unrecoverable, "a genuine death carries unrecoverable:true").toBe(true);
    expect(received.reason, "the genuine death carries its content-free structural reason").toBe("tmux_session_gone");
  });

  it("terminal:session_state on a TRANSIENT/recoverable lost leaves the discriminator UNSET (a worker-crash respawn is NOT a genuine death)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    // A transient worker-crash lost (the supervisor respawns) — NO unrecoverable marker.
    const payload: EventMap["terminal:session_state"] = {
      sessionId: "sess-crash",
      agentId: "agent-1",
      state: "lost",
      durationMs: 0,
      timestamp: 2,
    };

    bus.on("terminal:session_state", handler);
    bus.emit("terminal:session_state", payload);

    const received = handler.mock.calls[0]![0] as EventMap["terminal:session_state"];
    // The absence of the discriminator is what tells the wake holder this is NOT a genuine death.
    expect(received.unrecoverable, "a transient/recoverable lost leaves unrecoverable unset").toBeUndefined();
  });
});
