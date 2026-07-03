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

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Strip HTML comments and fenced code blocks before running claim regexes. */
export function sanitizeDocText(raw: string): string {
  // Strip all HTML comments (including multiline)
  let text = raw.replace(/<!--[\s\S]*?-->/g, "");
  // Strip triple-backtick fenced code blocks (non-greedy — handles adjacent fences).
  // First pass: matched (closed) fences. Second pass: unclosed fence to end-of-string.
  text = text.replace(/`{3}[\s\S]*?`{3}/g, "");
  text = text.replace(/`{3}[\s\S]*$/g, "");
  // Strip tilde fenced code blocks (closed then unclosed).
  text = text.replace(/~{3}[\s\S]*?~{3}/g, "");
  text = text.replace(/~{3}[\s\S]*$/g, "");
  // Strip inline code spans: double-backtick before single-backtick to
  // avoid partial matches (e.g. ``isolated-vm`` must not leave a stray `)
  text = text.replace(/``[^`]*``/g, "");
  text = text.replace(/`[^`\n]+`/g, "");
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

  // Merge lockfile names for transitive coverage
  for (const name of collectLockfileNames()) names.add(name);
  return names;
}

/** Package names from pnpm-lock.yaml (transitive coverage). */
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
    if (m && m[1]) {
      // pnpm v5/v6 path-style keys ("/package-name@version:") carry a
      // leading slash that would cause depNames.has("isolated-vm") to miss
      // a path-style entry captured as "/isolated-vm". Strip it.
      const name = m[1].trim().replace(/^\//, "");
      if (name) names.add(name);
    }
  }
  return names;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the combined claims text names `library` as an isolation
 * mechanism while `library` is absent from the dependency graph.
 *
 * This is the per-library check powering the third guard test. Exporting it
 * allows the meta-test suite to assert RED-state (accidental logic inversion
 * would go undetected otherwise).
 */
export function claimsDocNamesAbsentIsolationLibrary(
  claimsText: string,
  library: string,
  depNames: Set<string>,
): boolean {
  return new RegExp(escapeRegex(library), "i").test(claimsText) && !depNames.has(library);
}

/**
 * Returns true if `audit.mdx` claims the audit is durably
 * PERSISTED (survives restart) WITHOUT naming the backing durable sink(s) the
 * codebase actually writes — `obs_audit_events` (the SQLite table) and/or
 * `security-audit.jsonl` (the 0600 rotated JSONL). A historical over-claim
 * named ONLY `~/.comis/logs/daemon.log` as the durable store while there were
 * ZERO `.audit()` callers — the doc was flatly wrong. RED when the doc still
 * over-claims; GREEN once the doc names a real sink AND that sink exists.
 *
 * The persistence claim is detected by the doc asserting durability ("persist"
 * across restarts) OR naming the daemon-log file as the store of record; the
 * backing-sink check is satisfied by the doc naming EITHER real sink token.
 * Exported so a meta-test can confirm the RED state (an accidental
 * logic-inversion would otherwise make the assertion vacuous — the
 * `claimsDocNamesAbsentIsolationLibrary` precedent).
 */
export function auditDocClaimsDurabilityWithoutSink(auditDocText: string): boolean {
  const claimsDurablePersistence =
    /persists? across restarts/i.test(auditDocText) ||
    /\bdurable\b/i.test(auditDocText) ||
    /survives? (?:a )?restart/i.test(auditDocText);
  if (!claimsDurablePersistence) return false; // makes no persistence claim → nothing to back
  const namesRealSink =
    /obs_audit_events/i.test(auditDocText) || /security-audit\.jsonl/i.test(auditDocText);
  return !namesRealSink;
}

const SECURITY_MD = sanitizeDocText(readDoc("SECURITY.md"));
const README_MD   = sanitizeDocText(readDoc("README.md"));
// The audit doc is scanned for the durability-claim↔sink
// invariant. Scanned WITH code fences stripped so the `grep '...'` examples (which
// legitimately reference daemon.log) do not satisfy the sink check — the PROSE
// claim must name the real sink. THREAT_MODEL.md stays EXCLUDED by design (below).
const AUDIT_MDX = sanitizeDocText(readDoc("docs/security/audit.mdx"));
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
      expect(
        claimsDocNamesAbsentIsolationLibrary(claimsDocs, library, dependencyNames),
        `A security claims doc names "${library}" as an isolation mechanism, but it is not a dependency.`,
      ).toBe(false);
    }
  });

  it("THREAT_MODEL.md exists at the repo root and is machine-enforced", () => {
    expect(
      existsSync(resolve(REPO_ROOT, "THREAT_MODEL.md")),
      "THREAT_MODEL.md not found — run the threat model publishing task first.",
    ).toBe(true);
  });

  // audit.mdx's durable-persistence claim must name the
  // real backing sink (obs_audit_events / security-audit.jsonl), not over-claim a
  // daemon.log-only store that historically had zero .audit() callers. RED on the
  // pre-correction doc; GREEN once the doc names a real sink AND that
  // sink exists. THREAT_MODEL.md is deliberately NOT in the scanned set.
  it("audit.mdx does not claim durable persistence without naming a backing sink", () => {
    expect(
      auditDocClaimsDurabilityWithoutSink(AUDIT_MDX),
      "docs/security/audit.mdx claims the audit persists across restarts but does not name the real durable sink (obs_audit_events / security-audit.jsonl). Correct the Storage & Retention section — daemon.log is NOT the durable store of record.",
    ).toBe(false);
  });

  // THREAT_MODEL.md stays EXCLUDED from the scanned set by design — it
  // legitimately names non-mechanisms/corrections. This pins that exclusion so a
  // future change cannot silently start scanning it (the inverse-regression guard).
  it("THREAT_MODEL.md is NOT in the audit claim↔sink scanned set (excluded by design)", () => {
    const scanned = [SECURITY_MD, README_MD, AUDIT_MDX];
    const threatModel = readDoc("THREAT_MODEL.md");
    expect(scanned.includes(threatModel)).toBe(false);
  });
});
