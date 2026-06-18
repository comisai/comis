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

  // AUTHOR-01/02 (v2.27 P2, Phase 174): the two audit events Plans 03/04 emit on
  // repair / synthesis. The reproducible RED signal is the source-grep (the
  // type-level assertions below compile away under esbuild, so they pass GREEN on
  // pre-patch HEAD — the genuine RED comes from these source guards).
  it("declares the graph:repaired key on the OrchestrationEvents interface (AUTHOR-01)", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    expect(src).toMatch(/interface\s+OrchestrationEvents/);
    expect(src).toContain('"graph:repaired"');
  });

  it("declares the graph:synthesized_from_intent key on the OrchestrationEvents interface (AUTHOR-02)", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    expect(src).toContain('"graph:synthesized_from_intent"');
  });

  it("documents both AUTHOR events as DAEMON-emitted, counts/ids-only (§2.7)", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    // Both events name AUTHOR-01/02 and the daemon-side emit + §2.7 discipline so a
    // future reader cannot mistake them for an agent-side body-carrying signal.
    expect(src).toMatch(/AUTHOR-01/);
    expect(src).toMatch(/AUTHOR-02/);
    expect(src).toMatch(/DAEMON-SIDE/i);
  });
});

describe("graph:repaired authoring-audit event (AUTHOR-01 — counts/ids/enums only)", () => {
  // The exact allowed payload key set — closed-enums/number/string-id ONLY
  // (AGENTS.md §2.7). Driven off the RUNTIME keys of a constructed sample so a
  // future widening to a body field (graph / type_config / task) fails this test.
  const ALLOWED_KEYS = [
    "pattern",
    "nodeCount",
    "capabilityClass",
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
    "intent",
  ];

  function makeSample(
    overrides: Partial<EventMap["graph:repaired"]> = {},
  ): EventMap["graph:repaired"] {
    return {
      pattern: "debate",
      nodeCount: 3,
      capabilityClass: "small",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1,
      ...overrides,
    };
  }

  it("delivers pattern, nodeCount, capabilityClass + ids/timestamp through the typed bus", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload = makeSample();

    bus.on("graph:repaired", handler);
    bus.emit("graph:repaired", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["graph:repaired"];
    expect(received.pattern).toBe("debate");
    expect(received.nodeCount).toBe(3);
    expect(received.capabilityClass).toBe("small");
    expect(received.agentId).toBe("agent-1");
    expect(received.sessionKey).toBe("t1:u1:c1");
  });

  it("admits the closed canonical-template pattern union (research-fanout | debate | vote | map-reduce)", () => {
    const patterns: Array<EventMap["graph:repaired"]["pattern"]> = [
      "research-fanout",
      "debate",
      "vote",
      "map-reduce",
    ];
    for (const pattern of patterns) {
      expect(makeSample({ pattern }).pattern).toBe(pattern);
    }
    // A type-level compile guard — the pattern union admits exactly the four
    // canonical templates (strips away under esbuild; the runtime checks carry the
    // green proof). @ts-expect-error: "freeform" is not a canonical template.
    // @ts-expect-error - freeform is not a canonical template name
    const bad: EventMap["graph:repaired"]["pattern"] = "freeform";
    void bad;
  });

  it("admits the unknown capabilityClass fail-safe tier (record honestly, never silently drop)", () => {
    const unknownTier = makeSample({ capabilityClass: "unknown" });
    expect(unknownTier.capabilityClass).toBe("unknown");
    const tiers: Array<EventMap["graph:repaired"]["capabilityClass"]> = [
      "frontier",
      "mid",
      "small",
      "nano",
      "unknown",
    ];
    expect(tiers).toContain("unknown");
  });

  it("payload key set is EXACTLY the allowed counts/ids/enums set — no body field (§2.7 / D-EVENT no-leak)", () => {
    const keys = Object.keys(makeSample()).sort();
    expect(keys).toEqual(ALLOWED_KEYS);
  });

  it("payload carries NONE of the forbidden body keys (no graph body / type_config / task / intent)", () => {
    const keys = new Set(Object.keys(makeSample()));
    for (const forbidden of FORBIDDEN_BODY_KEYS) {
      expect(keys.has(forbidden), `forbidden body key leaked: ${forbidden}`).toBe(false);
    }
  });
});

describe("graph:synthesized_from_intent authoring-audit event (AUTHOR-02 — counts/ids/enums only)", () => {
  const ALLOWED_KEYS = ["pattern", "nodeCount", "agentId", "sessionKey", "timestamp"].sort();

  // The intent TEXT is the highest-risk leak for synthesis — it heads the forbidden set.
  const FORBIDDEN_BODY_KEYS = [
    "intent",
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
    overrides: Partial<EventMap["graph:synthesized_from_intent"]> = {},
  ): EventMap["graph:synthesized_from_intent"] {
    return {
      pattern: "research-fanout",
      nodeCount: 4,
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1,
      ...overrides,
    };
  }

  it("delivers pattern + nodeCount + ids/timestamp through the typed bus", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload = makeSample();

    bus.on("graph:synthesized_from_intent", handler);
    bus.emit("graph:synthesized_from_intent", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["graph:synthesized_from_intent"];
    expect(received.pattern).toBe("research-fanout");
    expect(received.nodeCount).toBe(4);
  });

  it("admits the closed canonical-template pattern union (research-fanout | debate | vote | map-reduce)", () => {
    const patterns: Array<EventMap["graph:synthesized_from_intent"]["pattern"]> = [
      "research-fanout",
      "debate",
      "vote",
      "map-reduce",
    ];
    for (const pattern of patterns) {
      expect(makeSample({ pattern }).pattern).toBe(pattern);
    }
    // @ts-expect-error - freeform is not a canonical template name
    const bad: EventMap["graph:synthesized_from_intent"]["pattern"] = "freeform";
    void bad;
  });

  it("payload key set is EXACTLY the allowed counts/ids/enums set — no intent text / body (§2.7 / D-EVENT no-leak)", () => {
    const keys = Object.keys(makeSample()).sort();
    expect(keys).toEqual(ALLOWED_KEYS);
  });

  it("payload carries NONE of the forbidden body keys (intent text leads the forbidden set)", () => {
    const keys = new Set(Object.keys(makeSample()));
    for (const forbidden of FORBIDDEN_BODY_KEYS) {
      expect(keys.has(forbidden), `forbidden body key leaked: ${forbidden}`).toBe(false);
    }
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

// ---------------------------------------------------------------------------
// STEER-01 (v2.27 P3, Phase 175): the subagent:steered event — emitted at the
// inject site (Plan 02, subagent-handlers.ts / sub-agent-runner.ts) when a
// running child is steered in-flight (transcript preserved) instead of
// kill+respawn. Counts/ids/typed-enum ONLY — NEVER the steer message body
// (§2.7). The reproducible-RED signal is the source-grep (the type-level
// assertions compile away under esbuild — the 173/174 precedent).
// ---------------------------------------------------------------------------

describe("subagent:steered event source (reproducible RED guards — STEER-01)", () => {
  it("declares the subagent:steered key on the OrchestrationEvents interface", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    expect(src).toMatch(/interface\s+OrchestrationEvents/);
    expect(src).toContain('"subagent:steered"');
  });

  it("the subagent:steered block declares runId/agentId/mode/timestamp and NO message-body field (counts/ids-only, §2.7)", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    // Isolate the subagent:steered declaration block (from its key to the
    // closing `};`) so the body-field guard scopes to THIS event only.
    const match = src.match(/"subagent:steered":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "subagent:steered block not found in events-orchestration.ts").not.toBeNull();
    const steeredBlock = match![0];
    // Counts/ids/typed-enum the event MUST carry.
    expect(steeredBlock).toMatch(/\brunId\b/);
    expect(steeredBlock).toMatch(/\bagentId\b/);
    expect(steeredBlock).toMatch(/\bmode\b/);
    expect(steeredBlock).toMatch(/\btimestamp\b/);
    // The §2.7 / D-EVENT no-leak guard: NO message-body field may appear in the
    // event payload block (the steer message text is excluded).
    expect(steeredBlock).not.toMatch(/\b(message|text|body|content)\b/);
  });

  it("the subagent:steered mode field is the closed union \"steer\" | \"followup\" (§2.8)", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    // The closed-union discriminator — which SDK primitive landed the inject.
    expect(src).toMatch(/mode:\s*"steer"\s*\|\s*"followup"/);
  });

  it("documents subagent:steered as DAEMON-emitted, counts/ids-only (§2.7)", () => {
    const src = readFileSync(resolve(here, "events-orchestration.ts"), "utf8");
    // The doc names STEER-01 + the counts/ids-only discipline so a future reader
    // cannot mistake it for an agent-side body-carrying signal.
    expect(src).toMatch(/STEER-01/);
  });
});
