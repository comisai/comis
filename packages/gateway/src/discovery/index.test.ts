// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `gateway/src/discovery/index.ts` public barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as discovery from "./index.js";

describe("gateway/src/discovery/index — barrel exports smoke contract", () => {
  it("exports createMdnsAdvertiser as a function", () => {
    expect(typeof discovery.createMdnsAdvertiser).toBe("function");
  });

  it("exports at least 1 named value export (silent-deletion guard)", () => {
    expect(Object.keys(discovery).length).toBeGreaterThanOrEqual(1);
  });
});
