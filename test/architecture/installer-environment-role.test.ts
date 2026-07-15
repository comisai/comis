// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");

function functionBody(name: string): string {
  const lines = installSh.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/\{\s*$/u.test(line)) depth += 1;
    if (line === "}") depth -= 1;
    if (index > start && depth === 0) return lines.slice(start, index + 1).join("\n");
  }
  return "";
}

describe("website installer daemon trust anchor", () => {
  it("installs only the role-gated daemon executable for every service layout", () => {
    expect(installSh).toContain("node_modules/@comis/daemon/dist/daemon-entrypoint.js");
    expect(installSh).toContain("packages/daemon/dist/daemon-entrypoint.js");
    expect(installSh).not.toMatch(/@comis\/daemon\/dist\/daemon\.js/u);
    expect(installSh).not.toMatch(/packages\/daemon\/dist\/daemon\.js/u);
  });

  it("creates a trusted production role without overwriting an existing test role", () => {
    const provision = functionBody("provision_environment_role_marker");

    expect(provision).not.toBe("");
    expect(provision).toContain('local role_dir="/etc/comis"');
    expect(provision).toContain('local role_marker="${role_dir}/environment-role"');
    expect(provision).toContain('"production"|"test"');
    expect(provision).toContain("0:0:644");
    expect(provision).toContain("install -m 0644 -o root -g root");
    expect(provision).toContain("printf 'production\\n'");
    expect(provision.indexOf('"production"|"test"')).toBeLessThan(
      provision.indexOf("printf 'production\\n'"),
    );
  });

  it("provisions the role before any service manager can launch the daemon", () => {
    const register = functionBody("register_service");
    const provisionIndex = register.indexOf("provision_environment_role_marker");
    const dispatchIndex = register.indexOf('case "$RESOLVED_SERVICE_MANAGER"');

    expect(provisionIndex).toBeGreaterThan(0);
    expect(dispatchIndex).toBeGreaterThan(provisionIndex);
  });
});
