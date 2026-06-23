// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-02 -- the never-published guard for the channel-emulation harness.
 *
 * The published "comisai" tarball is built by packages/comis/scripts/prepack.js,
 * which bundles EVERY @comis/x workspace package (the set listed in
 * packages/comis/package.json:bundledDependencies) into the tarball under
 * node_modules/@comis/. A fake channel server (a Telegram Bot-API emulator, the
 * control-plane rig, or the eventual chan/tg CLI) must NEVER cross into that
 * published graph -- it is a test-only artifact (invariant I2 / N3, CLAUDE.md
 * "Supply-chain invariants": @comis/x packages are private + bundled, nothing
 * else is published).
 *
 * This guard derives each PUBLISHED SURFACE from its single source of truth and
 * asserts the harness is ABSENT from it, across four independent dimensions:
 *
 *   1. No workspace package      -- pnpm-workspace.yaml is packages-star only;
 *                                  no package.json lives under test/live
 *                                  (a new workspace member would make the harness
 *                                  publishable).
 *   2. No @comis/x bundled edge  -- bundledDependencies names only real
 *                                  packages/NAME dirs; it names no harness;
 *                                  packages has no harness dir.
 *   3. No chan/tg CLI command    -- packages/cli/src/cli.ts registers no
 *                                  chan/tg subcommand and no chan.ts/tg.ts
 *                                  command module exists (the existing channel
 *                                  product command is allowed).
 *   4. Consumer-only arrow       -- the dependency arrow points test to packages
 *                                  only: no packages package.json depends on a
 *                                  harness path/name, and no packages src source
 *                                  imports from test/live.
 *
 * NON-TAUTOLOGICAL by construction: each dimension reads an INDEPENDENTLY-VARYING
 * source (the workspace globs, bundledDependencies, the CLI registry, the
 * per-package deps + source imports) and asserts the harness is absent -- never
 * bundled-equals-bundled (umbrella-bundling.test.ts's lesson). The guard FAILS
 * the moment someone (a) drops a package.json under test/live, (b) adds a harness
 * name to bundledDependencies or a harness dir under packages, (c) registers a
 * chan/tg comis subcommand, or (d) makes a published package depend on / import
 * the harness.
 *
 * FORWARD-PROTECTIVE: it asserts about the PUBLISHED surface, which is unaffected
 * by whether the harness files (Plans 01-05) exist yet -- so it is green on the
 * current tree and stays green as those test/live files land.
 *
 * Runs under the architecture vitest project (test/architecture/vitest.config.ts)
 * -- pure filesystem + string assertions, no daemon, no build needed. Part of
 * "pnpm test:architecture" / "pnpm validate".
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * The harness lives entirely under `test/live/`. These are the directories that
 * hold the channel-emulation harness (Plans 01-05) + the CLI names it would carry
 * (Phase 205). The guard asserts none of these ever intersects the published
 * surface — derived independently below from `pnpm-workspace.yaml`,
 * `bundledDependencies`, the CLI registry, and per-package deps/imports.
 */
const HARNESS_DIRS = [
  "test/live/harness",
  "test/live/emulators",
  "test/live/scenarios",
] as const;

/** CLI subcommand names the harness would register (Phase 205) — never on `comis`. */
const HARNESS_CLI_NAMES = ["chan", "tg"] as const;

/** Path fragments / package names that betray a harness edge into a published package. */
const HARNESS_REFERENCE_FRAGMENTS = ["test/live", "tg-emulator", "channel-emulator"] as const;

// --- helpers (filesystem-assertion idiom, mirrors umbrella-bundling.test.ts) ---

function readUmbrellaPackageJson(): { bundledDependencies?: string[] } {
  const path = resolve(REPO_ROOT, "packages/comis/package.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Recursively collect every file path (repo-relative, POSIX-ish) under a dir. */
function walkFiles(absDir: string): string[] {
  if (!existsSync(absDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      // Skip nested node_modules / build output — never a workspace candidate.
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walkFiles(abs));
    } else {
      out.push(relative(REPO_ROOT, abs).split(sep).join("/"));
    }
  }
  return out;
}

/** Directory names directly under `packages/` that contain a package.json. */
function readPackagesDirectories(): string[] {
  const packagesDir = resolve(REPO_ROOT, "packages");
  return readdirSync(packagesDir)
    .filter((name) => {
      const st = statSync(join(packagesDir, name));
      if (!st.isDirectory()) return false;
      return existsSync(join(packagesDir, name, "package.json"));
    })
    .sort();
}

describe("harness-never-published — SEC-02 supply-chain boundary (4 dimensions)", () => {
  // ── Dimension 1 — no workspace package ────────────────────────────────────
  // `pnpm-workspace.yaml` enumerates the workspace globs. The harness must not
  // become a workspace member: the globs must stay `packages/*`-scoped (never a
  // `test/**` glob) AND no `package.json` may appear under any harness dir (a
  // package.json under test/live/** + a workspace glob is exactly what would
  // make a fake server publishable).
  it("Dimension 1: harness is not a pnpm-workspace member (packages/* only, no package.json under test/live/**)", () => {
    const workspaceYaml = readFileSync(
      resolve(REPO_ROOT, "pnpm-workspace.yaml"),
      "utf8",
    );

    // (a) No workspace glob references `test/` — extract the `packages:` list
    // entries and assert none points into the test tree.
    const globLines = workspaceYaml
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^- /, "").replace(/^["']|["']$/g, ""));
    // Only the `packages:` section entries are globs here; entries like
    // onlyBuiltDependencies values are package names (no `/`). A `test`-rooted
    // glob is the regression we forbid.
    const testGlobs = globLines.filter(
      (g) => g.includes("/") && (g.startsWith("test/") || g.startsWith("./test/")),
    );

    // (b) No package.json under any harness dir.
    const stray: string[] = [];
    for (const dir of HARNESS_DIRS) {
      for (const f of walkFiles(resolve(REPO_ROOT, dir))) {
        if (f.endsWith("/package.json") || f === `${dir}/package.json`) {
          stray.push(f);
        }
      }
    }

    expect(
      { testGlobs, stray },
      formatViolations({
        description:
          "SEC-02 Dimension 1: the harness must NOT be a pnpm workspace member. The workspace globs stay packages/*-scoped and no package.json may exist under test/live/** — either would make a fake channel server publishable.",
        violations: [
          ...testGlobs.map((g) => ({
            file: "pnpm-workspace.yaml",
            line: 0,
            snippet: `forbidden test-rooted workspace glob: ${g}`,
          })),
          ...stray.map((f) => ({
            file: f,
            line: 0,
            snippet: "package.json under test/live/** turns the harness into a workspace package",
          })),
        ],
        suggestedFix:
          "Keep pnpm-workspace.yaml at `packages/*` only and delete any package.json under test/live/**. The harness is a test consumer, never a workspace member.",
        designRef: "SEC-02 / CLAUDE.md supply-chain invariants (I2/N3)",
      }),
    ).toEqual({ testGlobs: [], stray: [] });
  });

  // ── Dimension 2 — no @comis/* bundled edge ────────────────────────────────
  // `bundledDependencies` is the set prepack.js bundles into the tarball. It
  // must name ONLY real `packages/<name>/` workspace dirs (so a harness made
  // into a `packages/` package + bundled would be caught), it must name no
  // harness, and the `packages/` tree must contain no harness dir.
  it("Dimension 2: harness has no @comis/* bundled edge (bundledDependencies → real packages only, no harness)", () => {
    const pkg = readUmbrellaPackageJson();
    const bundled = pkg.bundledDependencies ?? [];
    const bundledComis = bundled
      .filter((s): s is string => typeof s === "string" && s.startsWith("@comis/"))
      .map((s) => s.replace(/^@comis\//, ""));

    const packagesDirs = new Set(readPackagesDirectories());

    // (a) Every bundled @comis/* entry maps to a real packages/<name>/ dir.
    // A harness smuggled in as `@comis/<harness>` would either lack a dir
    // (caught here) or appear as a harness-named dir (caught in (c)).
    const bundledWithoutDir = bundledComis.filter((name) => !packagesDirs.has(name));

    // (b) No bundled entry is a harness path/name.
    const bundledHarness = bundled.filter(
      (s): s is string =>
        typeof s === "string" &&
        HARNESS_REFERENCE_FRAGMENTS.some((frag) => s.includes(frag)),
    );

    // (c) No packages/<dir> looks like a harness/emulator package.
    const harnessPackageDirs = [...packagesDirs].filter((d) =>
      /(^|[-_])(harness|emulator|emulators|tg|chan)([-_]|$)/.test(d),
    );

    expect(
      { bundledWithoutDir, bundledHarness, harnessPackageDirs },
      formatViolations({
        description:
          "SEC-02 Dimension 2: the harness must add NO @comis/* edge to the published tarball. bundledDependencies must name only real packages/<name>/ workspace dirs and never a harness; no harness/emulator dir may appear under packages/.",
        violations: [
          ...bundledWithoutDir.map((n) => ({
            file: "packages/comis/package.json",
            line: 0,
            snippet: `bundled @comis/${n} has no packages/${n}/ dir — a smuggled non-workspace bundle`,
          })),
          ...bundledHarness.map((n) => ({
            file: "packages/comis/package.json",
            line: 0,
            snippet: `harness reference in bundledDependencies: ${n}`,
          })),
          ...harnessPackageDirs.map((d) => ({
            file: `packages/${d}/`,
            line: 0,
            snippet: "harness/emulator package under packages/ would be bundled into the tarball",
          })),
        ],
        suggestedFix:
          "Keep the harness under test/live/** (outside prepack.js's bundling scope). Never add it to bundledDependencies and never create a packages/<harness>/ dir.",
        designRef: "SEC-02 / prepack.js bundles every @comis/* (CLAUDE.md supply-chain invariants)",
      }),
    ).toEqual({ bundledWithoutDir: [], bundledHarness: [], harnessPackageDirs: [] });
  });

  // ── Dimension 3 — chan/tg is NOT a comis CLI subcommand ───────────────────
  // The `comis` CLI registers subcommands in packages/cli/src/cli.ts via
  // `register<Name>Command(program)` and the modules under
  // packages/cli/src/commands/. The harness CLI (`chan`/`tg`, Phase 205) lives
  // under test/live/bin/ and must NEVER be a comis subcommand. Word-boundary
  // matching so the existing `channel` product command (which contains "chan")
  // is NOT a false positive.
  it("Dimension 3: chan/tg is not a comis CLI subcommand (no command module, no registration)", () => {
    const cliSrc = resolve(REPO_ROOT, "packages/cli/src");

    // (a) No chan.ts / tg.ts command module (channel.ts is the allowed product command).
    const commandFiles = readdirSync(resolve(cliSrc, "commands")).filter((f) =>
      f.endsWith(".ts"),
    );
    const harnessCommandFiles = commandFiles.filter((f) => {
      const base = f.replace(/\.ts$/, "");
      return (HARNESS_CLI_NAMES as readonly string[]).includes(base);
    });

    // (b) No `.command("chan"|"tg")` and no `register{Chan,Tg}Command` in cli.ts.
    const cliEntry = readFileSync(resolve(cliSrc, "cli.ts"), "utf8");
    const registrationHits: string[] = [];
    for (const name of HARNESS_CLI_NAMES) {
      // commander `.command("chan")` / `.command("tg ...")` — quote then name then word boundary.
      const cmdRe = new RegExp(`\\.command\\(\\s*["'\`]${name}(?:[\\s"'\`])`, "g");
      // `registerChanCommand` / `registerTgCommand` import or call.
      const cap = name.charAt(0).toUpperCase() + name.slice(1);
      const regRe = new RegExp(`register${cap}Command\\b`, "g");
      if (cmdRe.test(cliEntry)) registrationHits.push(`.command("${name}") in cli.ts`);
      if (regRe.test(cliEntry)) registrationHits.push(`register${cap}Command in cli.ts`);
    }

    expect(
      { harnessCommandFiles, registrationHits },
      formatViolations({
        description:
          "SEC-02 Dimension 3: chan/tg must NOT be a comis CLI subcommand. The harness CLI lives under test/live/bin/ (Phase 205), never in packages/cli. (The existing `channel` product command is allowed.)",
        violations: [
          ...harnessCommandFiles.map((f) => ({
            file: `packages/cli/src/commands/${f}`,
            line: 0,
            snippet: "harness CLI command module inside the published cli package",
          })),
          ...registrationHits.map((h) => ({
            file: "packages/cli/src/cli.ts",
            line: 0,
            snippet: `harness subcommand registered on the comis program: ${h}`,
          })),
        ],
        suggestedFix:
          "Keep the chan/tg harness CLI under test/live/bin/ as a standalone tsx entrypoint. Never add a chan.ts/tg.ts under packages/cli/src/commands or register it in cli.ts.",
        designRef: "SEC-02 / harness CLI is test-only (Phase 205, test/live/bin)",
      }),
    ).toEqual({ harnessCommandFiles: [], registrationHits: [] });
  });

  // ── Dimension 4 — harness is a consumer, not a member ─────────────────────
  // The dependency arrow points test → packages ONLY. No published package may
  // depend on a harness path/name, and no packages/*/src/** source may import
  // from test/live (which would drag the harness into the published graph).
  it("Dimension 4: harness is consumer-only (no packages/* dep on it, no packages/*/src import of test/live)", () => {
    const packagesDir = resolve(REPO_ROOT, "packages");
    const depViolations: string[] = [];
    const importViolations: string[] = [];

    for (const name of readPackagesDirectories()) {
      // (a) package.json must not declare a dependency on a harness path/name.
      const pjPath = resolve(packagesDir, name, "package.json");
      const pj = JSON.parse(readFileSync(pjPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...(pj.dependencies ?? {}),
        ...(pj.devDependencies ?? {}),
        ...(pj.optionalDependencies ?? {}),
        ...(pj.peerDependencies ?? {}),
      };
      for (const [dep, spec] of Object.entries(allDeps)) {
        if (
          HARNESS_REFERENCE_FRAGMENTS.some(
            (frag) => dep.includes(frag) || (typeof spec === "string" && spec.includes(frag)),
          )
        ) {
          depViolations.push(`packages/${name}/package.json → ${dep}: ${spec}`);
        }
      }

      // (b) No PUBLISHED source file under packages/<name>/src/** imports from
      // test/live. Test files (*.test.ts, *.spec.ts, __tests__/**) are stripped
      // from the published dist/ tarball, so a test importing a test/live fixture
      // adds NO published-graph edge — only non-test source counts here.
      const srcDir = resolve(packagesDir, name, "src");
      for (const file of walkFiles(srcDir)) {
        if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
        if (
          file.endsWith(".test.ts") ||
          file.endsWith(".test.tsx") ||
          file.endsWith(".spec.ts") ||
          file.endsWith(".spec.tsx") ||
          file.includes("/__tests__/")
        ) {
          continue;
        }
        const content = readFileSync(resolve(REPO_ROOT, file), "utf8");
        // from "…/test/live/…" or import("…/test/live/…")
        if (/from\s+["'`][^"'`]*\btest\/live\//.test(content) ||
            /import\(\s*["'`][^"'`]*\btest\/live\//.test(content)) {
          importViolations.push(file);
        }
      }
    }

    expect(
      { depViolations, importViolations },
      formatViolations({
        description:
          "SEC-02 Dimension 4: the harness is a CONSUMER of @comis/* (it lives under test/ and imports the dist alias), never a member. No published package may depend on it and no packages/*/src/** may import from test/live — the dependency arrow points test → packages only.",
        violations: [
          ...depViolations.map((v) => ({
            file: "packages/*/package.json",
            line: 0,
            snippet: `published package depends on the harness: ${v}`,
          })),
          ...importViolations.map((f) => ({
            file: f,
            line: 0,
            snippet: "packages/*/src import of test/live drags the harness into the published graph",
          })),
        ],
        suggestedFix:
          "The harness imports @comis/* from dist via the test alias (test/live/vitest.config.ts). Never make a packages/* package depend on or import the harness — keep the arrow test → packages.",
        designRef: "SEC-02 / harness is consumer-only (test → packages arrow)",
      }),
    ).toEqual({ depViolations: [], importViolations: [] });
  });
});
