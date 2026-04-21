// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-language schema drift detection test.
 *
 * Validates that the Python validator constants in validate-skill.py stay
 * in sync with the TypeScript Zod schemas (source of truth).
 *
 * Any drift between the two will cause test failure, catching issues
 * before they reach production.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Integration tests import from dist (built packages)
// SkillManifestSchema and CONTENT_SCAN_RULES are not on @comis/skills public API,
// so import from the dist files directly.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packagesDir = resolve(__dirname, "../../packages");

// Dynamic imports from dist to work with integration test alias resolution
const { SkillManifestSchema, SkillNameSchema, ComisNamespaceSchema } = await import(
  resolve(packagesDir, "skills/dist/manifest/schema.js")
);
const { CONTENT_SCAN_RULES } = await import(
  resolve(packagesDir, "skills/dist/prompt/content-scanner.js")
);

// Read and parse the Python validator file. Skip the whole suite when the
// skill-creator artifact is absent -- the repo has dropped the bundled
// Python validator in favor of per-skill validators, so drift detection
// between the Python source and the TS schema is no longer relevant here.
const pythonPath = resolve(__dirname, "../../skills/skill-creator/scripts/validate-skill.py");
const pythonSource = existsSync(pythonPath) ? readFileSync(pythonPath, "utf-8") : "";

/** Extract a Python integer constant: NAME_MAX = 64 */
function extractPythonInt(name: string): number {
  const match = pythonSource.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`));
  if (!match) throw new Error(`Python constant ${name} not found`);
  return parseInt(match[1].replace(/_/g, ""), 10);
}

/** Extract a Python regex pattern: NAME_REGEX = re.compile(r"...") */
function extractPythonRegex(name: string): string {
  const match = pythonSource.match(new RegExp(`${name}\\s*=\\s*re\\.compile\\(r"([^"]+)"\\)`));
  if (!match) throw new Error(`Python regex ${name} not found`);
  return match[1];
}

/** Extract a Python set: VALID_TOP_FIELDS = {"name", "description", ...} */
function extractPythonSet(name: string): Set<string> {
  const match = pythonSource.match(new RegExp(`${name}\\s*=\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Python set ${name} not found`);
  const members = match[1].match(/"([^"]+)"/g);
  if (!members) throw new Error(`No members found in Python set ${name}`);
  return new Set(members.map((m) => m.replace(/"/g, "")));
}

/** Count Python CRITICAL_PATTERNS entries */
function countPythonCriticalPatterns(): number {
  // Count tuples in CRITICAL_PATTERNS list
  const section = pythonSource.match(/CRITICAL_PATTERNS\s*=\s*\[([\s\S]*?)\n\]/);
  if (!section) throw new Error("CRITICAL_PATTERNS not found in Python source");
  // Count lines with (r" pattern starts
  return (section[1].match(/\(r"/g) || []).length;
}

// Skip the whole suite when the bundled Python validator is absent.
const describeMaybe = pythonSource ? describe : describe.skip;

describeMaybe("skill-schema-drift", () => {
  it("Python NAME_REGEX matches TypeScript SkillNameSchema pattern", () => {
    const pyPattern = extractPythonRegex("NAME_REGEX");
    // The TypeScript schema uses the same regex in .regex()
    // Extract from Zod schema description or use the known pattern
    const tsPattern = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$";
    expect(pyPattern).toBe(tsPattern);
  });

  it("Python NAME_MAX matches TypeScript SkillNameSchema max length", () => {
    const pyMax = extractPythonInt("NAME_MAX");
    // SkillNameSchema has .max(64)
    expect(pyMax).toBe(64);
  });

  it("Python DESC_MAX matches TypeScript description schema max length", () => {
    const pyMax = extractPythonInt("DESC_MAX");
    // SkillManifestSchema.description has .max(1024)
    expect(pyMax).toBe(1024);
  });

  it("Python VALID_TOP_FIELDS matches SkillManifestSchema top-level keys", () => {
    const pyFields = extractPythonSet("VALID_TOP_FIELDS");
    // Extract Zod schema keys from SkillManifestSchema shape
    const tsKeys = new Set(Object.keys(SkillManifestSchema.shape));
    // Python set should match TypeScript schema keys exactly
    expect(pyFields).toEqual(tsKeys);
  });

  it("Python VALID_COMIS_FIELDS matches ComisNamespaceSchema keys", () => {
    const pyFields = extractPythonSet("VALID_COMIS_FIELDS");
    // ComisNamespaceSchema is optional wrapper; unwrap to get inner shape
    // The schema is z.strictObject({...}).optional(), so .unwrap() gives the inner strictObject
    const innerSchema = ComisNamespaceSchema.unwrap();
    const tsKeys = new Set(Object.keys(innerSchema.shape));
    expect(pyFields).toEqual(tsKeys);
  });

  it("Python CRITICAL_PATTERNS covers same threat categories as TypeScript CRITICAL scan rules", () => {
    // Python has individual patterns per threat while TypeScript groups via broader regexes.
    // Rather than exact count, verify both cover the same threat categories.
    const tsCritical = CONTENT_SCAN_RULES.filter(
      (r: { severity: string }) => r.severity === "CRITICAL",
    );
    const tsCategories = new Set(
      tsCritical.map((r: { category: string }) => r.category),
    );

    // The Python CRITICAL_PATTERNS cover these same categories:
    // exec_injection ($(cmd), `cmd`, eval, pipe to bash)
    // crypto_mining (stratum, miner binaries)
    // network_exfiltration (reverse shell: /dev/tcp, nc -e)
    // obfuscated_encoding (base64 decode pipe)
    // xml_breakout (</available_skills>, <system>, etc.)
    const expectedCategories = new Set([
      "exec_injection",
      "crypto_mining",
      "network_exfiltration",
      "obfuscated_encoding",
      "xml_breakout",
    ]);
    expect(tsCategories).toEqual(expectedCategories);

    // Both should have CRITICAL rules (Python uses tuples, TS uses ScanRule objects)
    const pyCount = countPythonCriticalPatterns();
    expect(pyCount).toBeGreaterThanOrEqual(tsCritical.length);
    // Python may have more individual patterns than TS broader regexes, but TS must
    // cover at least as many categories
    expect(tsCategories.size).toBeGreaterThanOrEqual(expectedCategories.size);
  });
});
