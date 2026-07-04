// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-order SOURCE GUARD for the pre-payload wake-gate runner. Mirrors
 * `autonomy-revoke-wiring-guard.test.ts` (read a package source file, assert
 * structural facts on the text).
 *
 * Regression this guards: the per-agent scheduler is constructed BEFORE the
 * capability layer exists (the scheduler is built in one boot stage, the cap
 * layer + the runner in a later one). The wake-gate runner needs the cap
 * layer's lease manager / output guard / cap socket / bounded-autonomy, so it
 * MUST be populated AFTER `constructCapabilityLayer` and ONLY when the cap
 * endpoint actually built (`capEndpointHandle` truthy). A future refactor that
 * moves the populate before the cap layer, or drops the `capEndpointHandle`
 * guard (populating an unbuilt runner), leaves the ref pointing at a half-built
 * or absent cap layer — this turns that red at build time.
 *
 * The read-at-fire-time half of the contract (executeJob reads `ref` lazily) is
 * unit-tested in `packages/daemon/src/wiring/setup-schedulers.test.ts`; this file
 * is the durable, committed half — populated-after-cap-layer + cap-guarded.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DAEMON_TS = resolve(REPO_ROOT, "packages/daemon/src/daemon.ts");

/** Strip line + block comments so a token inside a comment cannot satisfy a
 *  wiring assertion (a comment naming createWakeGateRunner is NOT the wiring). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("wake-gate runner boot-order source guard (populated after the cap layer)", () => {
  const code = stripComments(readFileSync(DAEMON_TS, "utf8"));

  it("daemon.ts constructs the wake-gate runner (the populate exists)", () => {
    // The literal call — the runner ref is populated from the cap layer.
    expect(code).toContain("createWakeGateRunner(");
  });

  it("populates the wake-gate runner AFTER constructCapabilityLayer (its deps come from the cap layer)", () => {
    const runnerAt = code.indexOf("createWakeGateRunner(");
    const capLayerAt = code.indexOf("constructCapabilityLayer(");
    // Both must be present (constructCapabilityLayer is called during boot).
    expect(capLayerAt).toBeGreaterThan(-1);
    expect(runnerAt).toBeGreaterThan(-1);
    // The runner is built AFTER the cap layer — never before it exists.
    expect(runnerAt).toBeGreaterThan(capLayerAt);
  });

  it("guards the populate on capEndpointHandle (never populates against an unbuilt cap layer)", () => {
    // The nearest `if (...)` preceding the populate references capEndpointHandle,
    // so a future edit that populates it unconditionally (or before the cap layer
    // built) fails this build.
    expect(code).toMatch(/if \(\s*capEndpointHandle[\s\S]{0,300}?createWakeGateRunner\(/);
  });
});
