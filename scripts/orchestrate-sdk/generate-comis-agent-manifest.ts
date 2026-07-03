// SPDX-License-Identifier: Apache-2.0
/**
 * Codegen entry point: produces the committed `comis-agent-manifest.json`
 * (`packages/skills/src/tools/builtin/orchestrate/comis-agent-manifest.json`)
 * DETERMINISTICALLY by hashing the COMIS-BUILT `comis-agent` entry artifact
 * (`packages/skills/dist/tools/builtin/orchestrate/comis-agent-entry.js`).
 *
 * The manifest is the sha256 PIN of the comis-built CLI binary. The
 * binary is bound `--ro-bind` into the orchestrate jail; at jail
 * construction `resolveJailAgentCli` re-hashes the bound file and REFUSES on a
 * mismatch (tamper detection) — so the manifest is the trust anchor
 * for the bound bytes.
 *
 * We pin the COMIS artifact (`comis-agent-entry.js`, deterministic
 * from source via `tsc`), NEVER the host `node` interpreter binary (whose hash
 * is build-machine-specific). The drift gate
 * (`test/architecture/comis-agent-bound-binary.test.ts`) re-hashes the freshly
 * built dist file and asserts it equals the committed manifest — mirror of the
 * `orchestrate-sdk-drift.test.ts` byte-identical gate (a source change without a
 * regen fails CI; "run `pnpm agent-cli:manifest` and commit").
 *
 * Determinism rules (mirrors generate-comis-tools-sdk.ts:32-36):
 *   - No ambient-clock read, no constructed Date, no UUID, no randomness, no
 *     host path in the manifest — JUST `{ file, sha256 }`.
 *   - Stable key order (`file` then `sha256`); 2-space indentation; trailing
 *     newline (POSIX). A second generation over the same bytes is byte-identical.
 *
 * Usage:
 *   pnpm agent-cli:manifest
 *   # or: npx tsx scripts/orchestrate-sdk/generate-comis-agent-manifest.ts
 *
 * @module
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths — anchored to repo root via this script's directory (mirrors
// generate-comis-tools-sdk.ts:64-77).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/** The committed manifest filename (bound into dist via the asset-copy). */
export const MANIFEST_FILENAME = "comis-agent-manifest.json";

/** The pinned artifact's basename — what the manifest's `file` field records. */
export const ENTRY_FILENAME = "comis-agent-entry.js";

/** The committed manifest path (the trust anchor `resolveJailAgentCli` reads). */
export const OUT_PATH = resolve(
  REPO_ROOT,
  "packages",
  "skills",
  "src",
  "tools",
  "builtin",
  "orchestrate",
  MANIFEST_FILENAME,
);

/** The COMIS-BUILT entry artifact we hash (the dist file, NOT the host node). */
export const ENTRY_PATH = resolve(
  REPO_ROOT,
  "packages",
  "skills",
  "dist",
  "tools",
  "builtin",
  "orchestrate",
  ENTRY_FILENAME,
);

// ---------------------------------------------------------------------------
// The manifest shape — the closed contract the drift gate + resolver share.
// ---------------------------------------------------------------------------

/** The deterministic pin: the artifact basename + its sha256 (NOTHING else). */
export interface ComisAgentManifest {
  /** The pinned artifact basename, always {@link ENTRY_FILENAME}. */
  readonly file: string;
  /** The lowercase-hex sha256 of the comis-built entry bytes. */
  readonly sha256: string;
}

// ---------------------------------------------------------------------------
// Pure compute — hash → manifest string.
// ---------------------------------------------------------------------------

/** sha256 of the entry bytes, lowercase hex (the pin). */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Serialize the manifest deterministically: stable key order (`file` then
 * `sha256`), 2-space indent, POSIX trailing newline. A second call over the
 * same bytes yields the identical string (the determinism the drift gate asserts).
 */
export function serializeManifest(manifest: ComisAgentManifest): string {
  // Hand-ordered object literal — NOT `JSON.stringify(manifest)` over a
  // caller-built object whose key order could drift. file FIRST, sha256 SECOND.
  const ordered = { file: manifest.file, sha256: manifest.sha256 };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Compute the manifest STRING from the built entry's bytes. Pure: the only input
 * is the file bytes (the caller does the fs read), so the determinism is
 * macOS-unit-testable without a build.
 */
export function buildManifest(entryBytes: Buffer): string {
  return serializeManifest({ file: ENTRY_FILENAME, sha256: sha256Hex(entryBytes) });
}

// ---------------------------------------------------------------------------
// runGenerate — read the built dist entry, write the committed manifest, return
// the produced string (so the drift test compares in-memory == disk).
// ---------------------------------------------------------------------------

/**
 * Read the freshly-built `comis-agent-entry.js`, compute the manifest, and write
 * it to the committed path. Returns the written string. `entryPath`/`outPath`
 * default to the real paths; the drift test redirects `outPath` to a temp dir to
 * avoid racing on the committed file (mirrors the SDK codegen rationale).
 *
 * @throws when the built entry is absent — a LOUD failure ("run `pnpm build`
 *   first"), never a silent empty manifest.
 */
export function runGenerate(
  entryPath: string = ENTRY_PATH,
  outPath: string = OUT_PATH,
): string {
  const entryBytes = readFileSync(entryPath); // eslint-disable-line security/detect-non-literal-fs-filename
  const manifest = buildManifest(entryBytes);
  writeFileSync(outPath, manifest); // eslint-disable-line security/detect-non-literal-fs-filename
  return manifest;
}

/**
 * CLI entry point. Runs `runGenerate`, prints a one-line summary (the hash is
 * NOT a secret — it is the public pin committed to the repo).
 */
function main(): void {
  const manifest = runGenerate();
  const parsed = JSON.parse(manifest) as ComisAgentManifest;
  console.log(`Generated ${MANIFEST_FILENAME}: ${parsed.file} → sha256:${parsed.sha256}`);
}

// Run when invoked as a script (`npx tsx` / `pnpm agent-cli:manifest`). Avoid
// running when imported (e.g., by the drift test).
const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isMainModule) {
  main();
}
