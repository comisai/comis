// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for {@link namespacePreflight} — the boot probe that
 * PRODUCES the `namespacePreflightOk` boolean the shipped `degradeAutonomy`
 * consumes to downshift an autonomy-bearing posture to
 * `assistant` when the host cannot build the jail.
 *
 * These tests are PURE-LOGIC + CROSS-PLATFORM (they run green on macOS, where
 * the suite runs). On a non-Linux host the probe cannot create a real
 * unprivileged user namespace, so the testable contract is:
 *   1. the RESULT SHAPE (`{ namespacePreflightOk, stderr, signal }`),
 *   2. the honest non-Linux path (`namespacePreflightOk:false` + a non-empty
 *      `stderr` boot signal — operators see WHY without enabling DEBUG), and
 *   3. the DEGRADE WIRING: the result is structurally assignable to
 *      `AutonomyPreflightResult`, so feeding it into the shipped
 *      `degradeAutonomy` makes the downshift fire on `false` and is a no-op on
 *      `true`. This proves the preflight only PRODUCES the boolean — the
 *      downshift itself lives in `degradeAutonomy`, untouched.
 *
 * The REAL `bwrap --unshare-net` + userns probe assertion is a
 * `.linux.test.ts` (real-`bwrap` gated, skips on macOS). Here we test the shape
 * + the degrade seam only.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { resolveAutonomy, degradeAutonomy, type AutonomyDownshift } from "@comis/core";

import { namespacePreflight } from "./detect-provider.js";

describe("namespacePreflight — result shape", () => {
  it("returns a { namespacePreflightOk, stderr, signal } object", () => {
    const result = namespacePreflight();
    expect(result).toHaveProperty("namespacePreflightOk");
    expect(typeof result.namespacePreflightOk).toBe("boolean");
    expect(typeof result.stderr).toBe("string");
    // signal is a NodeJS.Signals string or null.
    expect(result.signal === null || typeof result.signal === "string").toBe(true);
  });
});

describe("namespacePreflight — honest non-Linux path", () => {
  it("on a non-Linux host the preflight fails with a non-empty boot-signal stderr", () => {
    // On macOS (where this runs) the jail cannot be built — the probe must be
    // honest (false) and carry a stderr so the operator sees why at boot.
    if (process.platform === "linux") {
      // On a real Linux host this case is covered by the .linux probe suite —
      // skip the platform-specific assertion here (the shape test above still
      // covers it).
      return;
    }
    const result = namespacePreflight();
    expect(result.namespacePreflightOk).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("namespacePreflight — feeds the shipped degradeAutonomy", () => {
  it("a failed (false) preflight result downshifts a standard posture to assistant + surfaces the signal", () => {
    // Structural assignability: the probe result IS an AutonomyPreflightResult.
    // Use a hand-constructed false so the assertion is platform-independent
    // (a real macOS probe also returns false, but Linux CI would not).
    const failed = { namespacePreflightOk: false };
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved, downshift } = degradeAutonomy(std, failed);

    expect(resolved.profile).toBe("assistant");
    expect(resolved.enabled).toBe(false);
    expect(resolved.capabilities.length).toBe(0);
    expect(downshift).toBeDefined();
    const signal = downshift as AutonomyDownshift;
    expect(signal.downshiftedTo).toBe("assistant");
    expect(signal.reason).toBe("namespace_preflight_failed");
  });

  it("a passed (true) preflight result is a no-op — the standard posture is untouched", () => {
    // Drive the success branch with a hand-constructed true so it runs
    // cross-platform (a real macOS probe never returns true).
    const ok = { namespacePreflightOk: true };
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved, downshift } = degradeAutonomy(std, ok);

    expect(resolved).toEqual(std);
    expect(downshift).toBeUndefined();
  });

  it("the REAL probe result is assignable to AutonomyPreflightResult (compiles + degrades)", () => {
    // The actual probe output must flow into degradeAutonomy with no adapter —
    // this is the preflight → degrade seam (the probe PRODUCES the boolean,
    // degradeAutonomy CONSUMES it).
    const probe = namespacePreflight();
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved } = degradeAutonomy(std, probe);
    // On macOS probe.namespacePreflightOk is false → downshifted; on a real
    // Linux host it may be true → untouched. Assert only the invariant that
    // holds either way: a resolved posture comes back.
    expect(resolved.profile === "assistant" || resolved.profile === "standard").toBe(true);
  });
});
