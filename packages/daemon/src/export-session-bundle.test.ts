// SPDX-License-Identifier: Apache-2.0
/**
 * Real-layout tests for `exportSessionBundleFromKey` — the testable unit behind
 * the `/export-trajectory` slash command's bundle export.
 *
 * The layout IS the contract (AGENTS.md §2.10): the end-to-end test builds the
 * ACTUAL nested `<dataDir>/workspace/sessions/<tenant>/<channel>/<file>.jsonl`
 * tree + the `.trajectory-path.json` pointer + a runtime trajectory under a temp
 * dir — NEVER `~/.comis` — and drives the REAL exporter. It proves the corrected
 * pointer resolution: the earlier flat `<dataDir>/sessions/<id>.jsonl` path never
 * existed on disk, so the export used to fail `session-file-not-readable` for
 * every real channel session.
 *
 * `path.join` is test-only-legal here; the unit under test resolves paths via
 * the production `resolveSessionFilePath`/`safePath`.
 *
 * @module
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ok } from "@comis/shared";
import { exportTrajectoryBundle, writeTrajectoryPointerFileBestEffort } from "@comis/observability";
import { exportSessionBundleFromKey } from "./export-session-bundle.js";

const SESSION_KEY = "default:agent:default:678314278:678314278:peer:678314278";
const REAL_TENANT = "default";
const REAL_CHANNEL = "678314278";
const REAL_SESSION_FILE = "678314278~peer~678314278.jsonl";

const tmpDirs: string[] = [];

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-session-bundle-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build the REAL production session layout and return the `.jsonl` path. */
function buildRealSession(dataDir: string): string {
  const dir = path.join(dataDir, "workspace", "sessions", REAL_TENANT, REAL_CHANNEL);
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, REAL_SESSION_FILE);
  fs.writeFileSync(sessionFile, "", "utf-8");

  const runtimeFile = `${sessionFile}.trajectory.jsonl`;
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ traceSchema: "comis-trajectory", type: "model.completed", seq: 1, data: {} }) + "\n",
    "utf-8",
  );
  writeTrajectoryPointerFileBestEffort({ sessionFile, sessionId: SESSION_KEY, runtimeFile });
  return sessionFile;
}

describe("exportSessionBundleFromKey — real nested layout, real exporter", () => {
  it("resolves the real session file via the pointer and writes the bundle under workspace/trace-exports", async () => {
    const dataDir = tmpDataDir();
    buildRealSession(dataDir);
    const workspaceDir = path.join(dataDir, "workspace");

    const result = await exportSessionBundleFromKey({ dataDir, workspaceDir, sessionId: SESSION_KEY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bundle lands under <workspaceDir>/trace-exports/comis-trace-<sid8>-<ts>/,
    // NOT a copy and NOT under a fabricated flat sessions path.
    expect(result.value.bundlePath.startsWith(path.join(workspaceDir, "trace-exports"))).toBe(true);
    expect(path.basename(result.value.bundlePath).startsWith("comis-trace-")).toBe(true);
    expect(fs.existsSync(path.join(result.value.bundlePath, "manifest.json"))).toBe(true);
  });
});

describe("exportSessionBundleFromKey — pointer-resolved sessionFile (injected exporter seam)", () => {
  it("feeds the exporter the REAL pointer-resolved .jsonl, never the flat <dataDir>/sessions guess", async () => {
    const dataDir = tmpDataDir();
    const realSessionFile = buildRealSession(dataDir);
    const workspaceDir = path.join(dataDir, "workspace");
    const fakeBundleDir = path.join(workspaceDir, "trace-exports", "comis-trace-deadbeef-1");

    const spy = vi.fn(async () => ok({ bundleDir: fakeBundleDir, manifest: {} }));

    const result = await exportSessionBundleFromKey({
      dataDir,
      workspaceDir,
      sessionId: SESSION_KEY,
      exportTrace: spy as unknown as typeof exportTrajectoryBundle,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const params = spy.mock.calls[0]![0] as { sessionFile: string; workspaceDir: string; sessionId: string };
    // The load-bearing fix: the exporter's sessionFile arg is the pointer-resolved
    // real path, not the flat <dataDir>/sessions/<id>.jsonl the old closure built.
    expect(params.sessionFile).toBe(realSessionFile);
    expect(params.sessionFile.startsWith(path.join(dataDir, "sessions") + path.sep)).toBe(false);
    expect(params.workspaceDir).toBe(workspaceDir);
    expect(params.sessionId).toBe(SESSION_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bundlePath).toBe(fakeBundleDir);
  });
});

describe("exportSessionBundleFromKey — unresolvable session", () => {
  it("returns a clear session-not-resolvable error and never calls the exporter (no flat-path stat)", async () => {
    const dataDir = tmpDataDir(); // no workspace/sessions tree written
    const workspaceDir = path.join(dataDir, "workspace");
    const spy = vi.fn(async () => ok({ bundleDir: "/never", manifest: {} }));

    const result = await exportSessionBundleFromKey({
      dataDir,
      workspaceDir,
      sessionId: SESSION_KEY,
      exportTrace: spy as unknown as typeof exportTrajectoryBundle,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session-not-resolvable");
    expect(spy).not.toHaveBeenCalled();
  });
});
