// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `gateway/src/acp/index.ts` public barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing. Phase 40 / Phase C §6.3.4 / COV-08.
 *
 * NOTE: Cohort 1 plan PATTERNS.md inventory listed 1 value export
 * (`createAcpAgent`), but the live source-of-truth exports 3 values:
 * `createAcpAgent`, `startAcpServer` (from `acp-server.ts`) plus
 * `createAcpSessionMap` (from `acp-session-map.ts`). Type-only exports
 * (`AcpServerDeps`, `AcpSessionMap`, `AcpSessionKey`) do not appear in
 * `Object.keys(acp)` at runtime and are intentionally not asserted here.
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

  it("exports at least 3 named value exports (silent-deletion guard)", () => {
    expect(Object.keys(acp).length).toBeGreaterThanOrEqual(3);
  });
});
