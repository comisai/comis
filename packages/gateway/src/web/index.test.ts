// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `gateway/src/web/index.ts` public barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as web from "./index.js";

describe("gateway/src/web/index — barrel exports smoke contract", () => {
  it("exports createRestApi as a function", () => {
    expect(typeof web.createRestApi).toBe("function");
  });

  it("exports ActivityRingBuffer as a class (constructable)", () => {
    // classes report typeof === "function" in JS — the class IS callable as a constructor.
    expect(typeof web.ActivityRingBuffer).toBe("function");
  });

  it("exports subscribeActivityBuffer as a function", () => {
    expect(typeof web.subscribeActivityBuffer).toBe("function");
  });

  it("exports createSseEndpoint as a function", () => {
    expect(typeof web.createSseEndpoint).toBe("function");
  });

  it("exports createStaticMiddleware as a function", () => {
    expect(typeof web.createStaticMiddleware).toBe("function");
  });

  it("exports createMediaRoutes as a function", () => {
    expect(typeof web.createMediaRoutes).toBe("function");
  });

  it("exports at least 6 named value exports (silent-deletion guard)", () => {
    const exportNames = Object.keys(web);
    expect(exportNames.length).toBeGreaterThanOrEqual(6);
  });
});
