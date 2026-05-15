// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/gateway.ts`.
 *
 * Asserts shape + identity parity with the `@comis/gateway` barrel: the
 * mirror exports the same key set, the sentinel `createGatewayServer` is
 * a function, and the mirror re-export is identity-equal (`===`) to the
 * direct import. Catches `prepack.js` bundling regressions and silent
 * re-export shadowing.
 *
 * Phase 40 / Phase C §6.3.5 / COV-09.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorGateway from "./gateway.js";
import * as directGateway from "@comis/gateway";

describe("comisai/gateway mirror file — shape parity with @comis/gateway barrel", () => {
  it("exports an identical key set as the @comis/gateway direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorGateway).sort();
    const directKeys = Object.keys(directGateway).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createGatewayServer as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorGateway as Record<string, unknown>).createGatewayServer).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createGatewayServer === @comis/gateway.createGatewayServer", () => {
    expect((mirrorGateway as Record<string, unknown>).createGatewayServer).toBe(
      (directGateway as Record<string, unknown>).createGatewayServer,
    );
  });
});
