// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEWED_LAUNCHER_REQUIREMENTS } from "../live/scenarios/capability-service/reviewed-launcher-requirements.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const PROVISIONER = resolve(
  REPO_ROOT,
  "test/live/scenarios/capability-service/provision-reviewed-launchers.sh",
);

describe("reviewed launcher provisioning", () => {
  it("provisions the launchers required by live scenarios", () => {
    const prefix = mkdtempSync(join(tmpdir(), "reviewed-launchers-"));
    const env = { PATH: "/usr/bin:/bin", LAUNCHER_PREFIX: prefix };
    try {
      const provision = spawnSync("/bin/bash", [PROVISIONER], { env, encoding: "utf8" });
      expect(provision.status, provision.stderr).toBe(0);

      for (const requirement of REVIEWED_LAUNCHER_REQUIREMENTS) {
        expect(dirname(requirement.path)).toBe("/usr/local/bin");
        const installed = join(prefix, basename(requirement.path));
        expect(statSync(installed).mode & 0o111).not.toBe(0);

        const probe = spawnSync(installed, ["--version"], { env, encoding: "utf8" });
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stdout.trim()).toBe(requirement.version);

        const rejected = spawnSync(installed, ["unreviewed"], { env, encoding: "utf8" });
        expect(rejected.status).toBe(2);
        expect(rejected.stderr).toContain("rejected unreviewed arguments");
      }
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
