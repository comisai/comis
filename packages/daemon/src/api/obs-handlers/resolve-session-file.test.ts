// SPDX-License-Identifier: Apache-2.0
/**
 * Real-layout tests for `resolveSessionFilePath` — the public pointer-based
 * sessionKey → session `.jsonl` resolver.
 *
 * The layout IS the contract (AGENTS.md §2.10): each test builds the ACTUAL
 * nested production tree
 * (`<dataDir>/workspace/sessions/<tenant>/<channel>/<file>.jsonl` + the
 * co-located `.trajectory-path.json` pointer + `_session-metadata.json`
 * companion) under a temp dir — NEVER `~/.comis` — and drives the real
 * resolver. A fixture-only test that injects clean flat paths proves the
 * logic, not the path resolution; a flat `<dataDir>/sessions/<id>.jsonl`
 * base NEVER exists on disk, so this resolver must land the real workspace
 * file via the pointer discipline or honestly return `undefined`.
 *
 * `path.join` is test-only-legal here (the no-path.join rule scopes to
 * non-test src); the resolver under test uses the production `safePath`.
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeTrajectoryPointerFileBestEffort } from "@comis/observability";
import { resolveSessionFilePath } from "./obs-explain-readers.js";

// A production-shaped session key — maps to tenant "default", channel
// "678314278", file "678314278~peer~678314278.jsonl" (userId[~peer~peerId]).
const SESSION_KEY = "default:678314278:678314278:peer:678314278";
const REAL_TENANT = "default";
const REAL_CHANNEL = "678314278";
const REAL_SESSION_FILE = "678314278~peer~678314278.jsonl";

const tmpDirs: string[] = [];

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-session-file-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build the REAL production session directory for SESSION_KEY under a temp
 * dataDir. Writes the `.jsonl`, a runtime trajectory, the pointer (via the
 * production writer), and the `_session-metadata.json` companion. Returns the
 * absolute session `.jsonl` path. When `runtimeFile` is supplied, the pointer
 * targets it (used to prove the resolver keys on the pointer tree, not a
 * co-location assumption).
 */
function buildRealSession(dataDir: string, runtimeFile?: string): string {
  const dir = path.join(dataDir, "workspace", "sessions", REAL_TENANT, REAL_CHANNEL);
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, REAL_SESSION_FILE);
  fs.writeFileSync(sessionFile, "", "utf-8");

  const runtime = runtimeFile ?? `${sessionFile}.trajectory.jsonl`;
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(
    runtime,
    JSON.stringify({ traceSchema: "comis-trajectory", type: "model.completed", seq: 1, data: {} }) + "\n",
    "utf-8",
  );

  writeTrajectoryPointerFileBestEffort({ sessionFile, sessionId: SESSION_KEY, runtimeFile: runtime });

  fs.writeFileSync(
    sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
    JSON.stringify({ sessionEnd: { type: "session_end", endReason: "completed", degraded: false } }),
    "utf-8",
  );
  return sessionFile;
}

describe("resolveSessionFilePath — real nested layout (pointer discipline)", () => {
  it("resolves a formatted sessionKey to its REAL workspace .jsonl (never the flat <dataDir>/sessions guess)", () => {
    const dataDir = tmpDataDir();
    const realSessionFile = buildRealSession(dataDir);

    const resolved = resolveSessionFilePath(dataDir, SESSION_KEY);

    expect(resolved).toBe(realSessionFile);
    // It lands under <dataDir>/workspace/sessions/..., NOT the flat path the
    // broken /export-trajectory closure built.
    expect(resolved!.startsWith(path.join(dataDir, "workspace", "sessions"))).toBe(true);
    const flatGuess = path.join(dataDir, "sessions");
    expect(resolved!.startsWith(flatGuess + path.sep)).toBe(false);
  });

  it("returns undefined for a sessionKey with NO on-disk artifacts (does not fabricate a flat path)", () => {
    const dataDir = tmpDataDir(); // no workspace/sessions tree written
    expect(resolveSessionFilePath(dataDir, SESSION_KEY)).toBeUndefined();
  });

  it("returns undefined for a non-parseable sessionKey", () => {
    const dataDir = tmpDataDir();
    buildRealSession(dataDir);
    // A bare token with no colon segments is not a formatted sessionKey.
    expect(resolveSessionFilePath(dataDir, "not-a-session-key")).toBeUndefined();
  });

  it("keys on the pointer tree — a NON-co-located runtimeFile still resolves the session .jsonl (level-1 is the .jsonl, runtime is the exporter's concern)", () => {
    const dataDir = tmpDataDir();
    // The pointer's runtimeFile lives in a separate directory, not the
    // co-located <sessionFile>.trajectory.jsonl sibling.
    const foreignRuntime = path.join(dataDir, "workspace", "trajectories", "elsewhere.trajectory.jsonl");
    const realSessionFile = buildRealSession(dataDir, foreignRuntime);
    // Prove the co-located sibling is genuinely absent, so a co-location
    // assumption would fail — only pointer-tree resolution can succeed.
    expect(fs.existsSync(`${realSessionFile}.trajectory.jsonl`)).toBe(false);

    const resolved = resolveSessionFilePath(dataDir, SESSION_KEY);
    expect(resolved).toBe(realSessionFile);
  });
});

describe("resolveSessionFilePath — webhook lossy-key resolution via the pointer sessionId", () => {
  // A webhook session's SessionKey has a colon-bearing userId
  // ({tenantId:"default", userId:"hook:devtask:wh1", channelId:"webhook"}). The
  // formatted key "default:hook:devtask:wh1:webhook" is greedily mis-split by
  // parseFormattedSessionKey, so the fast path computes a non-existent file.
  // The resolver must fall back to the AUTHORITATIVE on-disk record — the
  // pointer whose `sessionId` carries the verbatim formatted key.
  const WH_KEY = "default:hook:devtask:wh1:webhook";
  const WH_TENANT = "default";
  const WH_CHANNEL = "webhook";
  // sessionKeyToPath encoding of userId "hook:devtask:wh1" (":" → "@3a").
  const WH_FILE = "hook@3adevtask@3awh1.jsonl";

  it("resolves the webhook .jsonl via the pointer's verbatim sessionId (fast path misses on the mis-split key)", () => {
    const dataDir = tmpDataDir();
    const dir = path.join(dataDir, "workspace", "sessions", WH_TENANT, WH_CHANNEL);
    fs.mkdirSync(dir, { recursive: true });
    const sessionFile = path.join(dir, WH_FILE);
    fs.writeFileSync(sessionFile, "", "utf-8");
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: WH_KEY,
      runtimeFile: `${sessionFile}.trajectory.jsonl`,
    });

    const resolved = resolveSessionFilePath(dataDir, WH_KEY);
    expect(resolved).toBe(sessionFile);
    expect(resolved!.startsWith(path.join(dataDir, "workspace", "sessions"))).toBe(true);
  });
});
