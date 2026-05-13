// SPDX-License-Identifier: Apache-2.0
/**
 * Type-only assignability proof: `createConsoleLogger()`'s return value
 * satisfies the structural `ComisLogger` contract in
 * `core/src/logging/log-fields.ts`.
 *
 * Mirrors the Pino-side assertion in
 * `packages/infra/src/logging/__tests__/logger-contract.test.ts`: without this
 * test the structural interface could silently narrow (e.g., dropping a
 * method) and break downstream `child().info()` typing for CLI consumers
 * after Plan 35-05's retarget.
 *
 * Uses `.toExtend(...)` per the Phase 28 RES-STK-2 convention
 * (`toMatchTypeOf` is deprecated since expect-type@1.2.0).
 *
 * @module
 */
import { describe, it, expectTypeOf } from "vitest";
import { createConsoleLogger } from "./console-logger.js";
import type { ComisLogger } from "./log-fields.js";

describe("console-logger satisfies ComisLogger structural contract (WEB-CONTRACTS-04)", () => {
  it("ReturnType<typeof createConsoleLogger> extends ComisLogger", () => {
    expectTypeOf<ReturnType<typeof createConsoleLogger>>().toExtend<ComisLogger>();
  });
});
