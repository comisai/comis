// SPDX-License-Identifier: Apache-2.0
/**
 * Type-only assignability proof: the Pino-backed Comis logger satisfies
 * the structural ComisLogger contract in @comis/core.
 *
 * Without this test the structural interface in core could silently narrow
 * (e.g., dropping a method) and break downstream `child().info()` typing
 * (RES-PIT-6).
 *
 * Test names below are binding contracts copied verbatim from design §5.3
 * per design §3.4. The test name string preserves the prose
 * `toMatchTypeOf` per §3.4 binding wording; the matcher *call* inside the
 * body uses `.toExtend(...)` per RES-STK-2 (`toMatchTypeOf` is
 * deprecated since expect-type@1.2.0; expect-type@1.3.0 ships with
 * Vitest 4.1.5).
 *
 * Filename note: the plan referenced `logger-contract.type-check.ts`. The
 * executor renamed to `.test.ts` so Vitest's default include glob
 * (`src/<starstar>/<star>.test.ts`) picks the file up automatically
 * (otherwise it would only run via explicit-path invocation and miss the
 * gate). The `it("…")` test names below are still verbatim from design §5.3.
 *
 * @module
 */

import { describe, it, expectTypeOf } from "vitest";
import type { ComisLogger as CoreComisLogger } from "@comis/core";
import type pino from "pino";

type PinoComisLogger = pino.Logger<"audit"> & { audit: pino.LogFn };

describe("logger contract — assignability", () => {
  // Test name verbatim from design §5.3 (uses prose `toMatchTypeOf`); the
  // matcher inside the body uses `.toExtend` per RES-STK-2.
  it("pino.Logger<'audit'> & { audit: LogFn } is assignable to core ComisLogger (expectTypeOf<PinoComisLogger>().toMatchTypeOf<ComisLogger>())", () => {
    expectTypeOf<PinoComisLogger>().toExtend<CoreComisLogger>();
  });

  it("ReturnType<ComisLogger['child']> is assignable to ComisLogger (preserves audit method on the contract type, not just at runtime)", () => {
    expectTypeOf<ReturnType<CoreComisLogger["child"]>>().toExtend<CoreComisLogger>();
  });
});
