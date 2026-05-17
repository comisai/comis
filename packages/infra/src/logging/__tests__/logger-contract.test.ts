// SPDX-License-Identifier: Apache-2.0
/**
 * Type-only assignability proof: the Pino-backed Comis logger satisfies
 * the structural ComisLogger contract in @comis/core.
 *
 * Without this test the structural interface in core could silently narrow
 * (e.g., dropping a method) and break downstream `child().info()` typing.
 *
 * The test name string preserves the prose `toMatchTypeOf`; the matcher
 * *call* inside the body uses `.toExtend(...)` (`toMatchTypeOf` is
 * deprecated since expect-type@1.2.0; expect-type@1.3.0 ships with
 * Vitest 4.1.5).
 *
 * Filename: `.test.ts` so Vitest's default include glob
 * (`src/<starstar>/<star>.test.ts`) picks the file up automatically
 * (otherwise it would only run via explicit-path invocation and miss the
 * gate).
 *
 * @module
 */

import { describe, it, expectTypeOf } from "vitest";
import type { ComisLogger as CoreComisLogger } from "@comis/core";
import type pino from "pino";

type PinoComisLogger = pino.Logger<"audit"> & { audit: pino.LogFn };

describe("logger contract — assignability", () => {
  // Test name uses prose `toMatchTypeOf` for readability; the matcher
  // inside the body uses `.toExtend` (toMatchTypeOf is deprecated).
  it("pino.Logger<'audit'> & { audit: LogFn } is assignable to core ComisLogger (expectTypeOf<PinoComisLogger>().toMatchTypeOf<ComisLogger>())", () => {
    expectTypeOf<PinoComisLogger>().toExtend<CoreComisLogger>();
  });

  it("ReturnType<ComisLogger['child']> is assignable to ComisLogger (preserves audit method on the contract type, not just at runtime)", () => {
    expectTypeOf<ReturnType<CoreComisLogger["child"]>>().toExtend<CoreComisLogger>();
  });
});
