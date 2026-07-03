// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle exporter pipeline.
 *
 * This file contains the `exportTrajectoryBundle` function and its private
 * helpers. It lives alongside `export.ts` in the same `trajectory/` directory
 * but is a separate module to keep `export.ts` under the 800-line architecture
 * cap. `export.ts` re-exports all public symbols from this file so barrel
 * consumers see a single import surface.
 *
 * **Privacy Warning:**
 * The bundle's `session-branch.json` file contains raw session content
 * (message text, tool inputs/outputs, PII). Bundles MUST be treated as
 * sensitive. The output directory is created with mode 0o700 and each
 * file with 0o600 to limit scope to the operator, but this is NOT
 * a substitute for redaction.
 *
 * **Bundle output path note:**
 * The bundle directory is written to `<workspaceDir>/trace-exports/`
 * (without an additional `.comis/` sub-prefix). Since `<workspaceDir>`
 * already terminates in `.comis/workspace` (or similar), appending
 * `.comis/` would produce an unusual nested path.
 *
 * `exportTrajectoryBundle` reads `trace.metadata`/`trace.artifacts` events
 * directly from the runtime trajectory JSONL.
 *
 * @module
 */

import { statSync, readFileSync } from "node:fs";
import { systemNowMs, systemDateFrom, safePath, systemGetEnv } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { ensureContainedDir, writeRegularFile } from "../shared/fs-safe.js";
import { resolveTrajectoryPointerFilePath } from "./paths.js";
import type { TrajectoryEvent } from "./types.js";
import {
  MAX_TRAJECTORY_RUNTIME_EVENTS,
  MAX_TRAJECTORY_TOTAL_EVENTS,
  MAX_TRAJECTORY_SESSION_FILE_BYTES,
  MAX_TRAJECTORY_WARNING_ROWS,
  buildTranscriptEvents,
  sortTrajectoryEvents,
  readSessionBranch,
  type TrajectoryBundleWarning,
  type TrajectoryBundleManifest,
} from "./export.js";
import {
  redactEventForExport,
  walkAndRedactStrings,
  redactString,
  substitutePathsInString,
  type RedactionOpts,
} from "../redact/value-shapes.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parameters for `exportTrajectoryBundle`.
 *
 * The caller is responsible for resolving `sessionFile` and `workspaceDir`
 * through `safePath`/`sessionKeyToPath` upstream. The exporter uses
 * `ensureContainedDir` defensively.
 */
export interface ExportTrajectoryBundleParams {
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly sessionFile: string;
  readonly workspaceDir: string;
  readonly traceId: string;
  readonly agentId: string;
  readonly tenantId?: string;
  /**
   * Optional ClockPort.now()-compatible clock injection for deterministic
   * test timestamps. Defaults to `systemNowMs` from `@comis/core`.
   */
  readonly clock?: () => number;
}

/** Error variants for `exportTrajectoryBundle`. */
export type ExportTrajectoryBundleError =
  | { readonly kind: "session-file-too-large"; readonly bytes: number }
  | { readonly kind: "session-file-not-readable"; readonly reason: string }
  | { readonly kind: "bundle-dir-create-failed"; readonly reason: string }
  | { readonly kind: "bundle-file-write-failed"; readonly file: string; readonly reason: string };

/** Success payload for `exportTrajectoryBundle`. */
export interface ExportTrajectoryBundleSuccess {
  readonly bundleDir: string;
  readonly manifest: TrajectoryBundleManifest;
}

// ---------------------------------------------------------------------------
// Private: readRuntimeTrajectory — soft-fail JSONL reader
// ---------------------------------------------------------------------------

interface RuntimeReadResult {
  readonly events: ReadonlyArray<TrajectoryEvent>;
  readonly runtimeFile?: string;
  readonly warnings: ReadonlyArray<TrajectoryBundleWarning>;
}

/**
 * Build a single `TrajectoryBundleWarning` value (local clone of the
 * export.ts private helper; exported here so readRuntimeTrajectory can use it
 * without a cross-file dependency on the private function in export.ts).
 *
 * @internal
 */
function buildWarningLocal(
  source: TrajectoryBundleWarning["source"],
  code: TrajectoryBundleWarning["code"],
  count: number,
  rows: number[],
  message: string,
): TrajectoryBundleWarning {
  return {
    source,
    code,
    count,
    rows: rows.slice(0, MAX_TRAJECTORY_WARNING_ROWS),
    message,
  };
}

/**
 * Read the runtime trajectory JSONL file for a session.
 *
 * Pointer-file resolution:
 *   1. Read `<sessionFile>.trajectory-path.json` (pointer file).
 *   2. If `traceSchema === "comis-trajectory-pointer"` && `schemaVersion === 1`
 *      → use `parsed.runtimeFile` as the absolute path.
 *   3. Else fall back to co-located `<sessionFile>.trajectory.jsonl`.
 *
 * File reading:
 *   - readFileSync as utf-8, split("\n"), parse each line.
 *   - Empty trailing lines are skipped.
 *   - JSON.parse failures → `invalid-runtime-json` warning per line.
 *   - Invalid envelope (traceSchema mismatch) → `invalid-runtime-event` warning.
 *   - Cap accepted events at MAX_TRAJECTORY_RUNTIME_EVENTS.
 *
 * Missing file → return empty events (soft-fail; trajectory may be disabled).
 * Never throws.
 *
 * @internal
 */
function readRuntimeTrajectory(sessionFile: string): RuntimeReadResult {
  // Step 1: try pointer file.
  let resolvedRuntimeFile: string | undefined;
  const pointerFilePath = resolveTrajectoryPointerFilePath(sessionFile);
  try {
    const pointerRaw = readFileSync(pointerFilePath, "utf-8");
    const pointer = JSON.parse(pointerRaw) as Record<string, unknown>;
    if (
      pointer["traceSchema"] === "comis-trajectory-pointer" &&
      pointer["schemaVersion"] === 1 &&
      typeof pointer["runtimeFile"] === "string" &&
      pointer["runtimeFile"].length > 0
    ) {
      resolvedRuntimeFile = pointer["runtimeFile"] as string;
    }
  } catch {
    // Pointer file absent or invalid — fall back to co-located convention.
    resolvedRuntimeFile = undefined;
  }

  // Step 2: co-located fallback.
  if (resolvedRuntimeFile === undefined) {
    resolvedRuntimeFile = `${sessionFile}.trajectory.jsonl`;
  }

  // Step 3: stat the resolved runtime file. Missing = soft-fail (empty events).
  try {
    statSync(resolvedRuntimeFile);
  } catch {
    return { events: [], runtimeFile: undefined, warnings: [] };
  }

  // Step 4: read + parse each line.
  let raw: string;
  try {
    raw = readFileSync(resolvedRuntimeFile, "utf-8");
  } catch {
    return { events: [], runtimeFile: resolvedRuntimeFile, warnings: [] };
  }

  const lines = raw.split("\n");
  const events: TrajectoryEvent[] = [];
  const jsonWarningRows: number[] = [];
  const eventWarningRows: number[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (line.trim().length === 0) continue; // skip empty trailing lines

    // Apply event cap before parsing to avoid unnecessary work.
    if (events.length >= MAX_TRAJECTORY_RUNTIME_EVENTS) {
      eventWarningRows.push(idx);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      jsonWarningRows.push(idx);
      continue;
    }

    // Validate envelope: must be comis-trajectory schema version 1.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>)["traceSchema"] !== "comis-trajectory" ||
      (parsed as Record<string, unknown>)["schemaVersion"] !== 1
    ) {
      eventWarningRows.push(idx);
      continue;
    }

    events.push(parsed as TrajectoryEvent);
  }

  // Build warnings.
  const warnings: TrajectoryBundleWarning[] = [];
  if (jsonWarningRows.length > 0) {
    warnings.push(
      buildWarningLocal(
        "runtime",
        "invalid-runtime-json",
        jsonWarningRows.length,
        jsonWarningRows,
        "Invalid JSON on runtime trajectory line",
      ),
    );
  }
  if (eventWarningRows.length > 0) {
    warnings.push(
      buildWarningLocal(
        "runtime",
        "invalid-runtime-event",
        eventWarningRows.length,
        eventWarningRows,
        events.length >= MAX_TRAJECTORY_RUNTIME_EVENTS
          ? "Runtime event cap exceeded (MAX_TRAJECTORY_RUNTIME_EVENTS)"
          : "Runtime trajectory event failed schema validation",
      ),
    );
  }

  return { events, runtimeFile: resolvedRuntimeFile, warnings };
}

// ---------------------------------------------------------------------------
// Private: buildSupplementalCaptures — 4 JSON/text captures from runtime events
// ---------------------------------------------------------------------------

interface SupplementalCaptures {
  readonly metadata: Record<string, unknown>;
  readonly artifacts: Record<string, unknown>;
  readonly prompts: {
    systemPrompt: string;
    userPromptPrefixText?: string;
    skills: unknown[];
  };
  readonly systemPromptText: string;
  readonly tools: Array<Record<string, unknown>>;
}

/**
 * Build the 4 supplemental bundle captures from runtime trajectory events.
 *
 * - `metadata`: latest `trace.metadata` event's `data`, or `{}`.
 * - `artifacts`: latest `trace.artifacts` event's `data`, or `{}`.
 * - `prompts`: `{ systemPrompt, userPromptPrefixText, skills }` from
 *   `trace.metadata.prompting` + `.skills`.
 * - `systemPromptText`: plain-text system prompt (same as `systemPrompt`).
 * - `tools`: tool defs from `tool.call` event `data`, sorted + dedup'd on
 *   `toolName`, bounded at 256 items.
 *
 * @internal
 */
function buildSupplementalCaptures(
  runtimeEvents: ReadonlyArray<TrajectoryEvent>,
): SupplementalCaptures {
  // Find the LAST trace.metadata and trace.artifacts events
  // (defense-in-depth takes the latest).
  let lastMetadataData: Record<string, unknown> = {};
  let lastArtifactsData: Record<string, unknown> = {};
  for (const e of runtimeEvents) {
    if (e.type === "trace.metadata" && e.data !== undefined) {
      lastMetadataData = e.data as Record<string, unknown>;
    }
    if (e.type === "trace.artifacts" && e.data !== undefined) {
      lastArtifactsData = e.data as Record<string, unknown>;
    }
  }

  // prompts: from trace.metadata.prompting + .skills.
  const promptingRaw =
    typeof lastMetadataData["prompting"] === "object" &&
    lastMetadataData["prompting"] !== null
      ? (lastMetadataData["prompting"] as Record<string, unknown>)
      : {};
  const systemPrompt =
    typeof promptingRaw["systemPrompt"] === "string"
      ? promptingRaw["systemPrompt"]
      : "";
  const userPromptPrefixText =
    typeof promptingRaw["userPromptPrefixText"] === "string"
      ? promptingRaw["userPromptPrefixText"]
      : undefined;
  const skills = Array.isArray(lastMetadataData["skills"])
    ? (lastMetadataData["skills"] as unknown[])
    : [];

  const prompts: { systemPrompt: string; userPromptPrefixText?: string; skills: unknown[] } = {
    systemPrompt,
    skills,
    ...(userPromptPrefixText !== undefined ? { userPromptPrefixText } : {}),
  };

  // system-prompt.txt: the plain-text full system prompt.
  // Ships what's available in the metadata event.
  const systemPromptText = systemPrompt;

  // tools: walk tool.call events, dedup on toolName, sort alphabetically,
  // cap at 256.
  const seenTools = new Map<string, Record<string, unknown>>();
  for (const e of runtimeEvents) {
    if (e.type !== "tool.call" || e.data === undefined) continue;
    const data = e.data as Record<string, unknown>;
    const name =
      typeof data["toolName"] === "string"
        ? data["toolName"]
        : typeof data["name"] === "string"
          ? data["name"]
          : undefined;
    if (name === undefined) continue;
    if (!seenTools.has(name)) {
      seenTools.set(name, { name, ...data });
    }
  }
  const tools = [...seenTools.values()]
    .sort((a, b) => String(a["name"]).localeCompare(String(b["name"])))
    .slice(0, 256);

  return {
    metadata: lastMetadataData,
    artifacts: lastArtifactsData,
    prompts,
    systemPromptText,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Private: capWarnings — group-by-code and cap rows per warning code
// ---------------------------------------------------------------------------

/**
 * Merge a flat warnings list: group by `source:code`, accumulate `count`,
 * cap `rows` at MAX_TRAJECTORY_WARNING_ROWS per code.
 *
 * @internal
 */
function capWarnings(
  warnings: ReadonlyArray<TrajectoryBundleWarning>,
): TrajectoryBundleWarning[] {
  const byKey = new Map<string, TrajectoryBundleWarning>();
  for (const w of warnings) {
    const key = `${w.source}:${w.code}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        ...w,
        rows: w.rows.slice(0, MAX_TRAJECTORY_WARNING_ROWS),
      });
    } else {
      const mergedRows = [...existing.rows, ...w.rows].slice(
        0,
        MAX_TRAJECTORY_WARNING_ROWS,
      );
      byKey.set(key, {
        ...existing,
        count: existing.count + w.count,
        rows: mergedRows,
      });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// exportTrajectoryBundle — main pipeline
// ---------------------------------------------------------------------------

/**
 * Export a trajectory bundle: stat the session file, read the branch, read
 * the runtime trajectory, synthesize transcript events, merge-sort, build
 * 4 supplemental captures, write an 8-file directory with mode 0o700 +
 * auto-populated manifest.contents.
 *
 * **8-file bundle:**
 * | Filename           | MediaType            | Source                          |
 * |--------------------|----------------------|---------------------------------|
 * | manifest.json      | application/json     | TrajectoryBundleManifest        |
 * | events.jsonl       | application/x-ndjson | merged+sorted runtime+transcript|
 * | session-branch.json| application/json     | readSessionBranch result        |
 * | metadata.json      | application/json     | latest trace.metadata.data      |
 * | artifacts.json     | application/json     | latest trace.artifacts.data     |
 * | prompts.json       | application/json     | prompting + skills from metadata|
 * | system-prompt.txt  | text/plain           | system prompt plain text        |
 * | tools.json         | application/json     | dedup'd tool.call data          |
 *
 * **Output path:** `<workspaceDir>/trace-exports/comis-trace-<sid8>-<ts>/`
 *
 * **Pipeline steps:**
 *   1. statSync session file — refuse if > MAX_TRAJECTORY_SESSION_FILE_BYTES.
 *   2. readSessionBranch → branch + warnings.
 *   3. readRuntimeTrajectory → runtime events + runtimeFile path + warnings.
 *   4. buildTranscriptEvents from branch entries.
 *   5. sortTrajectoryEvents([...runtime, ...transcript]).
 *   6. Apply total event cap (MAX_TRAJECTORY_TOTAL_EVENTS).
 *   7. buildSupplementalCaptures from runtime events.
 *   8. ensureContainedDir × 2 → bundle directory (mode 0o700).
 *   9. Write 7 content files via writeRegularFile (mode 0o600).
 *  10. Write manifest.json last with auto-populated contents (2-pass for self-size).
 *
 * @public
 */
export async function exportTrajectoryBundle(
  params: ExportTrajectoryBundleParams,
): Promise<Result<ExportTrajectoryBundleSuccess, ExportTrajectoryBundleError>> {
  // Step 1: stat session file.
  let sessionStat: { size: number };
  try {
    sessionStat = statSync(params.sessionFile);
  } catch {
    return err({ kind: "session-file-not-readable" as const, reason: "stat failed" });
  }
  if (sessionStat.size > MAX_TRAJECTORY_SESSION_FILE_BYTES) {
    return err({ kind: "session-file-too-large" as const, bytes: sessionStat.size });
  }

  // Step 2: readSessionBranch.
  const branchResult = readSessionBranch(params.sessionFile);
  const { branchEntries, header: sessionHeader, leafId: sessionLeafId } = branchResult;

  // Step 3: readRuntimeTrajectory.
  const runtimeRead = readRuntimeTrajectory(params.sessionFile);

  // Step 4: buildTranscriptEvents from branch.
  const transcriptEvents = buildTranscriptEvents(
    branchEntries.map((e) => ({
      id: e.id,
      parentId: e.parentId,
      timestamp: e.timestamp,
      type: e.type,
    })),
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      traceId: params.traceId,
      agentId: params.agentId,
      tenantId: params.tenantId,
      workspaceDir: params.workspaceDir,
    },
  );

  // Step 5: merge + sort.
  const allEvents = [...runtimeRead.events, ...transcriptEvents];
  const sorted = sortTrajectoryEvents(allEvents);

  // Step 6: apply total event cap.
  const capped = sorted.slice(0, MAX_TRAJECTORY_TOTAL_EVENTS);
  const overflowWarnings: TrajectoryBundleWarning[] =
    sorted.length > capped.length
      ? [
          {
            source: "runtime" as const,
            code: "invalid-runtime-event" as const,
            count: sorted.length - capped.length,
            rows: [],
            message: "Total event count exceeded MAX_TRAJECTORY_TOTAL_EVENTS",
          },
        ]
      : [];

  // Step 6b: apply bundle-time redaction.
  // The 13 value-shape patterns plus path substitution apply to every
  // string-typed leaf in event.data. Number-typed fields (timestamps,
  // counts, seq) pass through untouched — prevents false positives on
  // numeric IDs.
  const homeDir = systemGetEnv("HOME");
  const redactionOpts: RedactionOpts = {
    workspaceDir: params.workspaceDir,
    homeDir,
    stateDir: homeDir !== undefined ? `${homeDir}/.comis` : undefined,
  };
  const redacted = capped.map((e) => redactEventForExport(e, redactionOpts));

  // Step 7: buildSupplementalCaptures.
  const captures = buildSupplementalCaptures(runtimeRead.events);

  // Step 8: compose bundle directory path.
  const clockFn = params.clock ?? systemNowMs;
  const nowMs = clockFn();
  const tsIso = systemDateFrom(nowMs).toISOString().replace(/[:.]/g, "-");
  const sid8 = params.sessionId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase();
  const bundleDirName = `comis-trace-${sid8}-${tsIso}`;

  // ensureContainedDir for the trace-exports parent, then the per-export dir.
  const traceExportsPath = safePath(params.workspaceDir, "trace-exports");
  const traceExportsResult = ensureContainedDir({
    dir: traceExportsPath,
    mode: 0o700,
  });
  if (!traceExportsResult.ok) {
    return err({
      kind: "bundle-dir-create-failed" as const,
      reason: String(
        (traceExportsResult.error as { code?: string }).code ??
          traceExportsResult.error?.message ??
          "unknown",
      ),
    });
  }

  const bundleDirPath = safePath(traceExportsPath, bundleDirName);
  const bundleDirResult = ensureContainedDir({
    dir: bundleDirPath,
    mode: 0o700,
  });
  if (!bundleDirResult.ok) {
    return err({
      kind: "bundle-dir-create-failed" as const,
      reason: String(
        (bundleDirResult.error as { code?: string }).code ??
          bundleDirResult.error?.message ??
          "unknown",
      ),
    });
  }

  const bundleDir = bundleDirPath;

  // Step 9: build all warnings combined.
  const allWarnings = capWarnings([
    ...branchResult.warnings,
    ...runtimeRead.warnings,
    ...overflowWarnings,
  ]);

  // Manifest base (without contents — added after writing content files).
  const manifestBase: Omit<TrajectoryBundleManifest, "contents"> = {
    traceSchema: "comis-trajectory" as const,
    schemaVersion: 1 as const,
    generatedAt: systemDateFrom(nowMs).toISOString(),
    traceId: params.traceId,
    sessionId: params.sessionId,
    ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
    workspaceDir: params.workspaceDir,
    leafId: sessionLeafId,
    eventCount: capped.length,
    runtimeEventCount: runtimeRead.events.length,
    transcriptEventCount: transcriptEvents.length,
    sourceFiles: {
      session: params.sessionFile,
      ...(runtimeRead.runtimeFile !== undefined
        ? { runtime: runtimeRead.runtimeFile }
        : {}),
    },
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    // Redaction policy fingerprint — bundle consumers use this to identify
    // which redaction pass was applied.
    redaction: { policy: "platform-aware-v1" },
  };

  // Step 10: write the 7 content files (manifest written last).
  const FILE_PLAN: ReadonlyArray<{
    name: string;
    mediaType: string;
    body: () => string;
  }> = [
    {
      name: "events.jsonl",
      mediaType: "application/x-ndjson",
      // Step 6b redacted array used here — not raw capped.
      body: () =>
        redacted.length > 0
          ? redacted.map((e) => JSON.stringify(e)).join("\n") + "\n"
          : "",
    },
    {
      name: "session-branch.json",
      mediaType: "application/json",
      // Defense-in-depth: apply walkAndRedactStrings to branchEntries so
      // message bodies inside SDK entries are redacted. header and leafId
      // are envelope identifiers — not content — so they are left unredacted.
      body: () =>
        JSON.stringify(
          {
            header: sessionHeader,
            leafId: sessionLeafId,
            branchEntries: walkAndRedactStrings(branchEntries, redactionOpts),
          },
          null,
          2,
        ),
    },
    {
      name: "metadata.json",
      mediaType: "application/json",
      // Defense-in-depth.
      body: () =>
        JSON.stringify(walkAndRedactStrings(captures.metadata, redactionOpts), null, 2),
    },
    {
      name: "artifacts.json",
      mediaType: "application/json",
      body: () =>
        JSON.stringify(walkAndRedactStrings(captures.artifacts, redactionOpts), null, 2),
    },
    {
      name: "prompts.json",
      mediaType: "application/json",
      body: () =>
        JSON.stringify(walkAndRedactStrings(captures.prompts, redactionOpts), null, 2),
    },
    {
      name: "system-prompt.txt",
      mediaType: "text/plain",
      // Single string leaf: apply redactString then substitutePathsInString.
      body: () =>
        substitutePathsInString(redactString(captures.systemPromptText), redactionOpts),
    },
    {
      name: "tools.json",
      mediaType: "application/json",
      body: () =>
        JSON.stringify(walkAndRedactStrings(captures.tools, redactionOpts), null, 2),
    },
  ];

  const contents: Array<{ path: string; mediaType: string; bytes: number }> = [];

  for (const { name, mediaType, body } of FILE_PLAN) {
    const filePath = safePath(bundleDir, name);
    const data = body();
    const writeResult = writeRegularFile({ path: filePath, content: data });
    if (!writeResult.ok) {
      return err({
        kind: "bundle-file-write-failed" as const,
        file: name,
        reason: String(
          (writeResult.error as { code?: string }).code ??
            writeResult.error?.message ??
            "unknown",
        ),
      });
    }
    contents.push({ path: name, mediaType, bytes: Buffer.byteLength(data, "utf8") });
  }

  // Step 11: write manifest.json as the 8th file.
  // Two-pass: write once to compute self-size, then re-write with the
  // correct bytes value for the manifest entry in contents.
  const manifestPath = safePath(bundleDir, "manifest.json");

  // Compose manifest with a placeholder self-size of 0.
  let manifestContents = [
    ...contents,
    { path: "manifest.json", mediaType: "application/json", bytes: 0 },
  ];
  let manifestObj: TrajectoryBundleManifest = {
    ...manifestBase,
    contents: manifestContents,
  };
  let manifestBody = JSON.stringify(manifestObj, null, 2);

  // Fixed-point iteration to converge on self-referential byte count
  // (up to 4 iterations; stabilises in ≤ 2 due to digit-width changes).
  for (let i = 0; i < 4; i++) {
    const measured = Buffer.byteLength(manifestBody, "utf8");
    const lastEntry = manifestContents[manifestContents.length - 1]!;
    if (lastEntry.bytes === measured) break;
    manifestContents = [
      ...manifestContents.slice(0, -1),
      { ...lastEntry, bytes: measured },
    ];
    manifestObj = { ...manifestBase, contents: manifestContents };
    manifestBody = JSON.stringify(manifestObj, null, 2);
  }

  const manifestWriteResult = writeRegularFile({
    path: manifestPath,
    content: manifestBody,
  });
  if (!manifestWriteResult.ok) {
    return err({
      kind: "bundle-file-write-failed" as const,
      file: "manifest.json",
      reason: String(
        (manifestWriteResult.error as { code?: string }).code ??
          manifestWriteResult.error?.message ??
          "unknown",
      ),
    });
  }

  return ok({ bundleDir, manifest: manifestObj });
}
