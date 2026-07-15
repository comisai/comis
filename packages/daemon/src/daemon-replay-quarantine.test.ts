// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./daemon-entrypoint.js";
import { replayDataDirSha256 } from "./replay-quarantine.js";

describe("daemon replay quarantine dispatch", () => {
  const originalEnv = process.env;
  let parentRoot: string;
  let cloneRoot: string;
  let runtimeRoot: string;

  function replayEntrypointDeps() {
    return {
      environmentRole: { read: async () => ({ ok: true as const, value: "test" as const }) },
      restoreAttestation: {
        read: async () => ({
          ok: true as const,
          value: {
            schemaVersion: 1 as const,
            state: "committed" as const,
            dataDirSha256: replayDataDirSha256(realpathSync(cloneRoot)),
            snapshotManifestSha256: "a".repeat(64),
            restoredDataTreeDigestSha256: "b".repeat(64),
            sourceEnvironmentEvidenceIdentitySha256: "c".repeat(64),
            effectiveEnvironmentContentSha256: "d".repeat(64),
            dataEntryCount: 1,
            dataBytes: 13,
          },
        }),
      },
      loadLiveDaemon: vi.fn(async () => {
        throw new Error("live composition must remain unloaded");
      }),
    };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    parentRoot = mkdtempSync(resolve(tmpdir(), "comis-daemon-replay-"));
    cloneRoot = resolve(parentRoot, "clone");
    runtimeRoot = resolve(parentRoot, "runtime");
    mkdirSync(cloneRoot);
    mkdirSync(runtimeRoot);
    writeFileSync(resolve(cloneRoot, "config.yaml"), "channels: {}\n", { mode: 0o640 });
    process.env["COMIS_REPLAY_TARGET"] = "1";
    process.env["COMIS_DATA_DIR"] = cloneRoot;
    process.env["COMIS_REPLAY_RUNTIME_DIR"] = runtimeRoot;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    rmSync(parentRoot, { recursive: true, force: true });
  });

  it("dispatches quarantine before native preflight and every live boot stage", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const preflightDoctor = vi.fn(async () => {
      throw new Error("native preflight must remain untouched");
    });
    const bootstrap = vi.fn(() => {
      throw new Error("live bootstrap must remain untouched");
    });

    const deps = replayEntrypointDeps();
    const runtime = await main({ preflightDoctor, bootstrap }, deps);

    expect(runtime.kind).toBe("replay_quarantine");
    expect(preflightDoctor).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(deps.loadLiveDaemon).not.toHaveBeenCalled();
    if (runtime.kind === "replay_quarantine") {
      expect(runtime).not.toHaveProperty("container");
      await runtime.shutdownHandle.trigger();
    }
    const emitted = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(emitted).not.toContain(cloneRoot);
    expect(emitted).not.toContain(runtimeRoot);
    expect(emitted).not.toContain("a".repeat(64));
    expect(emitted).not.toContain("b".repeat(64));
  });

  it("rejects a malformed replay flag before native preflight", async () => {
    process.env["COMIS_REPLAY_TARGET"] = "true";
    const preflightDoctor = vi.fn(async () => undefined);

    const deps = replayEntrypointDeps();
    await expect(main({ preflightDoctor }, deps)).rejects.toThrow("invalid_replay_flag");
    expect(preflightDoctor).not.toHaveBeenCalled();
    expect(deps.loadLiveDaemon).not.toHaveBeenCalled();
  });

  it("rejects test-role live startup before importing the live composition", async () => {
    delete process.env["COMIS_REPLAY_TARGET"];
    const deps = replayEntrypointDeps();

    await expect(main({}, deps)).rejects.toThrow("replay_required_on_test");

    expect(deps.loadLiveDaemon).not.toHaveBeenCalled();
  });

  it("reports an actionable constant error when the machine role is unavailable", async () => {
    const error = vi.fn();
    const loadLiveDaemon = vi.fn(async () => {
      throw new Error("live composition must remain unloaded");
    });

    await expect(
      main({}, {
        environmentRole: {
          read: async () => ({
            ok: false,
            error: {
              kind: "environment_role_unavailable",
              message: "Machine role marker is unavailable",
            },
          }),
        },
        logger: { info: vi.fn(), error },
        loadLiveDaemon,
      }),
    ).rejects.toThrow("environment_role_unavailable");

    expect(loadLiveDaemon).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("root-owned machine role") }),
      "Replay target boot rejected",
    );
  });
});
