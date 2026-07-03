// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the legible-degrade wiring in `preflight-doctor.ts`:
 *
 *   1. `buildAutonomyBootLog(agents)` — PURE: for each configured agent, build
 *      the INFO record the boot banner logs (resolved profile, enabled caps,
 *      the budget ceiling, the one field to change it = `autonomy.profile`, and
 *      the per-profile notice when present — `max`'s not-yet-available clamp +
 *      `unattended`'s mode-active notice). This
 *      is the load-bearing legible-boot evidence (promoted to INFO per CLAUDE.md;
 *      diagnosability must not require logLevel:debug).
 *   2. `buildNamespaceDownshiftFinding(preflight)` — PURE: on a FAILED
 *      namespace-preflight RESULT input, produce a `doctor` finding whose
 *      message/hint name the downshift to `assistant` + the remediation
 *      (errorKind "precondition"); `undefined` when the preflight passed. The
 *      probe that produces the boolean lives elsewhere — here it is an
 *      INPUT, keeping these helpers pure (AGENTS §2.2).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { AutonomyConfig } from "@comis/core";
import {
  buildAutonomyBootLog,
  buildNamespaceDownshiftFinding,
} from "./preflight-doctor.js";

// A minimal agents map shaped like the daemon's `agents` config (only the
// `autonomy` block is read by the boot-log builder).
function agentsWith(autonomyByAgent: Record<string, AutonomyConfig | undefined>) {
  return Object.fromEntries(
    Object.entries(autonomyByAgent).map(([id, autonomy]) => [id, { autonomy }]),
  );
}

describe("buildAutonomyBootLog (legible resolved-profile boot log)", () => {
  it("a zero-config agent logs the resolved 'standard' profile + caps + ceiling + the-one-field", () => {
    const records = buildAutonomyBootLog(agentsWith({ default: undefined }));
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.agentId).toBe("default");
    expect(rec.profile).toBe("standard");
    // The enabled caps are surfaced (the eight floor caps for standard).
    expect(rec.capabilities).toEqual(expect.arrayContaining(["orch:spawn", "orch:graph"]));
    // The budget ceiling is logged.
    expect(rec.aggregateBudgetUsd).toBeGreaterThan(0);
    // The ONE field to change it is named explicitly (the legibility contract).
    expect(rec.changeField).toBe("autonomy.profile");
  });

  it("an assistant agent logs enabled:false + zero caps", () => {
    const records = buildAutonomyBootLog(agentsWith({ a: { profile: "assistant" } as AutonomyConfig }));
    const rec = records[0]!;
    expect(rec.profile).toBe("assistant");
    expect(rec.enabled).toBe(false);
    expect(rec.capabilities).toEqual([]);
  });

  it("max carries the not-yet-available clamp notice while unattended carries the mode-active notice (both surfaced at boot, no silent over-grant)", () => {
    const records = buildAutonomyBootLog(agentsWith({
      coord: { profile: "max" } as AutonomyConfig,
      runner: { profile: "unattended" } as AutonomyConfig,
    }));
    const byId = Object.fromEntries(records.map((r) => [r.agentId, r]));
    // max's sandbox-auto-allow surface is not yet available; its notice must
    // disclose the clamp.
    expect(byId.coord!.m1Notice).toBeTruthy();
    expect(byId.coord!.m1Notice).toMatch(/not yet available/i);
    // unattended's notice describes the ACTIVE never-hang behaviors, NOT a
    // deferral — the boot banner must not mislabel it as pending work.
    expect(byId.runner!.m1Notice).toBeTruthy();
    expect(byId.runner!.m1Notice).not.toMatch(/not yet available/i);
    expect(byId.runner!.m1Notice).toMatch(/active/i);
  });

  it("a standard agent has NO m1Notice (only the clamped profiles do)", () => {
    const records = buildAutonomyBootLog(agentsWith({ default: undefined }));
    expect(records[0]!.m1Notice).toBeUndefined();
  });

  it("one record per agent, in config order", () => {
    const records = buildAutonomyBootLog(agentsWith({ one: undefined, two: { profile: "assistant" } as AutonomyConfig }));
    expect(records.map((r) => r.agentId)).toEqual(["one", "two"]);
  });
});

describe("buildNamespaceDownshiftFinding (the doctor finding)", () => {
  it("a FAILED namespace preflight produces a finding naming the downshift to assistant + remediation", () => {
    const finding = buildNamespaceDownshiftFinding({ namespacePreflightOk: false });
    expect(finding).toBeDefined();
    const f = finding!;
    // Severity is a WARN-class signal (not a fatal exit) — autonomy degrades,
    // the daemon still serves.
    expect(f.severity).toBe("warn");
    // The message names the downshift target.
    expect(f.message.toLowerCase()).toContain("assistant");
    // The hint is actionable (names a remediation) and points at the docs.
    expect(typeof f.hint).toBe("string");
    expect(f.hint.length).toBeGreaterThan(0);
    expect(f.hint.toLowerCase()).toMatch(/namespace|autonomy/);
    // errorKind is the closed-union "precondition".
    expect(f.errorKind).toBe("precondition");
  });

  it("a PASSING namespace preflight produces NO finding", () => {
    expect(buildNamespaceDownshiftFinding({ namespacePreflightOk: true })).toBeUndefined();
  });
});
