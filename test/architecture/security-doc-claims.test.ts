// SPDX-License-Identifier: Apache-2.0
/**
 * Security-documentation claim guard.
 *
 * Comis's security documentation must describe mechanisms the codebase
 * actually uses. Two historical claims were false and reached `main`:
 *   - `SECURITY.md` said skills run in `isolated-vm` sandboxes — the real
 *     exec sandbox is OS-level bubblewrap / `sandbox-exec`; `isolated-vm`
 *     is not a dependency.
 *   - `README.md` implied "no external SDK dependency" / no external
 *     `pi-coding-agent`, while the agent runtime is built on
 *     `@earendil-works/pi-coding-agent`.
 *
 * This test pins both claims to the actual dependency graph so they cannot
 * silently drift back. `THREAT_MODEL.md` is intentionally NOT scanned: it
 * legitimately *names* mechanisms Comis does NOT use in order to document
 * what was corrected.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Strip HTML comments and fenced code blocks before running claim regexes. */
export function sanitizeDocText(raw: string): string {
  // Strip all HTML comments (including multiline)
  let text = raw.replace(/<!--[\s\S]*?-->/g, "");
  // Strip triple-backtick fenced code blocks (non-greedy — handles adjacent fences)
  text = text.replace(/`{3}[\s\S]*?`{3}/g, "");
  // Strip tilde fenced code blocks
  text = text.replace(/~{3}[\s\S]*?~{3}/g, "");
  return text;
}

/** Returns true if the doc claims isolated-vm while the dep graph does not contain it. */
export function securityMdViolatesIsolatedVm(
  sanitizedText: string,
  depNames: Set<string>,
): boolean {
  return /isolated-vm/i.test(sanitizedText) && !depNames.has("isolated-vm");
}

/** Returns true if the doc claims SDK independence while pi-coding-agent IS in deps. */
export function readmeViolatesSdkIndependence(
  sanitizedText: string,
  depNames: Set<string>,
): boolean {
  const claimsIndependence =
    /no external sdk dependenc/i.test(sanitizedText) ||    // matches dependency / dependencies / dependence
    /no external [`'"]?pi-coding-agent/i.test(sanitizedText);
  return claimsIndependence && depNames.has("@earendil-works/pi-coding-agent");
}

function readDoc(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

/** Every external dependency name declared anywhere in the workspace manifests. */
function collectDependencyNames(): Set<string> {
  const names = new Set<string>();
  const fields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const;

  const manifests: string[] = [resolve(REPO_ROOT, "package.json")];
  const packagesRoot = resolve(REPO_ROOT, "packages");
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = resolve(packagesRoot, entry.name, "package.json");
    if (existsSync(manifest)) manifests.push(manifest);
  }

  for (const manifest of manifests) {
    const json = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    for (const field of fields) {
      const deps = json[field];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps as Record<string, string>)) names.add(name);
      }
    }
  }

  // Merge lockfile names for transitive coverage (SC4)
  for (const name of collectLockfileNames()) names.add(name);
  return names;
}

/** Package names from pnpm-lock.yaml (transitive coverage). SC4. */
function collectLockfileNames(): Set<string> {
  const names = new Set<string>();
  const lockPath = resolve(REPO_ROOT, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) return names;
  const text = readFileSync(lockPath, "utf8");
  // Matches indented package-key lines in `packages:` and `snapshots:` sections.
  // Format: "  'package-name@version':" or "  package-name@version(peer@x):"
  const RE = /^  '?(@?[^@'(]+)@/;
  for (const line of text.split("\n")) {
    const m = RE.exec(line);
    if (m && m[1]) names.add(m[1].trim());
  }
  return names;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECURITY_MD = sanitizeDocText(readDoc("SECURITY.md"));
const README_MD   = sanitizeDocText(readDoc("README.md"));
const dependencyNames = collectDependencyNames();

describe("security documentation claims match the codebase", () => {
  it("SECURITY.md does not name isolated-vm while it is absent from the dependency graph", () => {
    expect(
      securityMdViolatesIsolatedVm(SECURITY_MD, dependencyNames),
      "SECURITY.md references isolated-vm, but it is not a dependency. The real exec sandbox is bubblewrap / sandbox-exec — correct the claim.",
    ).toBe(false);
  });

  it("README does not claim no-external-SDK while the agent runtime depends on pi-coding-agent", () => {
    expect(
      readmeViolatesSdkIndependence(README_MD, dependencyNames),
      "README claims SDK independence, but @earendil-works/pi-coding-agent is a dependency. State that Comis owns its domain types in-tree instead.",
    ).toBe(false);
  });

  it("no security claims doc names an isolation library that is absent from the dependency graph", () => {
    // Claims surface only. THREAT_MODEL.md is excluded by design: it names
    // non-mechanisms (e.g. isolated-vm) to document corrections.
    const claimsDocs = `${SECURITY_MD}\n${README_MD}`;
    const isolationLibraries = ["isolated-vm", "vm2"];
    for (const library of isolationLibraries) {
      if (new RegExp(escapeRegex(library), "i").test(claimsDocs)) {
        expect(
          dependencyNames.has(library),
          `A security claims doc names "${library}" as an isolation mechanism, but it is not a dependency.`,
        ).toBe(true);
      }
    }
  });

  it("THREAT_MODEL.md exists at repo root so SC1 is machine-enforced", () => {
    expect(
      existsSync(resolve(REPO_ROOT, "THREAT_MODEL.md")),
      "THREAT_MODEL.md not found — run the threat model publishing task first.",
    ).toBe(true);
  });
});
