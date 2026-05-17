// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `gateway/src/responses/index.ts` public barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing.
 *
 * The barrel exports 4 values: 3 Zod schemas / utilities from
 * `responses-types.ts` (`ResponseRequestSchema`, `ResponseMessageSchema`,
 * `createSequenceCounter`) plus `createResponsesRoute` from
 * `responses-endpoint.ts`. Schemas are `typeof === "object"`; the counter
 * factory + route factory are `typeof === "function"`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as responses from "./index.js";

describe("gateway/src/responses/index — barrel exports smoke contract", () => {
  it("exports createResponsesRoute as a function", () => {
    expect(typeof responses.createResponsesRoute).toBe("function");
  });

  it("exports createSequenceCounter as a function", () => {
    expect(typeof responses.createSequenceCounter).toBe("function");
  });

  it("exports ResponseRequestSchema as a Zod object", () => {
    expect(typeof responses.ResponseRequestSchema).toBe("object");
    expect(responses.ResponseRequestSchema).not.toBeNull();
  });

  it("exports ResponseMessageSchema as a Zod object", () => {
    expect(typeof responses.ResponseMessageSchema).toBe("object");
    expect(responses.ResponseMessageSchema).not.toBeNull();
  });

  it("exports at least 4 named value exports (silent-deletion guard)", () => {
    expect(Object.keys(responses).length).toBeGreaterThanOrEqual(4);
  });
});
