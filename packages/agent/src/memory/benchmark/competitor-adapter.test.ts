// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for the uniform competitor-adapter layer — the
 * `CompetitorAdapter` interface, the `AdapterResult` discriminated union, the
 * `skipWithDisclosure` helper, and the mem0/zep/hindsight/mnemosyne skip-with-
 * disclosure skeletons.
 *
 * THE LOAD-BEARING INTEGRITY INVARIANT (the reason this layer exists): an absent
 * competitor system (no keys / not installed / no sibling clone) degrades to
 * `{ ran:false, skipped:true, reason, disclosure }` — a result shape that carries
 * NO score field. It can NEVER fabricate a number. The keyless CI always hits the
 * skip branch (no env, no install) — that IS the wiring proof; the operator-costed
 * run (keys + competitor installs + LLM spend) fills the real numbers.
 *
 * THE SUPPLY-CHAIN INVARIANT (CLAUDE.md "Supply-chain invariants" + AGENTS.md):
 * mem0/zep/hindsight/mnemosyne (and any future competitor) are NEVER added to any
 * `packages/*\/package.json`. All deps are exact-pinned; `@comis/*` are
 * private:true + bundled. The skeletons import NOTHING from a competitor package —
 * they probe presence (an injectable predicate) and skip. Test 5 STATICALLY reads
 * every package manifest and asserts no competitor specifier appears.
 *
 * GLOBALS DISCIPLINE: the adapter source must contain ZERO `process.env` access
 * (globals.test.ts forbids it in packages/*\/src). The presence probe is an
 * INJECTED predicate whose default is `() => false` — the keyless default always
 * skips and never reads the environment in source. This test drives BOTH branches
 * deterministically by injecting the predicate (the env touch, if any, lives here
 * in a .test.ts, which is excluded from the globals + agent->memory rules).
 *
 * UNGATED, default-CI: pure deterministic — no clock, no provider, no key.
 * ARCHITECTURE: imports the in-package module only — no @comis/memory.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CompetitorAdapter,
  type AdapterResult,
  type AdapterConfig,
  skipWithDisclosure,
  createMem0Adapter,
  createZepAdapter,
  createHindsightAdapter,
  createMnemosyneAdapter,
} from "./competitor-adapter.js";

/** A minimal per-cell config the runner passes (tier-scoped; kept open). */
const CFG: AdapterConfig = { tier: "j1" };

/**
 * Narrow the discriminated union to the skip shape AND assert structurally that
 * the absent-path result carries NO numeric score field (the anti-fabrication
 * invariant). Returns the skip result for further assertions.
 */
function expectSkipNoScore(result: AdapterResult): Extract<AdapterResult, { ran: false }> {
  expect(result.ran).toBe(false);
  if (result.ran) {
    throw new Error("expected a skip result");
  }
  expect(result.skipped).toBe(true);
  expect(typeof result.reason).toBe("string");
  expect(result.reason.length).toBeGreaterThan(0);
  expect(typeof result.disclosure).toBe("string");
  expect(result.disclosure.length).toBeGreaterThan(0);
  // The integrity invariant: NO score field on the absent path — never a number.
  const asRecord = result as unknown as Record<string, unknown>;
  expect(asRecord.accuracy).toBeUndefined();
  expect(asRecord.overall).toBeUndefined();
  expect(asRecord.score).toBeUndefined();
  expect(asRecord.results).toBeUndefined();
  expect(asRecord.manifestRef).toBeUndefined();
  // And nothing on the skip result is a number (a costed cell would carry one).
  for (const v of Object.values(asRecord)) {
    expect(typeof v).not.toBe("number");
  }
  return result;
}

describe("competitor-adapter — the uniform interface + skip-with-disclosure", () => {
  it("Test 1 (RED): the CompetitorAdapter interface is conformable by a trivial ran:true stub", async () => {
    // A trivial in-test adapter that "ran" — proves the interface shape compiles
    // and the ran:true branch carries a manifestRef (the cell -> manifest link).
    const stub: CompetitorAdapter = {
      system: "stub",
      async run(_tier: string, _config: AdapterConfig): Promise<AdapterResult> {
        return { ran: true, system: "stub", isControl: false, manifestRef: "ref://stub" };
      },
    };
    const out = await stub.run("j1", CFG);
    expect(out.ran).toBe(true);
    if (out.ran) {
      expect(out.system).toBe("stub");
      expect(out.isControl).toBe(false);
      expect(out.manifestRef).toBe("ref://stub");
    }
  });

  it("Test 1b: skipWithDisclosure returns the skip shape (never a number)", () => {
    const out = skipWithDisclosure("mem0", "mem0 not detected", "set MEM0_API_KEY to run");
    const skip = expectSkipNoScore(out);
    expect(skip.system).toBe("mem0");
    expect(skip.reason).toContain("mem0");
    expect(skip.disclosure).toContain("MEM0_API_KEY");
  });

  it("Test 2 (RED): an absent mem0 (no key, no install) skips with disclosure naming the env + install", async () => {
    // Keyless default: isPresent defaults to () => false -> always skips.
    const adapter = createMem0Adapter();
    expect(adapter.system).toBe("mem0");
    const out = await adapter.run("j1", CFG);
    const skip = expectSkipNoScore(out);
    expect(skip.system).toBe("mem0");
    // The disclosure must name the missing prerequisite: the env var AND the install.
    expect(skip.disclosure).toMatch(/MEM0_API_KEY/);
    expect(skip.disclosure).toMatch(/mem0ai|install/i);
  });

  it("Test 3 (RED): zep / hindsight / mnemosyne skeletons each skip-with-disclosure when absent", async () => {
    const zep = createZepAdapter();
    const hindsight = createHindsightAdapter();
    const mnemosyne = createMnemosyneAdapter();

    expect(zep.system).toBe("zep");
    expect(hindsight.system).toBe("hindsight");
    expect(mnemosyne.system).toBe("mnemosyne");

    const zepSkip = expectSkipNoScore(await zep.run("j1", CFG));
    const hindsightSkip = expectSkipNoScore(await hindsight.run("j1", CFG));
    const mnemosyneSkip = expectSkipNoScore(await mnemosyne.run("j1", CFG));

    // zep disclosure names its key/account prerequisite.
    expect(zepSkip.disclosure).toMatch(/ZEP_API_KEY|getzep|zep/i);
    // hindsight / mnemosyne disclosures name the sibling-clone path.
    expect(hindsightSkip.disclosure).toMatch(/\.\.\/hindsight/);
    expect(mnemosyneSkip.disclosure).toMatch(/\.\.\/mnemosyne/);
  });

  it("Test 3b: an injected present probe still does not let a skeleton fabricate a number (no runner wired)", async () => {
    // Even when the operator's probe reports the system PRESENT, the keyless
    // skeleton has no costed runner wired in this layer, so it must NOT invent a
    // number — it discloses that the actual run is the operator-costed pass.
    const adapter = createMem0Adapter({ isPresent: () => true });
    const out = await adapter.run("j1", CFG);
    // It MUST NOT be a fabricated ran:true with a number; the skeleton has no
    // real run, so the integrity invariant still holds (no score on the result).
    const asRecord = out as unknown as Record<string, unknown>;
    expect(asRecord.accuracy).toBeUndefined();
    expect(asRecord.overall).toBeUndefined();
    expect(asRecord.score).toBeUndefined();
  });

  it("Test 4 (RED, the integrity invariant): NO skeleton EVER returns a numeric accuracy when absent", async () => {
    const adapters = [
      createMem0Adapter(),
      createZepAdapter(),
      createHindsightAdapter(),
      createMnemosyneAdapter(),
    ];
    for (const adapter of adapters) {
      const out = await adapter.run("j1", CFG);
      // The absent path is structurally a skip — assert no score field of any name.
      expectSkipNoScore(out);
    }
  });

  it("Test 5 (RED, supply-chain): no competitor specifier appears in any packages/*/package.json", () => {
    // Statically read EVERY packages/*/package.json and assert none of the
    // competitor packages is listed in dependencies or devDependencies. This is
    // the in-test enforcement of the binding supply-chain invariant (exact-pin +
    // @comis/* bundling): competitors are operator/external installs, NEVER deps.
    const here = dirname(fileURLToPath(import.meta.url));
    // packages/agent/src/memory/benchmark -> repo root is five levels up.
    const repoRoot = resolve(here, "../../../../..");
    const packagesRoot = join(repoRoot, "packages");
    const COMPETITOR_SPECIFIERS = [
      "mem0",
      "mem0ai",
      "@mem0/core",
      "@mem0/client",
      "@getzep/zep-js",
      "@getzep/zep-cloud",
      "zep",
      "zep-python",
      "hindsight",
      "mnemosyne",
    ];

    const pkgDirs = readdirSync(packagesRoot, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !e.name.startsWith("."),
    );
    expect(pkgDirs.length, "sanity: at least one package directory found").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const dir of pkgDirs) {
      const manifestPath = join(packagesRoot, dir.name, "package.json");
      let raw: string;
      try {
        raw = readFileSync(manifestPath, "utf8");
      } catch {
        continue; // no package.json in this dir
      }
      const manifest = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const allDeps: Record<string, string> = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
        ...(manifest.peerDependencies ?? {}),
        ...(manifest.optionalDependencies ?? {}),
      };
      for (const specifier of COMPETITOR_SPECIFIERS) {
        if (Object.prototype.hasOwnProperty.call(allDeps, specifier)) {
          offenders.push(`packages/${dir.name}/package.json -> ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      `A competitor package is listed as a dependency. Competitors are operator/external installs (mem0/zep external; hindsight/mnemosyne are sibling clones ../hindsight, ../mnemosyne) — NEVER a package.json dependency (supply-chain exact-pin + @comis/* bundling invariant). Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("Test 5b: the adapter source imports NOTHING from a competitor package", () => {
    // Belt-and-suspenders over Test 5: read the adapter source and assert no
    // `import ... from "<competitor>"` (the skeletons detect + skip; they never
    // import a competitor). Also asserts the agent->memory cut (no @comis/memory).
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "competitor-adapter.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'](mem0ai|@mem0\/|@getzep\/|hindsight|mnemosyne|zep)/);
    expect(src).not.toMatch(/from\s+["']@comis\/memory/);
    // SPDX header present exactly once.
    const spdxCount = (src.match(/SPDX-License-Identifier: Apache-2\.0/g) ?? []).length;
    expect(spdxCount).toBe(1);
  });
});
