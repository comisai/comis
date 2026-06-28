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
// REFLECT (Phase 226 SIMPLIFY-04): the reflection funnel TELEMETRY events,
// RENAMED from learning:skill_synthesized / learning:skill_synthesis_funnel to
// reflect:admitted / reflect:funnel. Emitted DAEMON-SIDE (plain eventBus.emit)
// after runReflection returns. Counts / closed-enums (admissionOutcome) ONLY — a
// body/script/finding field is a compile error (the §2.7 / SEC-01 firewall). The
// vestigial learning:skill_validated (0-emit, sandbox deleted in 223) was removed
// in this same lockstep. Live in THIS same LearningEvents sibling.
// ---------------------------------------------------------------------------

describe("reflect:admitted / reflect:funnel telemetry (counts-only, renamed Phase 226)", () => {
  it("declares BOTH renamed keys on the LearningEvents interface (source grep — reproducible RED)", () => {
    const src = readFileSync(resolve(here, "events-learning.ts"), "utf8");
    expect(src).toContain('"reflect:admitted"');
    expect(src).toContain('"reflect:funnel"');
    // The old synthesis-funnel names + the deleted vestigial are GONE (no compat alias, I1).
    expect(src).not.toContain('"learning:skill_synthesized"');
    expect(src).not.toContain('"learning:skill_synthesis_funnel"');
    expect(src).not.toContain('"learning:skill_validated"');
  });

  it("reflect:admitted delivers agentId + count + timestamp ONLY", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["reflect:admitted"] = {
      agentId: "agent-1",
      count: 3,
      timestamp: 1,
    };
    bus.on("reflect:admitted", handler);
    bus.emit("reflect:admitted", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["reflect:admitted"];
    expect(r.count).toBe(3);
    expect(r.agentId).toBe("agent-1");
  });

  it("reflect:funnel delivers the funnel counts + the admissionOutcome closed-enum ONLY", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["reflect:funnel"] = {
      agentId: "agent-1",
      synthesized: 2,
      validated: 1,
      admitted: 1,
      maxClusterCardinality: 2,
      // OBS-1: the funnel MAGNITUDES (counts only) — answer "how many untrusted dropped / was the
      // source empty" via the bridged event instead of a daemon.log grep.
      untrustedDrops: 0,
      nameLengthRejections: 0,
      skipped: 0,
      sourceTrajectoryCount: 2,
      totalSourceChars: 480,
      admissionOutcome: "admitted",
      timestamp: 2,
    };
    bus.on("reflect:funnel", handler);
    bus.emit("reflect:funnel", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["reflect:funnel"];
    expect(r.maxClusterCardinality).toBe(2);
    expect(r.admissionOutcome).toBe("admitted");
    // OBS-1: the magnitude counts ride the content-free payload.
    expect(r.untrustedDrops).toBe(0);
    expect(r.sourceTrajectoryCount).toBe(2);
    expect(r.totalSourceChars).toBe(480);
  });

  it("OBS-1: reflect:funnel SOURCE declares the content-free magnitude counts (reproducible RED)", () => {
    const src = readFileSync(resolve(here, "events-learning.ts"), "utf8");
    // Counts only — the empty-source-vs-LLM-yield discriminator + the untrusted-drop magnitude.
    expect(src).toContain("untrustedDrops");
    expect(src).toContain("sourceTrajectoryCount");
    expect(src).toContain("totalSourceChars");
  });

  it("type safety: @ts-expect-error rejects a body/script/finding field on either telemetry payload", () => {
    const bus = new TypedEventBus();

    bus.emit("reflect:admitted", {
      agentId: "a",
      count: 1,
      timestamp: 1,
      // @ts-expect-error - a reflected doc body must NEVER ride on the counts-only payload
      body: "the reflected procedure markdown",
    });

    bus.emit("reflect:funnel", {
      agentId: "a",
      synthesized: 1,
      validated: 1,
      admitted: 1,
      maxClusterCardinality: 2,
      admissionOutcome: "admitted",
      timestamp: 1,
      // @ts-expect-error - a reflected doc body/findings must NEVER ride on the counts-only funnel payload
      body: "the reflected procedure markdown",
    });
  });

  it("type contract: both renamed keys are members of EventMap (counts/closed-enums only)", () => {
    expectTypeOf<EventMap>().toHaveProperty("reflect:admitted");
    expectTypeOf<EventMap>().toHaveProperty("reflect:funnel");
    expectTypeOf<EventMap["reflect:admitted"]["count"]>().toEqualTypeOf<number>();
    expectTypeOf<EventMap["reflect:funnel"]["maxClusterCardinality"]>().toEqualTypeOf<number>();
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

  it("learning:skill_demoted carries count + the demoted NAMES + trigger trajectory (finding C — ids only)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["learning:skill_demoted"] = {
      agentId: "agent-1",
      count: 2,
      demotedSkillNames: ["skill-a", "skill-b"],
      triggerTrajectoryId: "traj-123",
      timestamp: 2,
    };
    bus.on("learning:skill_demoted", handler);
    bus.emit("learning:skill_demoted", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["learning:skill_demoted"];
    expect(r.count).toBe(2);
    expect(r.demotedSkillNames).toEqual(["skill-a", "skill-b"]);
    expect(r.triggerTrajectoryId).toBe("traj-123");
  });

  it("learning:skill_demoted still works with count only (the names/trigger are optional)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["learning:skill_demoted"] = { agentId: "agent-1", count: 1, timestamp: 2 };
    bus.on("learning:skill_demoted", handler);
    bus.emit("learning:skill_demoted", payload);
    const r = handler.mock.calls[0]![0] as EventMap["learning:skill_demoted"];
    expect(r.count).toBe(1);
    expect(r.demotedSkillNames).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Phase 226 SIMPLIFY-04: the REVISE-01 (learning:user_model_revised) +
// GENERAL-01 (learning:memory_generalized) telemetry events were DELETED — both
// grep-confirmed 0-emit at HEAD (the user-rep revision + consolidation
// generalization paths were folded into the reflection engine in Phase 225). Their
// trajectory-bridge entries, translator cases, type members, and obs folds/verdicts
// were removed in the same lockstep change. A guard asserts they are GONE from the
// interface source (no compat alias, I1).
// ---------------------------------------------------------------------------

describe("deleted vestigial learning telemetry (Phase 226 SIMPLIFY-04)", () => {
  it("the 3 vestigial 0-emit keys are GONE from the LearningEvents interface source", () => {
    const src = readFileSync(resolve(here, "events-learning.ts"), "utf8");
    expect(src).not.toContain('"learning:skill_validated"');
    expect(src).not.toContain('"learning:user_model_revised"');
    expect(src).not.toContain('"learning:memory_generalized"');
  });
});
