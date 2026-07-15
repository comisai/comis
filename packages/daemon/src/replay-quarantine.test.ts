// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { EnvPort } from "@comis/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseReplayRestoreAttestation,
  replayDataDirSha256,
  reportReplayBootError,
  resolveDaemonBootIntent,
  selectDaemonEntrypointAction,
  startReplayQuarantine,
  type ReplayEnvironmentRolePort,
  type ReplayBootIntent,
  type ReplayRestoreAttestation,
  type ReplayRestoreAttestationPort,
  type ReplaySignalPort,
} from "./replay-quarantine.js";

function makeEnv(seed: Readonly<Record<string, string | undefined>>): EnvPort {
  return { get: (key) => seed[key] };
}

function makeRole(role: "production" | "test"): ReplayEnvironmentRolePort {
  return { read: async () => ({ ok: true, value: role }) };
}

function makeRestoreAttestation(cloneRoot: string): ReplayRestoreAttestation {
  return {
    schemaVersion: 1,
    state: "committed",
    dataDirSha256: replayDataDirSha256(cloneRoot),
    snapshotManifestSha256: "a".repeat(64),
    restoredDataTreeDigestSha256: "b".repeat(64),
    sourceEnvironmentEvidenceIdentitySha256: "c".repeat(64),
    effectiveEnvironmentContentSha256: "d".repeat(64),
    dataEntryCount: 7,
    dataBytes: 64,
  };
}

function makeRestorePort(cloneRoot: string): ReplayRestoreAttestationPort {
  return {
    read: async () => ({ ok: true, value: makeRestoreAttestation(cloneRoot) }),
  };
}

function inventory(root: string): string {
  const rows: string[] = [`root\0${lstatSync(root).mode & 0o7777}`];
  function walk(directory: string, relativeDirectory: string): void {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const absolutePath = resolve(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const stat = lstatSync(absolutePath);
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        rows.push(`directory\0${relativePath}\0${mode}`);
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const digest = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
        rows.push(`file\0${relativePath}\0${mode}\0${stat.size}\0${digest}`);
      } else if (stat.isSymbolicLink()) {
        rows.push(`symlink\0${relativePath}\0${mode}`);
      }
    }
  }
  walk(root, "");
  return rows.join("\n");
}

function createFakeSignals(): ReplaySignalPort & {
  readonly handlers: Map<"SIGINT" | "SIGTERM", () => void>;
} {
  const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  return {
    handlers,
    on: (signal, handler) => handlers.set(signal, handler),
    off: (signal, handler) => {
      if (handlers.get(signal) === handler) handlers.delete(signal);
    },
  };
}

describe("replay quarantine boot intent", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeRoots(): { cloneRoot: string; runtimeRoot: string } {
    const parent = mkdtempSync(resolve(tmpdir(), "comis-replay-intent-"));
    roots.push(parent);
    const cloneRoot = resolve(parent, "clone");
    const runtimeRoot = resolve(parent, "runtime");
    mkdirSync(cloneRoot);
    mkdirSync(runtimeRoot);
    return { cloneRoot, runtimeRoot };
  }

  it("allows live startup only from a trusted production role without a replay flag", async () => {
    const result = await resolveDaemonBootIntent(makeEnv({}), makeRole("production"));

    expect(result).toEqual({ ok: true, value: { kind: "live" } });
  });

  it("reads the trusted machine role before consulting replay intent", async () => {
    const order: string[] = [];
    const role: ReplayEnvironmentRolePort = {
      read: async () => {
        order.push("role");
        return { ok: false, error: { kind: "environment_role_untrusted", message: "untrusted" } };
      },
    };
    const env: EnvPort = {
      get: () => {
        order.push("env");
        return "1";
      },
    };

    const result = await resolveDaemonBootIntent(env, role);

    expect(result.ok).toBe(false);
    expect(order).toEqual(["role"]);
  });

  it("requires replay quarantine on test machines and forbids it everywhere else", async () => {
    const testWithoutReplay = await resolveDaemonBootIntent(makeEnv({}), makeRole("test"));
    expect(testWithoutReplay.ok).toBe(false);
    if (!testWithoutReplay.ok) {
      expect(testWithoutReplay.error.kind).toBe("replay_required_on_test");
    }

    for (const value of ["1", "true", "0", ""]) {
      const productionReplay = await resolveDaemonBootIntent(
        makeEnv({ COMIS_REPLAY_TARGET: value }),
        makeRole("production"),
      );
      expect(productionReplay.ok).toBe(false);
      if (!productionReplay.ok) {
        expect(productionReplay.error.kind).toBe("replay_forbidden_on_production");
      }
    }
  });

  it("accepts only the exact replay flag and canonical distinct roots", async () => {
    const { cloneRoot, runtimeRoot } = makeRoots();
    const result = await resolveDaemonBootIntent(
      makeEnv({
        COMIS_REPLAY_TARGET: "1",
        COMIS_DATA_DIR: `${cloneRoot}/../clone`,
        COMIS_REPLAY_RUNTIME_DIR: `${runtimeRoot}/.`,
      }),
      makeRole("test"),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "replay_quarantine",
        cloneRoot: realpathSync(cloneRoot),
        runtimeRoot: realpathSync(runtimeRoot),
      },
    });
  });

  it("fails closed for every non-exact replay flag value", async () => {
    for (const value of ["", "0", "true", "TRUE", " 1", "1 "]) {
      const result = await resolveDaemonBootIntent(
        makeEnv({ COMIS_REPLAY_TARGET: value }),
        makeRole("test"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid_replay_flag");
    }
  });

  it("rejects overlapping and symlinked quarantine roots", async () => {
    const { cloneRoot, runtimeRoot } = makeRoots();
    const nestedRuntime = resolve(cloneRoot, "runtime");
    mkdirSync(nestedRuntime);
    const nested = await resolveDaemonBootIntent(
      makeEnv({
        COMIS_REPLAY_TARGET: "1",
        COMIS_DATA_DIR: cloneRoot,
        COMIS_REPLAY_RUNTIME_DIR: nestedRuntime,
      }),
      makeRole("test"),
    );
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error.kind).toBe("overlapping_replay_roots");

    const linkedRuntime = resolve(resolve(runtimeRoot, ".."), "runtime-link");
    symlinkSync(runtimeRoot, linkedRuntime);
    const linked = await resolveDaemonBootIntent(
      makeEnv({
        COMIS_REPLAY_TARGET: "1",
        COMIS_DATA_DIR: cloneRoot,
        COMIS_REPLAY_RUNTIME_DIR: linkedRuntime,
      }),
      makeRole("test"),
    );
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.error.kind).toBe("replay_root_symlink");
  });

  it("forbids last-known-good restoration before a replay target starts", () => {
    const intent: ReplayBootIntent = {
      kind: "replay_quarantine",
      cloneRoot: "/srv/comis-clone",
      runtimeRoot: "/run/comis-replay",
    };

    const action = selectDaemonEntrypointAction(intent, true);

    expect(action.ok).toBe(false);
    if (!action.ok) {
      expect(action.error.kind).toBe("restore_forbidden_in_replay");
      const error = vi.fn();
      reportReplayBootError({ info: vi.fn(), error }, action.error);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: expect.stringContaining("production-role startup"),
        }),
        "Replay target boot rejected",
      );
    }
  });

  it("consumes one sealed restore attestation without traversing or changing clone state", async () => {
    const { cloneRoot, runtimeRoot } = makeRoots();
    const nested = resolve(cloneRoot, "workspace", "sessions", "tenant", "telegram");
    mkdirSync(nested, { recursive: true });
    const configPath = resolve(cloneRoot, "config.yaml");
    const dbPath = resolve(cloneRoot, "memory.db");
    const sessionPath = resolve(nested, "session.jsonl");
    writeFileSync(configPath, "gateway:\n  enabled: true\n", { mode: 0o640 });
    writeFileSync(dbPath, Buffer.from([0, 1, 2, 3, 255]), { mode: 0o600 });
    writeFileSync(sessionPath, '{"role":"user","content":"hello"}\n', { mode: 0o600 });
    chmodSync(resolve(cloneRoot, "workspace"), 0o750);
    const before = inventory(cloneRoot);
    const beforeAtime = lstatSync(sessionPath).atimeMs;
    const signals = createFakeSignals();
    const info = vi.fn();
    const error = vi.fn();
    const restoreAttestation = makeRestorePort(cloneRoot);
    const readRestoreAttestation = vi.spyOn(restoreAttestation, "read");
    let now = 100;

    const result = await startReplayQuarantine(
      { kind: "replay_quarantine", cloneRoot, runtimeRoot },
      {
        clock: { now: () => (now += 7), nowDate: () => new Date(now) },
        signals,
        logger: { info, error },
        restoreAttestation,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("replay_quarantine");
    expect(Object.keys(result.value).sort()).toEqual([
      "attestation",
      "closed",
      "kind",
      "shutdownHandle",
    ]);
    expect(result.value).not.toHaveProperty("container");
    expect(result.value).not.toHaveProperty("gatewayHandle");
    expect(result.value).not.toHaveProperty("channelManager");
    expect(result.value).not.toHaveProperty("deliveryQueue");
    expect(result.value).not.toHaveProperty("browserServices");
    expect(result.value.attestation).toMatchObject({
      dataEntryCount: 7,
      dataBytes: 64,
      snapshotManifestSha256: "a".repeat(64),
      restoredDataTreeDigestSha256: "b".repeat(64),
      sourceEnvironmentEvidenceIdentitySha256: "c".repeat(64),
      effectiveEnvironmentContentSha256: "d".repeat(64),
    });
    expect(readRestoreAttestation).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 7, dataEntryCount: 7 }),
      "Replay target quarantined",
    );
    const loggedFields = info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(loggedFields).not.toHaveProperty("cloneRoot");
    expect(loggedFields).not.toHaveProperty("runtimeRoot");
    expect(loggedFields).not.toHaveProperty("cloneDigest");
    expect(JSON.stringify(loggedFields)).not.toContain(cloneRoot);
    expect(JSON.stringify(loggedFields)).not.toContain(runtimeRoot);
    expect(JSON.stringify(loggedFields)).not.toContain("a".repeat(64));
    expect(JSON.stringify(loggedFields)).not.toContain("b".repeat(64));
    expect(error).not.toHaveBeenCalled();
    expect(inventory(cloneRoot)).toBe(before);
    expect(lstatSync(sessionPath).atimeMs).toBe(beforeAtime);
    expect(readdirSync(runtimeRoot)).toEqual([]);

    await result.value.shutdownHandle.trigger();
    await result.value.closed;
    expect(info.mock.calls[1]?.[0]).toEqual({ durationMs: 14 });
    expect(signals.handlers.size).toBe(0);
    expect(inventory(cloneRoot)).toBe(before);
    expect(readdirSync(runtimeRoot)).toEqual([]);
  });

  it("rejects a sealed restore attestation bound to a different data directory", async () => {
    const { cloneRoot, runtimeRoot } = makeRoots();
    const mismatched = makeRestoreAttestation(cloneRoot);
    const restoreAttestation: ReplayRestoreAttestationPort = {
      read: async () => ({
        ok: true,
        value: { ...mismatched, dataDirSha256: "c".repeat(64) },
      }),
    };

    const result = await startReplayQuarantine(
      { kind: "replay_quarantine", cloneRoot, runtimeRoot },
      {
        clock: { now: () => 1, nowDate: () => new Date(1) },
        signals: createFakeSignals(),
        logger: { info: vi.fn(), error: vi.fn() },
        restoreAttestation,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("restore_attestation_mismatch");
  });

  it("strictly parses only content-free committed restore attestations", () => {
    const { cloneRoot } = makeRoots();
    const attestation = makeRestoreAttestation(cloneRoot);
    const parsed = parseReplayRestoreAttestation(JSON.stringify(attestation));
    expect(parsed).toEqual({ ok: true, value: attestation });

    expect(parseReplayRestoreAttestation(JSON.stringify({ ...attestation, cloneRoot })).ok).toBe(false);
    expect(parseReplayRestoreAttestation(JSON.stringify({ ...attestation, state: "pending" })).ok).toBe(false);
    expect(
      parseReplayRestoreAttestation(JSON.stringify({ ...attestation, dataBytes: -1 })).ok,
    ).toBe(false);
  });
});
