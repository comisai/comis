// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { extractProcessSessionObservation } from "./process-session-observation.js";

describe("extractProcessSessionObservation", () => {
  it("maps an exec auto-background handoff to its running process session", () => {
    expect(extractProcessSessionObservation({
      toolName: "exec",
      resultBackgrounded: true,
      resultDetails: { status: "backgrounded", sessionId: "proc-1" },
      toolArgs: undefined,
    })).toEqual({ processSessionId: "proc-1", processSessionStatus: "running" });
  });

  it("maps process status and kill results to closed terminal states", () => {
    expect(extractProcessSessionObservation({
      toolName: "process",
      resultBackgrounded: false,
      resultDetails: { sessionId: "proc-1", status: "completed" },
      toolArgs: { action: "status", sessionId: "proc-1" },
    })).toEqual({ processSessionId: "proc-1", processSessionStatus: "completed" });
    expect(extractProcessSessionObservation({
      toolName: "process",
      resultBackgrounded: false,
      resultDetails: { killed: true },
      toolArgs: { action: "kill", sessionId: "proc-2" },
    })).toEqual({ processSessionId: "proc-2", processSessionStatus: "killed" });
  });

  it("rejects unrelated tools and unrecognized process states", () => {
    expect(extractProcessSessionObservation({
      toolName: "read",
      resultBackgrounded: false,
      resultDetails: { sessionId: "proc-1", status: "completed" },
      toolArgs: undefined,
    })).toBeUndefined();
    expect(extractProcessSessionObservation({
      toolName: "process",
      resultBackgrounded: false,
      resultDetails: { sessionId: "proc-1", status: "unknown" },
      toolArgs: undefined,
    })).toBeUndefined();
  });
});
