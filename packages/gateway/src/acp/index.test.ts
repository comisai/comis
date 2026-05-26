// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `gateway/src/acp/index.ts` public barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing (T-74-21: a deleted/shadowed bridge
 * factory would break composition-root wiring undetected).
 *
 * The live source-of-truth exports 7 value functions:
 *   - `createAcpAgent`, `startAcpServer` (from `acp-server.ts`)
 *   - `createAcpSessionMap` (from `acp-session-map.ts`)
 *   - `createAcpBoundedQueue` (from `acp-bounded-queue.ts`, ACP-02)
 *   - `createAcpActivityBridge` (from `acp-activity-bridge.ts`, ACP-02/05)
 *   - `createAcpPlanBridge` (from `acp-plan-bridge.ts`, ACP-03)
 *   - `createAcpApprovalBridge` (from `acp-approval-bridge.ts`, ACP-04)
 *
 * Non-function value exports (`DEFAULT_ACP_QUEUE_CAPACITY`) and type-only
 * exports (`AcpServerDeps`, `AcpAgentHandle`, `AcpSessionMap`, `AcpSessionKey`,
 * `AcpBoundedQueue`, `AcpBoundedQueueOptions`, `AcpActivityBridge`,
 * `CreateAcpActivityBridgeDeps`, `CreateAcpPlanBridgeDeps`, `AcpApprovalBridge`,
 * `CreateAcpApprovalBridgeDeps`) are not individually asserted here — types
 * vanish at runtime, and the `>= 7` floor is the silent-deletion guard.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as acp from "./index.js";

describe("gateway/src/acp/index — barrel exports smoke contract", () => {
  it("exports createAcpAgent as a function", () => {
    expect(typeof acp.createAcpAgent).toBe("function");
  });

  it("exports startAcpServer as a function", () => {
    expect(typeof acp.startAcpServer).toBe("function");
  });

  it("exports createAcpSessionMap as a function", () => {
    expect(typeof acp.createAcpSessionMap).toBe("function");
  });

  it("exports createAcpBoundedQueue as a function (ACP-02 local queue)", () => {
    expect(typeof acp.createAcpBoundedQueue).toBe("function");
  });

  it("exports createAcpActivityBridge as a function (ACP-02/05 activity bridge)", () => {
    expect(typeof acp.createAcpActivityBridge).toBe("function");
  });

  it("exports createAcpPlanBridge as a function (ACP-03 SEP plan bridge)", () => {
    expect(typeof acp.createAcpPlanBridge).toBe("function");
  });

  it("exports createAcpApprovalBridge as a function (ACP-04 approval bridge)", () => {
    expect(typeof acp.createAcpApprovalBridge).toBe("function");
  });

  it("exports at least 7 named value exports (silent-deletion guard)", () => {
    expect(Object.keys(acp).length).toBeGreaterThanOrEqual(7);
  });
});
