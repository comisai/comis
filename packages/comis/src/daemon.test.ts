// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/daemon.ts`.
 *
 * Asserts shape + identity parity with the `@comis/daemon` barrel: the mirror
 * exports the same key set, the sentinel `main` is a function (the daemon
 * entry point), and the mirror re-export is identity-equal (`===`) to the
 * direct import. Catches `prepack.js` bundling regressions and silent
 * re-export shadowing.
 *
 * Phase 40 / Phase C §6.3.5 / COV-09.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorDaemon from "./daemon.js";
import * as directDaemon from "@comis/daemon";

describe("comisai/daemon mirror file — shape parity with @comis/daemon barrel", () => {
  it("exports an identical key set as the @comis/daemon direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorDaemon).sort();
    const directKeys = Object.keys(directDaemon).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes main as a function (sentinel daemon entry-point typeof check)", () => {
    expect(typeof (mirrorDaemon as Record<string, unknown>).main).toBe("function");
  });

  it("preserves re-export identity: mirror.main === @comis/daemon.main", () => {
    expect((mirrorDaemon as Record<string, unknown>).main).toBe(
      (directDaemon as Record<string, unknown>).main,
    );
  });
});
