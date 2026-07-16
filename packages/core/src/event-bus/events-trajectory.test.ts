// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedEventBus } from "./bus.js";
import type { EventMap } from "./events.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("TrajectoryEvents payload structure", () => {
  it("observability:trajectory_degraded delivers only resume-failure labels and correlation ids", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["observability:trajectory_degraded"] = {
      agentId: "agent-1",
      sessionKey: "tenant:telegram:chat",
      traceId: "trace-1",
      reason: "resume_failed",
      failureKind: "invalid_jsonl",
      timestamp: 1_700_000_000_000,
    };

    bus.on("observability:trajectory_degraded", handler);
    bus.emit("observability:trajectory_degraded", payload);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
    expect(Object.keys(payload).sort()).toEqual([
      "agentId",
      "failureKind",
      "reason",
      "sessionKey",
      "timestamp",
      "traceId",
    ]);
    expectTypeOf<EventMap["observability:trajectory_degraded"]["reason"]>()
      .toEqualTypeOf<"resume_failed">();
    expectTypeOf<EventMap["observability:trajectory_degraded"]["failureKind"]>()
      .toEqualTypeOf<
        | "permission"
        | "confinement"
        | "symlink"
        | "non_regular"
        | "size_limit"
        | "invalid_jsonl"
        | "changed"
        | "io"
      >();
  });

  it("declares the trajectory resume failure as a closed EventMap contract", () => {
    const source = readFileSync(resolve(here, "events-trajectory.ts"), "utf8");
    const block = source.match(
      /"observability:trajectory_degraded":\s*\{[\s\S]*?\n {2}\};/,
    )?.[0];

    expect(block, "trajectory degradation event block must exist").toBeDefined();
    expect(block).toMatch(/reason:\s*"resume_failed"/);
    for (const failureKind of [
      "permission",
      "confinement",
      "symlink",
      "non_regular",
      "size_limit",
      "invalid_jsonl",
      "changed",
      "io",
    ]) {
      expect(block).toContain(`"${failureKind}"`);
    }
  });
});
