// SPDX-License-Identifier: Apache-2.0
/**
 * Type-shape guard for the shared memory-cron sentinel types (the neighbor-test
 * invariant — this leaf is types-only, so the "coverage" is the compile-time
 * contract: the context exposes the stores each sentinel writes/reads through, and
 * the payload carries the onComplete callback the dispatcher resolves).
 *
 * @module
 */

import { describe, it, expectTypeOf } from "vitest";
import type { MemoryCronContext, MemoryCronPayload } from "./setup-channels-memory-crons-types.js";

describe("memory-cron sentinel shared types", () => {
  it("MemoryCronPayload carries an optional agentId + onComplete status callback", () => {
    expectTypeOf<MemoryCronPayload["agentId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<MemoryCronPayload["onComplete"]>>().parameters.toEqualTypeOf<
      [{ status: "ok" | "error"; error?: string }]
    >();
  });

  it("MemoryCronContext exposes the usefulnessStore + tripleStore write surfaces", () => {
    // The two stores the wired sentinels drive must be present on the context the
    // dispatcher passes (optional — injected from setup-memory; absent → clean error).
    expectTypeOf<MemoryCronContext>().toHaveProperty("usefulnessStore");
    expectTypeOf<MemoryCronContext>().toHaveProperty("tripleStore");
    expectTypeOf<MemoryCronContext>().toHaveProperty("memoryApi");
  });
});
