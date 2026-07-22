// SPDX-License-Identifier: Apache-2.0
/** Prevents the retired timer, wake, and event-queue runtime from being re-exposed. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const retiredFiles = [
  "packages/daemon/src/wiring/setup-heartbeat.ts",
  "packages/scheduler/src/heartbeat/agent-heartbeat-source.ts",
  "packages/scheduler/src/heartbeat/per-agent-heartbeat-runner.ts",
  "packages/scheduler/src/heartbeat/wake-coalescer.ts",
  "packages/scheduler/src/heartbeat/wake-types.ts",
  "packages/scheduler/src/heartbeat/delivery-bridge.ts",
  "packages/scheduler/src/heartbeat/file-gate.ts",
  "packages/scheduler/src/heartbeat/resilience-tracker.ts",
  "packages/scheduler/src/system-events/system-event-queue.ts",
];

describe("retired scheduler heartbeat runtime removal", () => {
  it("removes source files whose ownership moved to the heartbeat coordinator", () => {
    expect(retiredFiles.filter((file) => existsSync(resolve(root, file)))).toEqual([]);
  });

  it("removes retired factories from scheduler public exports", () => {
    const source = [
      "packages/scheduler/src/index.ts",
      "packages/scheduler/src/heartbeat/index.ts",
      "packages/scheduler/src/system-events/index.ts",
    ].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/createPerAgentHeartbeatRunner|createWakeCoalescer|createAgentHeartbeatSource|createSystemEventQueue|deliverHeartbeatNotification/);
  });

  it("keeps daemon composition free of retired runner dependency names", () => {
    const source = [
      "packages/daemon/src/daemon.ts",
      "packages/daemon/src/daemon-types.ts",
      "packages/daemon/src/wiring/index.ts",
    ].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/perAgentRunner|wakeCoalescer|systemEventQueue|setupHeartbeat/);
  });
});
