// SPDX-License-Identifier: Apache-2.0
/**
 * Keyless-ness is a property of the provider TYPE (ollama / lm-studio), NOT its
 * config NAME. Every `KEYLESS_PROVIDER_TYPES.has(X)` call MUST pass a resolved
 * TYPE (`entry.type` / `providerEntry?.type ?? …`), never a bare provider name.
 *
 * Live regression this guards (package-delivery-20260628, local qwen3.6:35b):
 * three credential resolvers checked `.has(provider)` / `.has(resolved.provider)`
 * — the provider config NAME. A user-NAMED ollama entry
 * (`providers.entries["local-ollama"] = { type: "ollama" }`) then FAILED the
 * keyless exemption, so `resolveCronJobCredential` / `resolveOutcomeJudge` /
 * `resolveCorrectionDetector` returned no key and the reflection, memory-review,
 * outcome-judge and correction-detector crons SKIPPED ("Skipping reflection --
 * no API key") on a local keyless daemon — silently disabling the ENTIRE
 * memory/learning loop (mental_models / outcome attribution stayed 0). The main
 * completion path (`model-registry-adapter` / `auth-storage-adapter`) and
 * `setup-dialectic` already key off `entry.type` and worked; the divergence WAS
 * the bug. `KEYLESS_PROVIDER_TYPES` is the canonical single source of truth
 * (`@comis/core` `keyless-providers.ts`) consumed by both the agent completion
 * path AND the daemon cron/memory gates — so both must detect by type.
 *
 * Why a source-pattern guard (not only the per-resolver unit tests): the bug is
 * a one-token divergence (`provider` vs `providerEntry?.type ?? provider`) that a
 * future edit (or a clobber) can silently re-introduce at ANY call site; a unit
 * test only covers the sites it enumerates. This scans every site mechanically.
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SCAN_ROOTS = [
  resolve(REPO_ROOT, "packages/daemon/src"),
  resolve(REPO_ROOT, "packages/agent/src"),
];

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      yield* walkTs(p);
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) yield p;
  }
}

// Capture the single argument expression of each `KEYLESS_PROVIDER_TYPES.has(...)`.
// None of the real call sites nest parens inside the arg, so a non-greedy `[^)]*?`
// to the first `)` is exact (and intentionally fails loudly if that ever changes).
const CALL_RE = /KEYLESS_PROVIDER_TYPES\.has\(\s*([^)]*?)\s*\)/g;

describe("keyless-provider detection keys off TYPE, not config NAME (package-delivery-20260628)", () => {
  it("every KEYLESS_PROVIDER_TYPES.has(X) passes a resolved TYPE (contains `.type`), never a bare provider name", () => {
    const sites: { file: string; arg: string }[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkTs(root)) {
        const src = readFileSync(file, "utf8");
        CALL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CALL_RE.exec(src)) !== null) {
          sites.push({ file: file.slice(REPO_ROOT.length + 1), arg: m[1] });
        }
      }
    }
    // Non-vacuity: the canonical call sites are actually being scanned.
    expect(
      sites.length,
      "no KEYLESS_PROVIDER_TYPES.has() call sites found — scan roots stale or the constant was renamed?",
    ).toBeGreaterThanOrEqual(5);

    const violations = sites.filter((s) => !s.arg.includes(".type"));
    expect(
      violations,
      "keyless-by-NAME bug class — these pass a provider NAME, not a resolved TYPE, so a custom-named " +
        "ollama/lm-studio entry (providers.entries.<name> = { type: 'ollama' }) is NOT detected as keyless " +
        "and the cron/judge/correction SILENTLY SKIPS on a local keyless daemon. Use " +
        "`providerEntry?.type ?? <provider>` (see setup-dialectic.ts / credential-resolver.ts):\n" +
        violations.map((v) => `  ${v.file}: KEYLESS_PROVIDER_TYPES.has(${v.arg})`).join("\n"),
    ).toEqual([]);
  });
});
