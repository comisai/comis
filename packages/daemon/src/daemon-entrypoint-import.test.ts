// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./daemon.js", () => {
  throw new Error("live composition evaluated before replay state was resolved");
});

import { main } from "./daemon-entrypoint.js";
import { replayDataDirSha256 } from "./replay-quarantine.js";

describe("minimal daemon executable import boundary", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "comis-entrypoint-import-"));
  const cloneRoot = resolve(parent, "clone");
  const runtimeRoot = resolve(parent, "runtime");
  mkdirSync(cloneRoot);
  mkdirSync(runtimeRoot);

  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  it("imports and starts replay quarantine without evaluating live composition", async () => {
    const runtime = await main(
      {},
      {
        env: {
          get: (key: string) => {
            if (key === "COMIS_REPLAY_TARGET") return "1";
            if (key === "COMIS_DATA_DIR") return cloneRoot;
            if (key === "COMIS_REPLAY_RUNTIME_DIR") return runtimeRoot;
            return undefined;
          },
        },
        environmentRole: {
          read: async () => ({ ok: true, value: "test" }),
        },
        restoreAttestation: {
          read: async () => ({
            ok: true,
            value: {
              schemaVersion: 1,
              state: "committed",
              dataDirSha256: replayDataDirSha256(realpathSync(cloneRoot)),
              snapshotManifestSha256: "a".repeat(64),
              restoredDataTreeDigestSha256: "b".repeat(64),
              sourceEnvironmentEvidenceIdentitySha256: "c".repeat(64),
              effectiveEnvironmentContentSha256: "d".repeat(64),
              dataEntryCount: 1,
              dataBytes: 0,
            },
          }),
        },
        logger: { info: vi.fn(), error: vi.fn() },
      },
    );

    expect(runtime.kind).toBe("replay_quarantine");
    if (runtime.kind === "replay_quarantine") {
      await runtime.shutdownHandle.trigger();
    }
  });
});
