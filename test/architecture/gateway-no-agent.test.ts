// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture lock-in: gateway/{tsconfig.json, package.json} must have
 * no @comis/agent reference. Top-level enforcement for the gateway
 * transport-only invariant.
 *
 * Mirrors the per-package gateway architecture test
 * (packages/gateway/src/__tests__/architecture.test.ts) but scopes
 * specifically to the JSON config files. The per-package test walks
 * gateway/src/**\/*.ts for forbidden imports at source level; THIS test
 * grep-asserts the JSON config files so any future PR that re-adds
 * `"@comis/agent": "workspace:*"` to dependencies OR
 * `{ "path": "../agent" }` to references is caught by the architecture
 * suite before any source-level regression can land.
 *
 * Pattern mirrors test/architecture/cli-no-agent-no-infra.test.ts — same
 * defense-in-depth shape applied at the gateway boundary.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

describe("Gateway no @comis/agent in JSON configs", () => {
  it("packages/gateway/package.json declares no @comis/agent dependency", () => {
    const pkg = readFileSync(
      resolve(REPO_ROOT, "packages/gateway/package.json"),
      "utf8",
    );
    // The package's `keywords` array contains the string "agent" and the
    // dependency `@agentclientprotocol/sdk` contains the substring "agent",
    // but neither matches `@comis/agent` (the scoped workspace package).
    expect(
      pkg,
      "gateway package.json must not depend on @comis/agent — gateway is a transport-only layer",
    ).not.toMatch(/@comis\/agent/);
  });

  it("packages/gateway/tsconfig.json declares no reference to ../agent", () => {
    const ts = readFileSync(
      resolve(REPO_ROOT, "packages/gateway/tsconfig.json"),
      "utf8",
    );
    expect(
      ts,
      'gateway tsconfig must not reference "../agent" in project references — gateway is a transport-only layer',
    ).not.toMatch(/"path":\s*"\.\.\/agent"/);
    // Defense in depth: catch any other path-shape that lands on the agent package.
    expect(
      ts,
      "gateway tsconfig must not contain any @comis/agent reference",
    ).not.toMatch(/@comis\/agent/);
  });
});
