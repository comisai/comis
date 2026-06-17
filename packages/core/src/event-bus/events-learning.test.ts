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
