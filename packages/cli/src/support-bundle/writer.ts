// SPDX-License-Identifier: Apache-2.0
/**
 * Safe writer for the support bundle — the security backbone.
 *
 * Every directory is created via `ensureContainedDir` (mode 0o700, real-path
 * confined to the data dir, symlinked-dir refusal); every file is written via
 * `writeRegularFile` (0o600, O_NOFOLLOW, unlink-before-open); every path is
 * composed with `safePath`. The raw path-join and unchecked file-write calls
 * are deliberately avoided. The write set is an explicit four-file allowlist,
 * never a data-dir glob.
 *
 * Inputs are content-free by construction, so the redaction pass is a
 * belt-and-suspenders backstop: every JSON object is walked and every free-text
 * leaf masked before it reaches disk. A section that cannot be produced folds
 * into a manifest warning and the writer continues (partial output); only a
 * failure to create the bundle directory is a hard error.
 *
 * @module
 */

import { safePath, systemDateFrom, systemGetEnv } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import {
  ensureContainedDir,
  writeRegularFile,
  redactString,
  substitutePathsInString,
  walkAndRedactStrings,
  type RedactionOpts,
} from "@comis/observability";

import {
  type SupportTriage,
  type SupportBundleWarning,
  type SupportBundleManifest,
} from "./types.js";

/** Inputs for a single bundle write. Every read happens in the caller. */
export interface WriteSupportBundleInput {
  /** The resolved data dir root; the bundle is written under it. */
  readonly dataDir: string;
  /** Generation instant in epoch ms — stamps the manifest and the dir name. */
  readonly generatedAtMs: number;
  /** The deterministic triage verdict (written as triage.json). */
  readonly triage: SupportTriage;
  /** The rendered issue summary (written as issue-summary.md). */
  readonly issueSummaryMd: string;
  /** The doctor diagnostic object (written as doctor.json). */
  readonly doctorJson: unknown;
  /** Upstream coverage/section warnings folded into the manifest. */
  readonly warnings?: readonly SupportBundleWarning[];
}

/** Success payload — the bundle dir and the merged warning set. */
export interface WriteSupportBundleSuccess {
  readonly bundleDir: string;
  readonly warnings: SupportBundleWarning[];
}

/**
 * The one hard failure: the bundle directory could not be created (a symlinked
 * slot, an ENOTDIR collision, a confinement escape). Section-level failures are
 * recorded as warnings, not errors, so a partial bundle is still produced.
 */
export type WriteSupportBundleError = {
  readonly kind: "bundle-dir-create-failed";
  readonly reason: string;
};

/** Best-effort human-readable reason from a Result error or thrown value. */
function describeError(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build the redaction backstop options. `safePath` resolves real paths and can
 * throw on a symlink that escapes the data dir, so the workspace token is
 * derived defensively — falling back to state/home substitution only.
 */
function buildRedactionOpts(dataDir: string): RedactionOpts {
  const homeDir = systemGetEnv("HOME");
  try {
    return { stateDir: dataDir, homeDir, workspaceDir: safePath(dataDir, "workspace") };
  } catch {
    return { stateDir: dataDir, homeDir };
  }
}

/**
 * Resolve and create the support-bundles parent and the per-bundle dir under
 * the symlink-safe, real-path-confined primitive. `safePath` throws on a
 * symlink escape and `ensureContainedDir` returns `err` on a refused/failed
 * create; both fold into the one hard error so the writer never throws.
 */
function prepareBundleDir(
  dataDir: string,
  bundleDirName: string,
): Result<string, WriteSupportBundleError> {
  try {
    const supportBundlesDir = safePath(dataDir, "support-bundles");
    const parentResult = ensureContainedDir({
      dir: supportBundlesDir,
      mode: 0o700,
      confinedBaseDir: dataDir,
    });
    if (!parentResult.ok) {
      return err({ kind: "bundle-dir-create-failed", reason: describeError(parentResult.error) });
    }

    const bundleDir = safePath(supportBundlesDir, bundleDirName);
    const bundleDirResult = ensureContainedDir({
      dir: bundleDir,
      mode: 0o700,
      confinedBaseDir: dataDir,
    });
    if (!bundleDirResult.ok) {
      return err({ kind: "bundle-dir-create-failed", reason: describeError(bundleDirResult.error) });
    }
    return ok(bundleDir);
  } catch (thrown) {
    return err({ kind: "bundle-dir-create-failed", reason: describeError(thrown) });
  }
}

/**
 * Write the four-file support bundle under `<dataDir>/support-bundles/`.
 *
 * Creates `comis-support-<tsIso>/` (a timestamp-only name — no host component)
 * and writes `issue-summary.md`, `triage.json`, `doctor.json`, and
 * `manifest.json`, each through the symlink-safe primitives with the redaction
 * backstop applied. The manifest is written last so it records every section
 * that failed. Returns `err` only when the directory itself cannot be created.
 *
 * @param input - The bundle inputs (all pre-read by the caller).
 * @returns `ok({ bundleDir, warnings })` on a full or partial write, or
 *   `err({ kind: "bundle-dir-create-failed" })` when the dir is unproducible.
 */
export function writeSupportBundle(
  input: WriteSupportBundleInput,
): Result<WriteSupportBundleSuccess, WriteSupportBundleError> {
  const { dataDir, generatedAtMs, triage, issueSummaryMd, doctorJson } = input;

  // The dir name carries a timestamp only, never a host component.
  const generatedAt = systemDateFrom(generatedAtMs).toISOString();
  const tsIso = generatedAt.replace(/[:.]/g, "-");
  const bundleDirName = `comis-support-${tsIso}`;

  // Create the support-bundles parent and the per-bundle dir. A failure to
  // create either is the one hard error (the bundle cannot be produced).
  const dirResult = prepareBundleDir(dataDir, bundleDirName);
  if (!dirResult.ok) {
    return dirResult;
  }
  const bundleDir = dirResult.value;

  // The redaction backstop, built once. stateDir/homeDir/workspaceDir drive the
  // path → placeholder substitution (longest-match-wins).
  const redactionOpts = buildRedactionOpts(dataDir);

  // Free-text leaf: mask value shapes, then substitute known paths.
  const redactText = (text: string): string =>
    substitutePathsInString(redactString(text), redactionOpts);

  const sectionWarnings: SupportBundleWarning[] = [];
  const recordSectionFailure = (name: string, reason: string): void => {
    sectionWarnings.push({
      source: "writer",
      code: "section_write_failed",
      count: 1,
      message: redactText(`Failed to write ${name}: ${reason}`),
    });
  };

  // The content files — the explicit allowlist. Each body is lazy so a
  // serialization failure is caught per-section rather than crashing the run.
  const FILE_PLAN: ReadonlyArray<{ name: string; body: () => string }> = [
    { name: "issue-summary.md", body: () => redactText(issueSummaryMd) },
    {
      name: "triage.json",
      body: () => JSON.stringify(walkAndRedactStrings(triage, redactionOpts), null, 2),
    },
    {
      name: "doctor.json",
      body: () => JSON.stringify(walkAndRedactStrings(doctorJson, redactionOpts), null, 2),
    },
  ];

  for (const { name, body } of FILE_PLAN) {
    try {
      const writeResult = writeRegularFile({
        path: safePath(bundleDir, name),
        content: body(),
        confinedBaseDir: dataDir,
      });
      if (!writeResult.ok) {
        recordSectionFailure(name, describeError(writeResult.error));
      }
    } catch (thrown) {
      recordSectionFailure(name, describeError(thrown));
    }
  }

  // Merge upstream warnings, redacting their free-text so the manifest honors
  // the every-leaf-redacted contract.
  const incoming = (input.warnings ?? []).map((warning) => ({
    ...warning,
    message: redactText(warning.message),
  }));
  const manifestWarnings: SupportBundleWarning[] = [...incoming, ...sectionWarnings];

  // The manifest is structural metadata built here (privacy sourced from the
  // triage so the two artifacts never drift). Only its free-text leaves — the
  // warning messages — are redacted; the enum literal and generatedAt stay
  // pristine so the manifest round-trips through its parser.
  const manifest: SupportBundleManifest = {
    schemaVersion: 1,
    bundle: bundleDirName,
    generatedAt,
    redaction: { policy: "platform-aware-v1" },
    privacy: triage.privacy,
    ...(manifestWarnings.length > 0 ? { warnings: manifestWarnings } : {}),
  };

  try {
    const manifestResult = writeRegularFile({
      path: safePath(bundleDir, "manifest.json"),
      content: JSON.stringify(manifest, null, 2),
      confinedBaseDir: dataDir,
    });
    if (!manifestResult.ok) {
      recordSectionFailure("manifest.json", describeError(manifestResult.error));
    }
  } catch (thrown) {
    recordSectionFailure("manifest.json", describeError(thrown));
  }

  // The returned set includes a manifest-write failure (which the on-disk
  // manifest cannot record about itself).
  return ok({ bundleDir, warnings: [...incoming, ...sectionWarnings] });
}
