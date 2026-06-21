// SPDX-License-Identifier: Apache-2.0
/**
 * Forward-protective umbrella-bundling alignment test.
 *
 * `packages/comis/package.json:bundledDependencies`
 * is the SINGLE SOURCE OF TRUTH for the workspace-package list. This test
 * derives `ALL_BUNDLED_PACKAGES` / `NAMESPACED_PACKAGES` from that source
 * and cross-checks FIVE INDEPENDENT dimensions:
 *
 *   1. `prepack.js` source — must read `bundledDependencies` (consolidation
 *      contract; prevents future regression to a hand-rolled literal array)
 *   2. `package.json` exports map — keys must include every namespaced bundled
 *      package (sans ".")
 *   3. Mirror files at `packages/comis/src/<name>.ts` — one per namespaced
 *      package (filesystem dimension)
 *   4. Namespace re-exports in `packages/comis/src/index.ts` — one per
 *      namespaced package (source-code dimension)
 *   5. `packages/<name>/` directory listing — must equal `ALL_BUNDLED_PACKAGES`
 *      (filesystem dimension)
 *
 * We deliberately do NOT assert
 * `bundledDependencies === bundledDependencies` (the tautological pattern).
 * The five dimensions above each vary independently from the canonical
 * source, so a developer who edits `bundledDependencies` without touching
 * the readers (or vice versa) still fails the test.
 *
 * Failure mode this test prevents: developer adds @comis/foo to one surface
 * but forgets the others -> tarball publish-time failure rather than test-time
 * failure.
 *
 * Note on `web`: web is bundled (in bundledDependencies) but has NO namespace
 * re-export and NO mirror file (current convention). `ALL_BUNDLED_PACKAGES`
 * includes web; `NAMESPACED_PACKAGES` excludes it.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

function readUmbrellaPackageJson(): {
  bundledDependencies: string[];
  exports: Record<string, unknown>;
} {
  const path = resolve(REPO_ROOT, "packages/comis/package.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Derive the canonical workspace-package list from
 * `packages/comis/package.json:bundledDependencies`.
 *
 * `web` is bundled but has no namespace re-export and no mirror file in
 * `packages/comis/src/`. Callers that operate on namespaced packages (mirror
 * files, namespace re-exports, exports map) must use `namespaced`; callers
 * that operate on the full bundling surface (packages/ directory listing)
 * use `all`.
 */
function readUmbrellaBundledPackages(): {
  namespaced: readonly string[];
  all: readonly string[];
} {
  const pkg = readUmbrellaPackageJson();
  const all = (pkg.bundledDependencies ?? [])
    .filter((s: unknown): s is string => typeof s === "string" && s.startsWith("@comis/"))
    .map((s: string) => s.replace(/^@comis\//, ""));
  const namespaced = all.filter((p) => p !== "web");
  return { namespaced, all };
}

const { namespaced: NAMESPACED_PACKAGES, all: ALL_BUNDLED_PACKAGES } =
  readUmbrellaBundledPackages();

function readIndexNamespaces(): string[] {
  const path = resolve(REPO_ROOT, "packages/comis/src/index.ts");
  const content = readFileSync(path, "utf8");
  // Package names may contain hyphens (e.g. `observability-otel`), so the
  // specifier capture is `[\w-]+`, not `\w+` (which stops at the first hyphen
  // and would silently miss a hyphenated namespace import).
  const importRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+"@comis\/([\w-]+)"/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    found.push(m[2]);
  }
  return found;
}

function readPackagesDirectories(): string[] {
  const packagesDir = resolve(REPO_ROOT, "packages");
  return readdirSync(packagesDir)
    .filter((name) => {
      const stat = statSync(join(packagesDir, name));
      if (!stat.isDirectory()) return false;
      if (name === "comis") return false; // exclude the umbrella itself
      return existsSync(join(packagesDir, name, "package.json"));
    })
    .sort();
}

function readPrepackSource(): string {
  const path = resolve(REPO_ROOT, "packages/comis/scripts/prepack.js");
  return readFileSync(path, "utf8");
}

describe("umbrella-bundling -- bidirectional 5-way alignment vs bundledDependencies", () => {
  // Dimension 5 — packages/ directories vs canonical source.
  it("packages/ directories match ALL_BUNDLED_PACKAGES (set equality)", () => {
    const dirs = new Set(readPackagesDirectories());
    const expected = new Set<string>(ALL_BUNDLED_PACKAGES);
    const onlyInDirs = [...dirs].filter((d) => !expected.has(d));
    const onlyInExpected = [...expected].filter((d) => !dirs.has(d));
    expect(
      { onlyInDirs, onlyInExpected },
      formatViolations({
        description:
          "packages/ directories must match ALL_BUNDLED_PACKAGES (bundledDependencies-derived).",
        violations: [
          ...onlyInDirs.map((d) => ({
            file: `packages/${d}/`,
            line: 0,
            snippet: "unexpected directory not in bundledDependencies",
          })),
          ...onlyInExpected.map((d) => ({
            file: "(missing)",
            line: 0,
            snippet: `expected directory packages/${d}/ not found`,
          })),
        ],
        suggestedFix:
          "Add the new package to packages/comis/package.json:bundledDependencies AND to exports AND to mirror file AND to namespace re-export AND to the packages/ tree. All 5 surfaces or none.",
        designRef: "umbrella-bundling — single source of truth",
      }),
    ).toEqual({ onlyInDirs: [], onlyInExpected: [] });
  });

  // Dimension 1 — prepack.js consolidation contract.
  //
  // prepack.js no longer carries a literal `WORKSPACE_PACKAGES` array — it
  // reads `bundledDependencies` at runtime. This assertion preserves the
  // dimension by checking that prepack.js source still references
  // `bundledDependencies` and that the literal array form has NOT been
  // reintroduced. This is non-tautological because prepack.js is independent
  // code that could regress.
  it("prepack.js reads bundledDependencies (no literal WORKSPACE_PACKAGES array)", () => {
    const source = readPrepackSource();
    const referencesBundledDeps = /bundledDependencies/.test(source);
    const hasLiteralArray = /const\s+WORKSPACE_PACKAGES\s*=\s*\[\s*"/.test(source);
    expect(
      { referencesBundledDeps, hasLiteralArray },
      "prepack.js must derive WORKSPACE_PACKAGES from bundledDependencies — not a hand-rolled literal array.",
    ).toEqual({ referencesBundledDeps: true, hasLiteralArray: false });
  });

  // Dimension 2 — exports map vs canonical source.
  it("exports map includes every namespaced bundled package (except web)", () => {
    const pkg = readUmbrellaPackageJson();
    const exportKeys = new Set(
      Object.keys(pkg.exports).filter((k) => k !== "."),
    );
    const expected = new Set<string>(NAMESPACED_PACKAGES.map((p) => `./${p}`));
    const missing = [...expected].filter((e) => !exportKeys.has(e));
    const extras = [...exportKeys].filter((e) => !expected.has(e));
    expect(
      { missing, extras },
      `exports map drift vs bundledDependencies: missing=${missing.join(", ")}, extras=${extras.join(", ")}`,
    ).toEqual({ missing: [], extras: [] });
  });

  // Dimension 3 — mirror files vs canonical source.
  it("mirror file exists for every namespaced bundled package", () => {
    const missing: string[] = [];
    for (const pkg of NAMESPACED_PACKAGES) {
      const mirrorPath = resolve(REPO_ROOT, `packages/comis/src/${pkg}.ts`);
      if (!existsSync(mirrorPath))
        missing.push(`packages/comis/src/${pkg}.ts`);
    }
    expect(missing, `missing mirror files: ${missing.join(", ")}`).toEqual([]);
  });

  // Dimension 4 — namespace re-exports vs canonical source.
  it("namespace re-export in src/index.ts includes every namespaced bundled package", () => {
    const fromIndex = new Set(readIndexNamespaces());
    const expected = new Set<string>(NAMESPACED_PACKAGES);
    const missing = [...expected].filter((p) => !fromIndex.has(p));
    const extras = [...fromIndex].filter((p) => !expected.has(p));
    expect(
      { missing, extras },
      `namespace re-export drift vs bundledDependencies: missing=${missing.join(", ")}, extras=${extras.join(", ")}`,
    ).toEqual({ missing: [], extras: [] });
  });

  // Dimension 6 — umbrella dependency closure vs bundled backend packages.
  //
  // The bundled @comis/* packages ship WITHOUT their own node_modules — they
  // resolve every third-party import against the umbrella's FLAT top-level
  // node_modules. Therefore the umbrella's `dependencies` MUST be a superset of
  // every bundled backend package's third-party (non-@comis) runtime deps, at a
  // version the workspace package declares. A dep declared by a workspace
  // package but absent here is a publish-time landmine: it resolves via pnpm
  // hoisting in the dev monorepo and CRASHES the installed daemon with
  // ERR_MODULE_NOT_FOUND. This is exactly how the credential broker shipped a
  // boot-breaking gap (reflect-metadata / @peculiar/x509 / tsyringe were
  // declared in @comis/infra + @comis/daemon but never added to the umbrella).
  //
  // Both `dependencies` AND `optionalDependencies` count, on each side: npm
  // installs optionalDependencies by default (it only skips one whose own
  // install/build fails). So a native optional dep — e.g. `node-pty`, which the
  // terminal-driver loads via a guarded `createRequire` and falls back to a pipe
  // backend if absent — is still load-bearing on every host where its build
  // succeeds. Omitting it from the umbrella means the published install NEVER
  // gets it (the bundled @comis/skills has its own deps stripped by prepack.js),
  // so the terminal-driver silently runs degraded forever. Ignoring optional
  // deps here is the blind spot that let that gap reach main.
  //
  // `web` is excluded (NAMESPACED_PACKAGES already drops it): it is
  // frontend-bundled — `vite build` inlines lit / @dagrejs/dagre into the
  // client assets, so they are never require()d from the Node runtime.
  it("umbrella dependencies are a superset of every bundled backend package's third-party runtime deps", () => {
    const umbrella = readUmbrellaPackageJson() as unknown as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    // The umbrella satisfies a bundled import whether it declares the dep as a
    // regular OR an optional dependency (npm installs both by default), so the
    // "have" side merges the two maps. `dependencies` last → a dep declared in
    // both is matched against its regular-dep version.
    const umbrellaDeps = {
      ...(umbrella.optionalDependencies ?? {}),
      ...(umbrella.dependencies ?? {}),
    };

    // dep -> set of versions declared by the backend bundled packages.
    // dependencies AND optionalDependencies both impose a runtime resolution
    // requirement the umbrella's flat node_modules must satisfy.
    const required = new Map<string, Set<string>>();
    for (const pkg of NAMESPACED_PACKAGES) {
      const path = resolve(REPO_ROOT, `packages/${pkg}/package.json`);
      const json = JSON.parse(readFileSync(path, "utf8")) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const declared = {
        ...(json.optionalDependencies ?? {}),
        ...(json.dependencies ?? {}),
      };
      for (const [dep, version] of Object.entries(declared)) {
        if (dep.startsWith("@comis/")) continue;
        if (!required.has(dep)) required.set(dep, new Set());
        required.get(dep)?.add(version);
      }
    }

    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const [dep, versions] of [...required].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const have = umbrellaDeps[dep];
      if (have === undefined) {
        missing.push(`${dep} (need ${[...versions].join("|")})`);
      } else if (!versions.has(have)) {
        mismatched.push(
          `${dep}: umbrella=${have}, workspace=${[...versions].join("|")}`,
        );
      }
    }

    expect(
      { missing, mismatched },
      formatViolations({
        description:
          "Umbrella comisai/package.json dependencies must include every third-party runtime dep of the bundled backend @comis/* packages (version-matched). A missing dep crashes the installed daemon with ERR_MODULE_NOT_FOUND even though the hoisted dev monorepo masks it.",
        violations: [
          ...missing.map((m) => ({
            file: "packages/comis/package.json",
            line: 0,
            snippet: `missing dependency: ${m}`,
          })),
          ...mismatched.map((m) => ({
            file: "packages/comis/package.json",
            line: 0,
            snippet: `version mismatch: ${m}`,
          })),
        ],
        suggestedFix:
          "Add each missing dependency to packages/comis/package.json:dependencies, exact-pinned to the version the workspace package declares, then run pnpm install to refresh the lockfile.",
        designRef: "umbrella-bundling — dependency closure (Dimension 6)",
      }),
    ).toEqual({ missing: [], mismatched: [] });
  });

  it("sanity: at least 12 namespaced packages", () => {
    expect(
      NAMESPACED_PACKAGES.length,
      "sanity: at least 12 packages bundled",
    ).toBeGreaterThanOrEqual(12);
  });
});
