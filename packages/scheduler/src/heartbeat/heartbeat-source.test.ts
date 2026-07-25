// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  HeartbeatSourceIdSchema,
  MonitoringSourceDiagnosticSchema,
  MonitoringSourceErrorSchema,
} from "./heartbeat-source.js";

describe("monitoring heartbeat source contracts", () => {
  it("accepts bounded closed diagnostics with unique counters", () => {
    expect(MonitoringSourceDiagnosticSchema.parse({
      level: "alert",
      observedAtMs: 1,
      code: "disk_threshold",
      counters: [{ name: "used_percent", value: 91 }],
    })).toEqual({
      level: "alert",
      observedAtMs: 1,
      code: "disk_threshold",
      counters: [{ name: "used_percent", value: 91 }],
    });
  });

  it("rejects open text metadata duplicate counters and invalid source identities", () => {
    expect(MonitoringSourceDiagnosticSchema.safeParse({
      level: "ok",
      observedAtMs: 1,
      code: "healthy",
      text: "open prose",
      counters: [],
    }).success).toBe(false);
    expect(MonitoringSourceDiagnosticSchema.safeParse({
      level: "ok",
      observedAtMs: 1,
      code: "healthy",
      counters: [{ name: "count", value: 1 }, { name: "count", value: 2 }],
    }).success).toBe(false);
    expect(HeartbeatSourceIdSchema.safeParse("monitor:disk").success).toBe(false);
  });

  it("keeps adapter errors classified and code bounded", () => {
    expect(MonitoringSourceErrorSchema.parse({
      code: "stat_failed",
      errorKind: "resource",
    })).toEqual({ code: "stat_failed", errorKind: "resource" });
    expect(MonitoringSourceErrorSchema.safeParse({
      code: "bad code with prose",
      errorKind: "resource",
    }).success).toBe(false);
  });
});
