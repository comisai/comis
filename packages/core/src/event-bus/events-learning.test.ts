// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const here = dirname(fileURLToPath(import.meta.url));

// Reproducible-RED guards (the 201-01 precedent): expectTypeOf / @ts-expect-error
// assertions compile away under vitest's esbuild transform, so they pass GREEN on
// pre-patch HEAD. Filesystem + source-grep guards genuinely fail when the new
// sibling event-decl file is absent / the key is missing.
describe("events-learning.ts source (reproducible RED guards)", () => {
  it("packages/core/src/event-bus/events-learning.ts exists", () => {
    expect(existsSync(resolve(here, "events-learning.ts"))).toBe(true);
  });

  it("declares the memory:skill_used key on a LearningEvents interface", () => {
    const src = readFileSync(resolve(here, "events-learning.ts"), "utf8");
    expect(src).toMatch(/interface\s+LearningEvents/);
    expect(src).toContain('"memory:skill_used"');
  });

  it("events.ts composes LearningEvents into the EventMap extends chain", () => {
    const src = readFileSync(resolve(here, "events.ts"), "utf8");
    expect(src).toContain("LearningEvents");
  });
});

describe("memory:skill_used skill-use attribution event (counts/ids only)", () => {
  it("delivers usedSkillIds (string[]) + usedCount + agentId/traceId/timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["memory:skill_used"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-skill-used-001",
      usedSkillIds: ["deploy", "backup"],
      usedCount: 2,
      timestamp: 1,
    };

    bus.on("memory:skill_used", handler);
    bus.emit("memory:skill_used", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["memory:skill_used"];
    expect(r.usedSkillIds).toEqual(["deploy", "backup"]);
    expect(r.usedCount).toBe(2);
    expect(r.agentId).toBe("agent-1");
    expect(r.traceId).toBe("trace-skill-used-001");

    // sessionKey is optional — non-session turns may omit it.
    const noSession: EventMap["memory:skill_used"] = {
      agentId: "agent-1",
      traceId: "trace-skill-used-002",
      usedSkillIds: [],
      usedCount: 0,
      timestamp: 2,
    };
    bus.emit("memory:skill_used", noSession);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].sessionKey).toBeUndefined();
  });

  it("type safety: @ts-expect-error rejects body/content and missing required usedCount", () => {
    const bus = new TypedEventBus();

    bus.emit("memory:skill_used", {
      agentId: "a",
      traceId: "t",
      usedSkillIds: [],
      usedCount: 0,
      timestamp: 1,
      // @ts-expect-error - skill body/procedure content must never ride on the counts+ids payload
      body: "the skill procedure markdown",
    });

    bus.emit("memory:skill_used", {
      agentId: "a",
      traceId: "t",
      usedSkillIds: [],
      usedCount: 0,
      timestamp: 1,
      // @ts-expect-error - skill content must never ride on the counts+ids payload
      content: "the skill content",
    });

    // @ts-expect-error - missing required usedCount on memory:skill_used
    bus.emit("memory:skill_used", {
      agentId: "a",
      traceId: "t",
      usedSkillIds: [],
      timestamp: 1,
    });
  });

  it("type contract: memory:skill_used is a member of EventMap (counts/ids/closed-scalars only)", () => {
    expectTypeOf<EventMap>().toHaveProperty("memory:skill_used");
    expectTypeOf<EventMap["memory:skill_used"]["usedSkillIds"]>().toEqualTypeOf<string[]>();
    expectTypeOf<EventMap["memory:skill_used"]["usedCount"]>().toEqualTypeOf<number>();
  });
});

// ---------------------------------------------------------------------------
// SKILL-09 (Plan 07): the two procedural-synthesis TELEMETRY events. Emitted
// DAEMON-SIDE (plain eventBus.emit) after runSkillSynthesis returns. Counts /
// ids / closed-enums (coverage) ONLY — a body/script/finding field is a compile
// error (the §2.7 / SEC-01 firewall). Live in THIS same LearningEvents sibling.
// ---------------------------------------------------------------------------

describe("learning:skill_synthesized / learning:skill_validated telemetry (counts-only)", () => {
  it("declares BOTH keys on the LearningEvents interface (source grep — reproducible RED)", () => {
    const src = readFileSync(resolve(here, "events-learning.ts"), "utf8");
    expect(src).toContain('"learning:skill_synthesized"');
    expect(src).toContain('"learning:skill_validated"');
  });

  it("learning:skill_synthesized delivers agentId + count + timestamp ONLY", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["learning:skill_synthesized"] = {
      agentId: "agent-1",
      count: 3,
      timestamp: 1,
    };
    bus.on("learning:skill_synthesized", handler);
    bus.emit("learning:skill_synthesized", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["learning:skill_synthesized"];
    expect(r.count).toBe(3);
    expect(r.agentId).toBe("agent-1");
  });

  it("learning:skill_validated delivers staticOk/dynamicOk + the coverage closed-enum ONLY", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["learning:skill_validated"] = {
      agentId: "agent-1",
      staticOk: true,
      dynamicOk: false,
      coverage: "static-only",
      timestamp: 2,
    };
    bus.on("learning:skill_validated", handler);
    bus.emit("learning:skill_validated", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["learning:skill_validated"];
    expect(r.staticOk).toBe(true);
    expect(r.dynamicOk).toBe(false);
    expect(r.coverage).toBe("static-only");
  });

  it("type safety: @ts-expect-error rejects a body/script/finding field on either telemetry payload", () => {
    const bus = new TypedEventBus();

    bus.emit("learning:skill_synthesized", {
      agentId: "a",
      count: 1,
      timestamp: 1,
      // @ts-expect-error - a synthesized procedure body must NEVER ride on the counts-only payload
      body: "the synthesized procedure markdown",
    });

    bus.emit("learning:skill_validated", {
      agentId: "a",
      staticOk: true,
      dynamicOk: true,
      coverage: "full",
      timestamp: 1,
      // @ts-expect-error - validation findings/scripts must NEVER ride on the counts-only payload
      scripts: ["rm -rf /"],
    });

    // @ts-expect-error - coverage is a CLOSED enum ("full" | "static-only"), not an arbitrary string
    bus.emit("learning:skill_validated", {
      agentId: "a",
      staticOk: true,
      dynamicOk: true,
      coverage: "partial",
      timestamp: 1,
    });
  });

  it("type contract: both telemetry keys are members of EventMap (counts/ids/closed-enums only)", () => {
    expectTypeOf<EventMap>().toHaveProperty("learning:skill_synthesized");
    expectTypeOf<EventMap>().toHaveProperty("learning:skill_validated");
    expectTypeOf<EventMap["learning:skill_synthesized"]["count"]>().toEqualTypeOf<number>();
    expectTypeOf<EventMap["learning:skill_validated"]["coverage"]>().toEqualTypeOf<"full" | "static-only">();
  });
});

// ---------------------------------------------------------------------------
// SURFACE-06 (Phase 202 Plan 03): the two promote/demote TELEMETRY events.
// Emitted DAEMON-SIDE (plain eventBus.emit — never `?.`) by the promote/demote
// loop (Plan 05) — counts / ids ONLY. A body / script / description / id-list
// field is a compile error (the §2.7 / SEC-01 firewall). Mirror the 201-07
// skill_synthesized counts-only + @ts-expect-error precedent exactly. Live in
// THIS same LearningEvents sibling.
// ---------------------------------------------------------------------------

describe("learning:skill_promoted / learning:skill_demoted telemetry (counts-only — SURFACE-06)", () => {
  it("declares BOTH keys on the LearningEvents interface (source grep — reproducible RED)", () => {
    const src = readFileSync(resolve(here, "events-learning.ts"), "utf8");
    expect(src).toContain('"learning:skill_promoted"');
    expect(src).toContain('"learning:skill_demoted"');
  });

  it("learning:skill_promoted delivers agentId + count + timestamp ONLY", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["learning:skill_promoted"] = {
      agentId: "agent-1",
      count: 2,
      timestamp: 1,
    };
    bus.on("learning:skill_promoted", handler);
    bus.emit("learning:skill_promoted", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["learning:skill_promoted"];
    expect(r.count).toBe(2);
    expect(r.agentId).toBe("agent-1");
  });

  it("learning:skill_demoted delivers agentId + count + timestamp ONLY", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["learning:skill_demoted"] = {
      agentId: "agent-1",
      count: 1,
      timestamp: 2,
    };
    bus.on("learning:skill_demoted", handler);
    bus.emit("learning:skill_demoted", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["learning:skill_demoted"];
    expect(r.count).toBe(1);
    expect(r.agentId).toBe("agent-1");
  });

  it("type safety: @ts-expect-error rejects a body/script/description field on either promote/demote payload", () => {
    const bus = new TypedEventBus();

    bus.emit("learning:skill_promoted", {
      agentId: "a",
      count: 1,
      timestamp: 1,
      // @ts-expect-error - a promoted procedure body must NEVER ride on the counts-only payload
      body: "the promoted procedure markdown",
    });

    bus.emit("learning:skill_demoted", {
      agentId: "a",
      count: 1,
      timestamp: 1,
      // @ts-expect-error - a demoted procedure script must NEVER ride on the counts-only payload
      scripts: ["rm -rf /"],
    });

    bus.emit("learning:skill_promoted", {
      agentId: "a",
      count: 1,
      timestamp: 1,
      // @ts-expect-error - a description/finding must NEVER ride on the counts-only payload
      description: "why these skills were promoted",
    });
  });

  it("type contract: both promote/demote keys are members of EventMap (counts/ids only)", () => {
    expectTypeOf<EventMap>().toHaveProperty("learning:skill_promoted");
    expectTypeOf<EventMap>().toHaveProperty("learning:skill_demoted");
    expectTypeOf<EventMap["learning:skill_promoted"]["count"]>().toEqualTypeOf<number>();
    expectTypeOf<EventMap["learning:skill_demoted"]["count"]>().toEqualTypeOf<number>();
  });
});
