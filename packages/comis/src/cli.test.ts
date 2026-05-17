// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/cli.ts`.
 *
 * Asserts shape + identity parity with the `@comis/cli` barrel: the mirror
 * exports the same key set, the sentinel `withClient` is a function
 * (the JSON-RPC client helper), and the mirror re-export is identity-equal
 * (`===`) to the direct import. Catches `prepack.js` bundling regressions
 * and silent re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorCli from "./cli.js";
import * as directCli from "@comis/cli";

describe("comisai/cli mirror file — shape parity with @comis/cli barrel", () => {
  it("exports an identical key set as the @comis/cli direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorCli).sort();
    const directKeys = Object.keys(directCli).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes withClient as a function (sentinel JSON-RPC client typeof check)", () => {
    expect(typeof (mirrorCli as Record<string, unknown>).withClient).toBe("function");
  });

  it("preserves re-export identity: mirror.withClient === @comis/cli.withClient", () => {
    expect((mirrorCli as Record<string, unknown>).withClient).toBe(
      (directCli as Record<string, unknown>).withClient,
    );
  });
});
