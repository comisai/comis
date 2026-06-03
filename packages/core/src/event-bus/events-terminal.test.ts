// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The typed `terminal:*` transition + failure events. The base set needs
 * exactly two — a state-transition event and a spawn-failure event; the richer
 * `terminal:input_needed`/`terminal:stuck` set is deferred and is deliberately
 * NOT declared here (RED-first, no speculative payloads).
 *
 * vitest transpiles via esbuild (types stripped) and `tsc` excludes `*.test.ts`,
 * so a bare type annotation alone is not a runtime-observable RED. These tests
 * therefore source-introspect `events-terminal.ts` + `events.ts` (the same
 * pattern `events-agent.test.ts` uses) so they FAIL on pre-patch code: the
 * source file does not exist and `TerminalEvents` is not in the `EventMap`
 * extends list. The bus-emit cases additionally exercise the payload shape.
 */
describe("TerminalEvents source contract", () => {
  it("events-terminal.ts declares the TerminalEvents interface with both event keys", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "TerminalEvents interface must exist").toMatch(/export interface TerminalEvents/);
    expect(src, "terminal:session_state key must exist").toMatch(/"terminal:session_state":/);
    expect(src, "terminal:spawn_failed key must exist").toMatch(/"terminal:spawn_failed":/);
  });

  it("does NOT declare the speculative deferred payloads (input_needed / stuck)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    // Strip comment lines, then assert no deferred keys leaked in.
    const codeOnly = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(codeOnly).not.toMatch(/input_needed/);
    expect(codeOnly).not.toMatch(/"terminal:stuck"/);
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
// These two NET-NEW typed bus events let the tool layer and the reaper
// `emit(...)` them: `TypedEventBus` is a CLOSED union, so an undeclared event
// fails to typecheck. This block is RED on pre-patch code: `events-terminal.ts`
// declares only session_state + spawn_failed, so the source-introspection cases
// below (the genuinely-RED layer — esbuild strips bare type annotations) do not
// find the two new keys.
//
// Payloads are redaction-SAFE: counts / ids / a typed reason ONLY — NEVER the
// raw keystroke text/keys, screen, or command (the REDACTED payload rides the
// structured LOG, never the bus; the file's own doc-comment forbids it). The
// keystroke event's exact safe key-set is asserted so a leak field cannot creep
// in; the eviction reason union is exactly the four EvictReason values
// (idle | max_sessions | wall_clock | max_interactions).
// ---------------------------------------------------------------------------
describe("TerminalEvents — keystroke + eviction", () => {
  it("declares terminal:keystroke + terminal:session_evicted on TerminalEvents (source RED on pre-patch)", () => {
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
    // field. RED on pre-patch (the block does not exist yet).
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
    // and no screen/command/text leak. RED on pre-patch (block absent).
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
