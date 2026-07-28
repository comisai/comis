// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-path guard: a SUPPORTED config must never crash-loop the daemon.
 *
 * The defect this pins (found by standing up a live rig, 2026-07-26):
 * `constructCapabilityLayer` returns `capEndpointHandle: undefined` BY DESIGN
 * when no agent has autonomy enabled. `setupProactiveSchedulers` treats that
 * handle as mandatory, and `daemon.ts` threw on the failed Result — so the daemon
 * completed its ENTIRE boot (channels registered, adapter polling) and then
 * exited 1, forever. `systemctl is-active` reported `active` the whole time while
 * the box served nothing; 13 restarts in five minutes.
 *
 * Reachability is the severity: an omitted `autonomy` block defaults to ENABLED,
 * but writing any sub-key without `enabled: true` — e.g. the documented
 * `autonomy.durability` — resolves to DISABLED. So adding one documented knob
 * bricked the daemon.
 *
 * Composition-root wiring is not reachable from a handler unit test (the handler
 * stays green while the live boot dies), so this is a source guard — the shape
 * `02-DISCIPLINE.md` prescribes for built-but-not-wired defects.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAutonomy } from "@comis/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const daemonSrc = fs.readFileSync(path.join(repoRoot, "packages/daemon/src/daemon.ts"), "utf8");

describe("autonomy-disabled is a reachable, supported config", () => {
  it("an omitted autonomy block defaults to ENABLED", () => {
    expect(resolveAutonomy(undefined).enabled).toBe(true);
  });

  it("an explicit disable resolves DISABLED", () => {
    expect(resolveAutonomy({ enabled: false } as never).enabled).toBe(false);
  });

  it("a sub-key WITHOUT `enabled: true` also resolves DISABLED (the reachability trap)", () => {
    const durabilityOnly = {
      durability: { enabled: true, orchestrateResume: true },
      profile: "assistant",
    } as never;
    expect(resolveAutonomy(durabilityOnly).enabled).toBe(false);
  });
});

describe("the daemon boots when proactive schedulers cannot be armed", () => {
  it("does NOT throw unconditionally on a failed proactive-scheduler Result", () => {
    // The regression shape: `if (!proactive.ok) { throw ... }` with no branch.
    const unconditionalThrow =
      /if \(!proactive\.ok\) \{\s*throw new Error\(`Proactive scheduler activation failed/;
    expect(daemonSrc).not.toMatch(unconditionalThrow);
  });

  it("distinguishes the SUPPORTED missing-capEndpoint case from a real wiring regression", () => {
    expect(daemonSrc).toContain("assertProactiveFailureIsSupported");
    // Any other missing dependency must still abort — a composition-root
    // regression is NOT something to boot through.
    const degrade = fs.readFileSync(path.join(repoRoot, "packages/daemon/src/wiring/proactive-degrade.ts"), "utf8");
    expect(degrade).toMatch(/isAutonomyDisabledProactiveMiss\(proactive\.error, capEndpointUnavailableReason\)[\s\S]{0,300}throw new Error/);
  });

  it("logs an ERROR naming what is off and the knob that turns it back on", () => {
    const degradeSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/wiring/proactive-degrade.ts"),
      "utf8",
    );
    expect(degradeSrc).toContain("Proactive schedulers not armed");
    expect(degradeSrc).toContain("agents.<id>.autonomy.enabled: true");
    // …and warns about the sub-key trap that makes this reachable by accident.
    expect(degradeSrc).toMatch(/autonomy\.durability/);
    // the daemon must actually EMIT it
    expect(daemonSrc).toContain("proactiveNotArmedLogFields(capEndpointUnavailableReason)");
  });

  it("treats the proactive surface as optional downstream (no undefined deref)", () => {
    expect(daemonSrc).toMatch(/\.\.\.\(proactive\.ok \? \{ proactiveSchedulers: proactive\.value \} : \{\}\)/);
  });
});
