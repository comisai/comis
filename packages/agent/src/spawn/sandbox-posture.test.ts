// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for the pure sandbox-posture primitive (SANDBOX-01).
 *
 * Tests the partial-order comparator (`comparePosture`) across all 4
 * config-derived confinement dimensions and the skills-config resolver
 * (`resolvePostureFromSkills`), with special emphasis on the load-bearing
 * security invariant: a missing/absent dimension resolves to the MOST-confined
 * enum BEFORE comparison, so a posture is never inferred more permissive than
 * reality (threat T-172-01).
 *
 * @module
 */

import { describe, expect, it } from "vitest";

import {
  comparePosture,
  resolvePostureFromSkills,
  type SandboxPosture,
} from "./sandbox-posture.js";

describe("comparePosture — per-dimension downgrade detection", () => {
  it("flags a downgrade on exec when parent is always-sandboxed and child is never-sandboxed", () => {
    const parent: SandboxPosture = { exec: "always" };
    const child: SandboxPosture = { exec: "never" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["exec"]);
  });

  it("flags a downgrade on filesystem when parent is workspace-confined and child has full access", () => {
    const parent: SandboxPosture = { exec: "always", filesystem: "workspace" };
    const child: SandboxPosture = { exec: "always", filesystem: "full" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["filesystem"]);
  });

  it("flags a downgrade on network when parent has none and child has full reachability", () => {
    const parent: SandboxPosture = { exec: "always", network: "none" };
    const child: SandboxPosture = { exec: "always", network: "full" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["network"]);
  });

  it("flags a downgrade on uid when parent runs as dedicated and child runs as daemon", () => {
    const parent: SandboxPosture = { exec: "always", uid: "dedicated" };
    const child: SandboxPosture = { exec: "always", uid: "daemon" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["uid"]);
  });

  it("flags a downgrade on the intermediate filesystem rank (listed-paths is looser than workspace)", () => {
    const parent: SandboxPosture = { exec: "always", filesystem: "workspace" };
    const child: SandboxPosture = { exec: "always", filesystem: "listed-paths" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["filesystem"]);
  });

  it("flags a downgrade on the intermediate network rank (listed-hosts is looser than none)", () => {
    const parent: SandboxPosture = { exec: "always", network: "none" };
    const child: SandboxPosture = { exec: "always", network: "listed-hosts" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["network"]);
  });
});

describe("comparePosture — partial order (any-dimension rule)", () => {
  it("reports a downgrade when the child is more confined on filesystem but less confined on network", () => {
    // Mixed: child tightens fs (full -> workspace) but loosens network (none -> full).
    // The any-dimension rule means a single loosened dimension is still a downgrade.
    const parent: SandboxPosture = {
      exec: "always",
      filesystem: "full",
      network: "none",
    };
    const child: SandboxPosture = {
      exec: "always",
      filesystem: "workspace",
      network: "full",
    };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["network"]);
  });

  it("collects every violated dimension when the child loosens multiple dimensions at once", () => {
    const parent: SandboxPosture = {
      exec: "always",
      filesystem: "workspace",
      network: "none",
      uid: "dedicated",
    };
    const child: SandboxPosture = {
      exec: "never",
      filesystem: "full",
      network: "full",
      uid: "daemon",
    };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual([
      "exec",
      "filesystem",
      "network",
      "uid",
    ]);
  });

  it("treats an identical posture on every dimension as not a downgrade", () => {
    const parent: SandboxPosture = {
      exec: "always",
      filesystem: "listed-paths",
      network: "listed-hosts",
      uid: "dedicated",
    };
    const child: SandboxPosture = {
      exec: "always",
      filesystem: "listed-paths",
      network: "listed-hosts",
      uid: "dedicated",
    };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(false);
    expect(result.violatedDimensions).toEqual([]);
  });

  it("treats a child that is strictly more confined on every dimension as an allowed upgrade", () => {
    const parent: SandboxPosture = {
      exec: "never",
      filesystem: "full",
      network: "full",
      uid: "daemon",
    };
    const child: SandboxPosture = {
      exec: "always",
      filesystem: "workspace",
      network: "none",
      uid: "dedicated",
    };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(false);
    expect(result.violatedDimensions).toEqual([]);
  });
});

describe("comparePosture — missing-field-safe-default (T-172-01)", () => {
  it("treats an absent child network field as the most-confined value (none) — NOT a downgrade vs a full parent", () => {
    // Parent explicitly opens network; child omits it. Absent -> none (strictest),
    // so the child is MORE confined -> allowed. This must never read absent as permissive.
    const parent: SandboxPosture = { exec: "always", network: "full" };
    const child: SandboxPosture = { exec: "always" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(false);
    expect(result.violatedDimensions).toEqual([]);
  });

  it("treats an absent parent network field as none, so an explicitly-full child IS a downgrade", () => {
    // The inverse: parent omits network (-> none, strictest); child opens it to full.
    // A config gap on the PARENT must not silently permit a looser child.
    const parent: SandboxPosture = { exec: "always" };
    const child: SandboxPosture = { exec: "always", network: "full" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["network"]);
  });

  it("treats an absent filesystem field on both sides as the strictest value (workspace) — equal, allowed", () => {
    const parent: SandboxPosture = { exec: "always" };
    const child: SandboxPosture = { exec: "always" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(false);
    expect(result.violatedDimensions).toEqual([]);
  });

  it("treats an absent uid on the parent as dedicated, so an explicit daemon child is a downgrade", () => {
    const parent: SandboxPosture = { exec: "always" };
    const child: SandboxPosture = { exec: "always", uid: "daemon" };

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(true);
    expect(result.violatedDimensions).toEqual(["uid"]);
  });
});

describe("resolvePostureFromSkills", () => {
  it("resolves exec to never when the skills config explicitly disables the exec sandbox", () => {
    const posture = resolvePostureFromSkills({ execSandbox: { enabled: "never" } });

    expect(posture.exec).toBe("never");
  });

  it("resolves exec to always when the skills config explicitly enables the exec sandbox", () => {
    const posture = resolvePostureFromSkills({ execSandbox: { enabled: "always" } });

    expect(posture.exec).toBe("always");
  });

  it("defaults exec to always (most-confined) when the execSandbox slice is absent", () => {
    const posture = resolvePostureFromSkills({});

    expect(posture.exec).toBe("always");
  });

  it("defaults exec to always (most-confined) when the entire skills slice is undefined", () => {
    const posture = resolvePostureFromSkills(undefined);

    expect(posture.exec).toBe("always");
  });

  it("leaves filesystem, network, and uid unset in the P0-C sub-agent scope (present-but-inert per A1)", () => {
    const posture = resolvePostureFromSkills({ execSandbox: { enabled: "never" } });

    expect(posture.filesystem).toBeUndefined();
    expect(posture.network).toBeUndefined();
    expect(posture.uid).toBeUndefined();
  });

  it("produces a posture that the comparator treats as most-confined on the inert dimensions", () => {
    // A resolver-produced posture (fs/net/uid absent) vs an explicitly-loose parent:
    // the absent dims fold to strictest, so only a looser exec would trip a downgrade.
    const parent: SandboxPosture = {
      exec: "always",
      filesystem: "full",
      network: "full",
      uid: "daemon",
    };
    const child = resolvePostureFromSkills({ execSandbox: { enabled: "always" } });

    const result = comparePosture(parent, child);

    expect(result.isDowngrade).toBe(false);
    expect(result.violatedDimensions).toEqual([]);
  });
});
