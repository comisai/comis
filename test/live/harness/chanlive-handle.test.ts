// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for `chanlive-handle.ts` — the CLI-01 lifecycle primitives the
 * `chan`/`tg` CLI (Plan 05) and the standalone-rig launcher (Plan 04) both use
 * (Phase 205, Plan 03).
 *
 * Two suites:
 *   1. `handlePath` / `writeHandle` / `readHandle` — the per-channel handle file
 *      (`~/.comis-chanlive/<channel>.json`) round-trip: path shape, write→read
 *      equality, the `0600` mode bits (the admin-scoped gateway token must not
 *      leak off-box — T-205-07), and the honest `undefined` on absence (never a
 *      throw). The home-dir base is INJECTABLE so the test never touches the
 *      operator's real `~/.comis-chanlive`.
 *   2. `resolveEndpoint` / `probeHealth` — the resolution precedence
 *      (`--endpoint` › `COMIS_CHANLIVE_ENDPOINT` env › handle file, `undefined`
 *      when none — the honest dead-handle, T-205-08) + the bounded GET /health
 *      discover-or-spawn signal (true on 200, false on any throw / non-200 /
 *      timeout).
 *
 * Pure file-I/O against temp dirs + a throwaway loopback `node:http` server —
 * no daemon, no key, no real network (the only "network" is loopback `fetch`
 * against `127.0.0.1:<port>`). The handle shape is the contract the launcher
 * (Plan 04) writes and the CLI (Plan 05) reads.
 *
 * TEST-HARNESS — lives under the test tree, never the packages source tree;
 * ZERO production code change. `mkdtempSync` / `writeFileSync` / `statSync` /
 * `process.env` / raw `throw` are all fine here (outside every packages
 * source-tree architecture rule).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`,
 * collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/harness/chanlive-handle.test.ts
 *
 * @module
 */

import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handlePath,
  writeHandle,
  readHandle,
  resolveEndpoint,
  probeHealth,
  type ChanliveHandle,
} from "./chanlive-handle.js";

// ---------------------------------------------------------------------------
// A representative handle — the three endpoints + the SECRET gateway token +
// the fixed chat id + the throwaway data dir (the Plan-04 launcher records
// exactly this shape; the Plan-05 CLI reads it).
// ---------------------------------------------------------------------------

function makeHandle(overrides: Partial<ChanliveHandle> = {}): ChanliveHandle {
  return {
    channel: "telegram",
    controlEndpoint: "http://127.0.0.1:41001",
    rigControlEndpoint: "http://127.0.0.1:41002",
    gatewayUrl: "http://127.0.0.1:41003",
    gatewayToken: "test-secret-key-for-integration-tests",
    chatId: 424242,
    dataDir: "/tmp/comis-rig-data-example",
    memoryDbPath: "/tmp/comis-rig-data-example/memory.db",
    ...overrides,
  };
}

describe("chanlive-handle — handle file write/read round-trip (CLI-01)", () => {
  let baseDir: string;

  beforeEach(() => {
    // An injected base dir so the test NEVER writes into the operator's real
    // ~/.comis-chanlive (the handle carries the admin-scoped gateway token).
    baseDir = mkdtempSync(join(tmpdir(), "comis-chanlive-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("handlePath returns <homedir>/.comis-chanlive/<channel>.json by default", () => {
    const path = handlePath("telegram");
    // Default base lives under the home dir's .comis-chanlive directory.
    expect(path.endsWith(join(".comis-chanlive", "telegram.json"))).toBe(true);
    expect(path).toContain(".comis-chanlive");
  });

  it("handlePath honors an injected baseDir for the channel json", () => {
    expect(handlePath("telegram", baseDir)).toBe(join(baseDir, "telegram.json"));
  });

  it("writeHandle then readHandle round-trips the handle back equal", () => {
    const handle = makeHandle();
    writeHandle(handle, baseDir);
    const round = readHandle("telegram", baseDir);
    expect(round).toEqual(handle);
  });

  it("writeHandle creates the handle directory when it does not yet exist", () => {
    const nestedBase = join(baseDir, "deep", "not-yet-created");
    expect(existsSync(nestedBase)).toBe(false);
    writeHandle(makeHandle(), nestedBase);
    expect(existsSync(join(nestedBase, "telegram.json"))).toBe(true);
  });

  it("writeHandle chmods the handle file 0600 so the gateway token cannot leak off-box", () => {
    writeHandle(makeHandle(), baseDir);
    const path = join(baseDir, "telegram.json");
    // The admin-scoped gateway token must be owner-only (T-205-07 / §13-Q7 / V12).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("readHandle returns undefined when no handle file exists (honest absence, never throws)", () => {
    expect(readHandle("telegram", baseDir)).toBeUndefined();
  });

  it("readHandle keys per channel — a different channel does not read another channel's handle", () => {
    writeHandle(makeHandle({ channel: "telegram" }), baseDir);
    expect(readHandle("telegram", baseDir)).toBeDefined();
    expect(readHandle("discord", baseDir)).toBeUndefined();
  });
});

describe("chanlive-handle — resolveEndpoint precedence + probeHealth (CLI-01, discover-or-spawn)", () => {
  let baseDir: string;
  let priorEnv: string | undefined;
  let hadEnv: boolean;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "comis-chanlive-resolve-"));
    // Save + clear COMIS_CHANLIVE_ENDPOINT so each precedence case is hermetic.
    hadEnv = process.env["COMIS_CHANLIVE_ENDPOINT"] !== undefined;
    priorEnv = process.env["COMIS_CHANLIVE_ENDPOINT"];
    delete process.env["COMIS_CHANLIVE_ENDPOINT"];
  });

  afterEach(() => {
    // Restore the env exactly.
    if (hadEnv) process.env["COMIS_CHANLIVE_ENDPOINT"] = priorEnv;
    else delete process.env["COMIS_CHANLIVE_ENDPOINT"];
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("resolveEndpoint returns the --endpoint flag above everything (env + file)", () => {
    // Set BOTH the env and a file — the flag must still win.
    process.env["COMIS_CHANLIVE_ENDPOINT"] = "http://env-should-lose";
    writeHandle(makeHandle({ rigControlEndpoint: "http://file-should-lose" }), baseDir);
    expect(
      resolveEndpoint("telegram", { flagEndpoint: "http://flag-wins", baseDir }),
    ).toBe("http://flag-wins");
  });

  it("resolveEndpoint falls to COMIS_CHANLIVE_ENDPOINT env when no flag (env beats the file)", () => {
    process.env["COMIS_CHANLIVE_ENDPOINT"] = "http://env-wins";
    writeHandle(makeHandle({ rigControlEndpoint: "http://file-should-lose" }), baseDir);
    expect(resolveEndpoint("telegram", { baseDir })).toBe("http://env-wins");
  });

  it("resolveEndpoint falls to the handle file's rigControlEndpoint when no flag and no env", () => {
    writeHandle(makeHandle({ rigControlEndpoint: "http://127.0.0.1:49999" }), baseDir);
    expect(resolveEndpoint("telegram", { baseDir })).toBe("http://127.0.0.1:49999");
  });

  it("resolveEndpoint returns undefined with no flag, no env, no file (honest dead-handle)", () => {
    // → the CLI maps this to a dead-handle error suggesting `tg up`, NEVER a
    //   silent spawn (T-205-08 / design §5.1).
    expect(resolveEndpoint("telegram", { baseDir })).toBeUndefined();
  });

  it("probeHealth resolves true when GET <url>/health returns 200", async () => {
    const { url, close } = await startHealthServer(200);
    try {
      await expect(probeHealth(url)).resolves.toBe(true);
    } finally {
      await close();
    }
  });

  it("probeHealth resolves false when GET <url>/health returns a non-200", async () => {
    const { url, close } = await startHealthServer(503);
    try {
      await expect(probeHealth(url)).resolves.toBe(false);
    } finally {
      await close();
    }
  });

  it("probeHealth resolves false (no throw) for a dead/closed endpoint within the bounded timeout", async () => {
    // A closed loopback port → fetch rejects (ECONNREFUSED) → honest false.
    const { url, close } = await startHealthServer(200);
    await close(); // close immediately so the port is dead.
    await expect(probeHealth(url, 1000)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A throwaway loopback /health server (test-only — node:http is free here).
// ---------------------------------------------------------------------------

async function startHealthServer(
  statusCode: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = statusCode;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return { url, close };
}

// Touch the direct-fs imports so an unused-import lint never fires before the
// SUT exists (the assertions above use them transitively).
void writeFileSync;
void readFileSync;
