// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Open Q2: the typed `terminal:*` transition + failure events. P0/OPS-07 needs
 * exactly two — a state-transition event and a spawn-failure event; the richer
 * `terminal:input_needed`/`terminal:stuck` set is P5 and is deliberately NOT
 * declared here (RED-first, no speculative payloads).
 *
 * vitest transpiles via esbuild (types stripped) and `tsc` excludes `*.test.ts`,
 * so a bare type annotation alone is not a runtime-observable RED. These tests
 * therefore source-introspect `events-terminal.ts` + `events.ts` (the same
 * pattern `events-agent.test.ts` uses) so they FAIL on pre-patch code: the
 * source file does not exist and `TerminalEvents` is not in the `EventMap`
 * extends list. The bus-emit cases additionally exercise the payload shape.
 */
describe("TerminalEvents source contract (Open Q2)", () => {
  it("events-terminal.ts declares the TerminalEvents interface with both event keys", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    expect(src, "TerminalEvents interface must exist").toMatch(/export interface TerminalEvents/);
    expect(src, "terminal:session_state key must exist").toMatch(/"terminal:session_state":/);
    expect(src, "terminal:spawn_failed key must exist").toMatch(/"terminal:spawn_failed":/);
  });

  it("does NOT declare the speculative P5 payloads (input_needed / stuck)", () => {
    const src = readFileSync(resolve(here, "./events-terminal.ts"), "utf8");
    // Strip comment lines, then assert no P5 keys leaked in.
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

describe("TerminalEvents payload structure (Open Q2)", () => {
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

  it("terminal:spawn_failed delivers sessionId, agentId, hint, errorKind (OPS-07 failure branch)", () => {
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
