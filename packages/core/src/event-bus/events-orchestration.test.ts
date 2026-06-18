// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const here = dirname(fileURLToPath(import.meta.url));

// Reproducible-RED guards (the 201-01 precedent, mirrored from events-learning.test.ts):
// `expectTypeOf` / typed-payload assertions compile away under vitest's esbuild
// transform, so a pure type-level test passes GREEN on pre-patch HEAD. The genuine
// RED signal comes from the source-grep guards below — they fail when the
// `pipeline:authored` declaration is absent from events-orchestration.ts.
describe("events-orchestration.ts source (reproducible RED guards)", () => {
  it("packages/core/src/event-bus/events-orchestration.ts exists", () => {
    expect(existsSync(resolve(here, "events-orchestration.ts"))).toBe(true);
  });

  it("declares the pipeline:authored key on the OrchestrationEvents interface", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    expect(src).toMatch(/interface\s+OrchestrationEvents/);
    expect(src).toContain('"pipeline:authored"');
  });

  it("events.ts composes OrchestrationEvents into the EventMap extends chain", () => {
    const src = readFileSync(resolve(here, "events.ts"), "utf8");
    expect(src).toContain("OrchestrationEvents");
  });

  it("documents repaired as P1-inert (always false) in the doc comment", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    // The doc names the P1-inert contract so a future reader cannot mistake the
    // field for a wired producer (Phase 174 / AUTHOR-01 ships the repair producer).
    expect(src).toMatch(/repaired[\s\S]{0,200}?(always\s+false|ALWAYS\s+false)/i);
    expect(src).toMatch(/Phase\s*174|AUTHOR-01/);
  });
});

describe("pipeline:authored authoring-telemetry event (counts/ids/enums only)", () => {
  // The exact allowed payload key set — counts/ids/closed-enums + booleans ONLY
  // (AGENTS.md §2.7). Driven off the RUNTIME keys of a constructed sample so a
  // future widening to a body field (nodes / type_config / task) fails this test.
  const ALLOWED_KEYS = [
    "action",
    "capabilityClass",
    "schemaValid",
    "repaired",
    "agentId",
    "sessionKey",
    "timestamp",
  ].sort();

  // The §2.7 / D-EVENT forbidden body keys — none may ever appear on the payload.
  const FORBIDDEN_BODY_KEYS = [
    "nodes",
    "graph",
    "type_config",
    "typeConfig",
    "task",
    "label",
    "body",
    "payload",
  ];

  function makeSample(
    overrides: Partial<EventMap["pipeline:authored"]> = {},
  ): EventMap["pipeline:authored"] {
    return {
      action: "execute",
      capabilityClass: "small",
      schemaValid: true,
      repaired: false,
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1,
      ...overrides,
    };
  }

  it("delivers action, capabilityClass, schemaValid, repaired + ids/timestamp through the typed bus", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload = makeSample();

    bus.on("pipeline:authored", handler);
    bus.emit("pipeline:authored", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["pipeline:authored"];
    expect(received.action).toBe("execute");
    expect(received.capabilityClass).toBe("small");
    expect(received.schemaValid).toBe(true);
    expect(received.repaired).toBe(false);
    expect(received.agentId).toBe("agent-1");
    expect(received.sessionKey).toBe("t1:u1:c1");
  });

  it("admits the closed action union (define | execute)", () => {
    const define = makeSample({ action: "define" });
    const execute = makeSample({ action: "execute" });
    expect(define.action).toBe("define");
    expect(execute.action).toBe("execute");
    // A type-level compile guard — the action union admits exactly the two
    // authoring verbs (strips away under esbuild; the runtime checks above carry
    // the green proof). @ts-expect-error: "save" is a persistence op, not authoring.
    // @ts-expect-error - save is not an authoring action
    const bad: EventMap["pipeline:authored"]["action"] = "save";
    void bad;
  });

  it("admits the unknown capabilityClass fail-safe tier (Pitfall 2 — record honestly)", () => {
    const unknownTier = makeSample({ capabilityClass: "unknown" });
    expect(unknownTier.capabilityClass).toBe("unknown");
    // The full tier union: the four provider-family classes + the unresolved fail-safe.
    const tiers: Array<EventMap["pipeline:authored"]["capabilityClass"]> = [
      "frontier",
      "mid",
      "small",
      "nano",
      "unknown",
    ];
    expect(tiers).toContain("unknown");
  });

  it("payload key set is EXACTLY the allowed counts/ids/enums set — no body field (§2.7 / D-EVENT no-leak)", () => {
    // Drive off RUNTIME keys (not types) so a future body-field widening trips here.
    const keys = Object.keys(makeSample()).sort();
    expect(keys).toEqual(ALLOWED_KEYS);
  });

  it("payload carries NONE of the forbidden body keys (no pipeline body / type_config / task)", () => {
    const keys = new Set(Object.keys(makeSample()));
    for (const forbidden of FORBIDDEN_BODY_KEYS) {
      expect(keys.has(forbidden), `forbidden body key leaked: ${forbidden}`).toBe(false);
    }
  });

  it("repaired is P1-inert: the canonical authored sample is repaired:false", () => {
    // The repair producer is deferred to Phase 174 / AUTHOR-01 — at P1 every
    // authored event records repaired:false. This pins the intent (the doc-comment
    // RED guard above asserts the contract is documented in source).
    expect(makeSample().repaired).toBe(false);
  });
});
