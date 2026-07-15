import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildProductionSnapshotPlan,
  parseProductionSnapshotManifest,
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";

const SOURCE_MACHINE = "a".repeat(64);
const FILE_HASH = "b".repeat(64);

function makeManifest(
  overrides: Partial<ProductionSnapshotManifest> = {},
): ProductionSnapshotManifest {
  return {
    schemaVersion: 1,
    runId: "capture-20260715-a1",
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "bounded-freeze",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_004_000,
    freezeDurationMs: 2_500,
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 4096 },
      {
        path: "data/.env",
        type: "file",
        mode: "0600",
        size: 84,
        sha256: FILE_HASH,
      },
      {
        path: "data/memory.db",
        type: "file",
        mode: "0600",
        size: 4096,
        sha256: FILE_HASH,
      },
      {
        path: "data/memory.db-wal",
        type: "file",
        mode: "0600",
        size: 2048,
        sha256: FILE_HASH,
      },
      {
        path: "data/models/python",
        type: "symlink",
        mode: "0777",
        size: 16,
        linkTarget: "/usr/bin/python3",
      },
      { path: "system", type: "directory", mode: "0700", size: 4096 },
      { path: "system/etc", type: "directory", mode: "0700", size: 4096 },
      { path: "system/etc/comis", type: "directory", mode: "0700", size: 4096 },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 72,
        sha256: FILE_HASH,
      },
    ],
    exclusions: [
      {
        path: "data/.daemon.lock",
        type: "file",
        mode: "0600",
        size: 12,
        reason: "daemon_lock",
      },
      {
        path: "data/memory.db-shm",
        type: "file",
        mode: "0600",
        size: 32768,
        reason: "sqlite_shm",
      },
      {
        path: "data/cap.sock",
        type: "socket",
        mode: "0770",
        size: 0,
        reason: "runtime_socket",
      },
    ],
    ...overrides,
  };
}

describe("production source snapshot seam", () => {
  it("builds a bounded freeze plan with an independent thaw watchdog and root-only staging", () => {
    const result = buildProductionSnapshotPlan({
      runId: "capture-20260715-a1",
      expectedMachineIdSha256: SOURCE_MACHINE,
      service: "comis",
      dataDir: "/home/comis/.comis",
      captureMode: "bounded-freeze",
      watchdogSeconds: 20,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stageDir).toBe("/run/comis-self-driving/capture-20260715-a1");
    expect(result.value.captureMode).toBe("bounded-freeze");
    expect(result.value.manifestPath).toBe(
      "/run/comis-self-driving/capture-20260715-a1/manifest.json",
    );
    expect(result.value.prepare.stdout).toBe("none");
    expect(result.value.stream.stdout).toBe("archive");
    expect(result.value.stream.stdin).toContain("tar --create --file=-");
    expect(result.value.stream.stdin).toContain("--acls");
    expect(result.value.stream.stdin).toContain("--xattrs");
    expect(result.value.stream.stdin).toContain("--numeric-owner");
    expect(result.value.stream.stdin).toContain("--hard-dereference");
    expect(result.value.stream.stdin).toContain("manifest.json");
    expect(result.value.stream.stdin).toContain("trap cleanup_stream EXIT HUP INT TERM");
    expect(result.value.stream.stdin).toContain('rm -rf -- "$stage_dir"');
    expect(result.value.prepare.args).toEqual([
      "sudo",
      "bash",
      "-s",
      "--",
      SOURCE_MACHINE,
      "comis",
      "/home/comis/.comis",
      "capture-20260715-a1",
      "bounded-freeze",
      "20",
    ]);

    const script = result.value.prepare.stdin;
    expect(script).toContain("findmnt");
    expect(script).toContain("tmpfs");
    expect(script).toContain("realpath -m");
    expect(script).toContain("snapshot run ID is unsafe");
    expect(script).toContain("stage_created=0");
    expect(script).toContain('[ "$stage_created" -eq 1 ]');
    expect(script).toContain("exec 1>/dev/null");
    expect(script).toContain("tree_fingerprint");
    expect(script).toContain("source persistent tree changed during capture");
    expect(script).toContain("runtime artifact path is unexpectedly a directory");
    expect(script).toContain(': > "$exclusion_list"');
    expect(script).toContain("install -d -m 0700 -o root -g root");
    expect(script).toContain("systemd-run");
    expect(script).toContain("--on-active");
    expect(script).toContain("systemctl freeze");
    expect(script).toContain("FreezerState");
    expect(script).toContain("systemctl thaw");
    expect(script).toContain("trap cleanup EXIT HUP INT TERM");
    expect(script).toContain("/etc/comis/env");
    expect(script).toContain("--acls");
    expect(script).toContain("--xattrs");
    expect(script).toContain("--numeric-owner");
    expect(script).toContain("--no-recursion");
    expect(script).toContain("--sparse");
    expect(script).not.toContain("snapshot.tar.tmp");
    expect(script).toContain("required_bytes=$(( data_bytes + env_bytes + 67108864 ))");
  });

  it("keeps WAL files restorable while inventorying locks sockets and shared-memory files", () => {
    const result = buildProductionSnapshotPlan({
      runId: "capture-wal-a1",
      expectedMachineIdSha256: SOURCE_MACHINE,
      service: "comis.service",
      dataDir: "/srv/comis/.comis",
      captureMode: "bounded-freeze",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const script = result.value.prepare.stdin;

    expect(script).toContain(".daemon.lock");
    expect(script).toContain("*-shm");
    expect(script).toContain("runtime_socket");
    expect(script).not.toMatch(/-name\s+['"]?\*-wal/u);
    expect(script).not.toMatch(/SECRETS_MASTER_KEY|COMIS_GATEWAY_TOKEN|secrets\s+get/u);
    expect(script).not.toContain("set -x");
    expect(script).not.toMatch(/cat\s+[^\n]*snapshot\.tar/u);
  });

  it("provides a pinned cleanup command that always thaws and removes only the run staging tree", () => {
    const result = buildProductionSnapshotPlan({
      runId: "capture-cleanup-a1",
      expectedMachineIdSha256: SOURCE_MACHINE,
      service: "comis",
      dataDir: "/home/comis/.comis",
      captureMode: "bounded-freeze",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cleanup.args).toEqual([
      "sudo",
      "bash",
      "-s",
      "--",
      SOURCE_MACHINE,
      "comis",
      "capture-cleanup-a1",
    ]);
    expect(result.value.cleanup.stdin).toContain("systemctl thaw");
    expect(result.value.cleanup.stdin).toContain('rm -rf -- "$stage_dir"');
    expect(result.value.cleanup.stdin).not.toContain("/home/comis/.comis");
  });

  it("builds an offline plan that refuses an active service without any freeze capability", () => {
    const result = buildProductionSnapshotPlan({
      runId: "capture-offline-a1",
      expectedMachineIdSha256: SOURCE_MACHINE,
      service: "comis",
      dataDir: "/home/comis/.comis",
      captureMode: "offline",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.captureMode).toBe("offline");
    expect(result.value.prepare.stdin).toContain('source_state="$(systemctl is-active "$unit"');
    expect(result.value.prepare.stdin).toContain("LoadState");
    expect(result.value.prepare.stdin).toContain('[ "$source_load_state" != loaded ]');
    expect(result.value.prepare.stdin).toContain('[ "$source_state" != inactive ]');
    expect(result.value.prepare.stdin).toContain("offline snapshot requires an inactive service");
    expect(result.value.prepare.stdin).not.toContain("systemctl freeze");
    expect(result.value.prepare.stdin).not.toContain("systemctl thaw");
    expect(result.value.prepare.stdin).not.toContain("systemd-run");
    expect(result.value.cleanup.stdin).not.toContain("systemctl");
  });

  it("rejects unsafe source requests before constructing a privileged command", () => {
    const base = {
      runId: "capture-safe-a1",
      expectedMachineIdSha256: SOURCE_MACHINE,
      service: "comis",
      dataDir: "/home/comis/.comis",
      captureMode: "bounded-freeze" as const,
    };

    expect(buildProductionSnapshotPlan({ ...base, runId: "../escape" }).ok).toBe(false);
    expect(buildProductionSnapshotPlan({ ...base, service: "comis; reboot" }).ok).toBe(false);
    expect(buildProductionSnapshotPlan({ ...base, dataDir: "/home/comis/../root" }).ok).toBe(
      false,
    );
    expect(buildProductionSnapshotPlan({ ...base, dataDir: "/home//comis/.comis" }).ok).toBe(false);
    expect(buildProductionSnapshotPlan({ ...base, dataDir: "/home/comis/.comis/" }).ok).toBe(false);
    expect(
      buildProductionSnapshotPlan({ ...base, expectedMachineIdSha256: "not-a-digest" }).ok,
    ).toBe(false);
    expect(buildProductionSnapshotPlan({ ...base, watchdogSeconds: 2 }).ok).toBe(false);
    expect(buildProductionSnapshotPlan({ ...base, watchdogSeconds: 301 }).ok).toBe(false);
    const missingMode = { ...base } as Record<string, unknown>;
    delete missingMode["captureMode"];
    expect(
      buildProductionSnapshotPlan(
        missingMode as unknown as Parameters<typeof buildProductionSnapshotPlan>[0],
      ).ok,
    ).toBe(false);
  });

  it("parses a content-free manifest containing coherent database and environment artifacts", () => {
    const result = parseProductionSnapshotManifest(JSON.stringify(makeManifest()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map(({ path }) => path)).toContain("data/memory.db-wal");
    expect(result.value.captureMode).toBe("bounded-freeze");
    expect(result.value.entries.map(({ path }) => path)).toContain("system/etc/comis/env");
    expect(result.value.exclusions).toContainEqual(
      expect.objectContaining({ path: "data/memory.db-shm", reason: "sqlite_shm" }),
    );
    expect(result.value.entries.find(({ path }) => path === "data/models/python")).toMatchObject({
      type: "symlink",
      linkTarget: "/usr/bin/python3",
    });
  });

  it("rejects absolute traversal backslash and control-character manifest paths", () => {
    for (const path of [
      "/data/memory.db",
      "data/../root/.env",
      "data\\memory.db",
      "data//memory.db",
      "data/./memory.db",
      "data/message\nbody",
    ]) {
      const manifest = makeManifest({
        entries: [
          { path: "data", type: "directory", mode: "0700", size: 4096 },
          { path, type: "file", mode: "0600", size: 1, sha256: FILE_HASH },
          {
            path: "system/etc/comis/env",
            type: "file",
            mode: "0640",
            size: 1,
            sha256: FILE_HASH,
          },
        ],
      });
      const result = parseProductionSnapshotManifest(JSON.stringify(manifest));
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("unsafe_manifest_path");
    }
  });

  it("rejects duplicate overlapping and content-bearing manifest records", () => {
    const duplicate = makeManifest({
      entries: [makeManifest().entries[0]!, makeManifest().entries[0]!],
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(duplicate)).ok).toBe(false);

    const overlap = makeManifest({
      exclusions: [
        {
          path: "data/memory.db",
          type: "file",
          mode: "0600",
          size: 4096,
          reason: "daemon_lock",
        },
      ],
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(overlap)).ok).toBe(false);

    const contentBearing = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    const entries = contentBearing["entries"] as Array<Record<string, unknown>>;
    entries[1]!["content"] = "must never appear in a snapshot manifest";
    expect(parseProductionSnapshotManifest(JSON.stringify(contentBearing)).ok).toBe(false);

    const mislabeledSocket = makeManifest({
      exclusions: [
        {
          path: "data/cap.sock",
          type: "socket",
          mode: "0770",
          size: 0,
          reason: "unsupported_special",
        },
      ],
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(mislabeledSocket)).ok).toBe(false);
  });

  it("requires file hashes symlink targets restorable roots and every WAL main file", () => {
    const missingHash = makeManifest();
    const entriesWithoutHash = missingHash.entries.map((entry) =>
      entry.path === "data/.env"
        ? { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size }
        : entry,
    );
    expect(
      parseProductionSnapshotManifest(
        JSON.stringify({ ...missingHash, entries: entriesWithoutHash }),
      ).ok,
    ).toBe(false);

    const missingLink = makeManifest();
    const entriesWithoutLink = missingLink.entries.map((entry) =>
      entry.path === "data/models/python"
        ? { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size }
        : entry,
    );
    expect(
      parseProductionSnapshotManifest(
        JSON.stringify({ ...missingLink, entries: entriesWithoutLink }),
      ).ok,
    ).toBe(false);

    const missingMain = makeManifest({
      entries: makeManifest().entries.filter(({ path }) => path !== "data/memory.db"),
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(missingMain)).ok).toBe(false);

    const missingEnvironment = makeManifest({
      entries: makeManifest().entries.filter(({ path }) => path !== "system/etc/comis/env"),
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(missingEnvironment)).ok).toBe(false);
  });

  it("rejects malformed JSON invalid timing and unexpected archive metadata", () => {
    expect(parseProductionSnapshotManifest("{not-json").ok).toBe(false);

    const invalidTiming = makeManifest({
      captureStartedAtMs: 200,
      captureCompletedAtMs: 100,
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(invalidTiming)).ok).toBe(false);

    const unexpectedArchive = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    unexpectedArchive["archive"] = { fileName: "snapshot.tar", sha256: FILE_HASH };
    expect(parseProductionSnapshotManifest(JSON.stringify(unexpectedArchive)).ok).toBe(false);

    const inconsistentMode = makeManifest({ captureMode: "offline", freezeDurationMs: 25 });
    expect(parseProductionSnapshotManifest(JSON.stringify(inconsistentMode)).ok).toBe(false);
  });

  it("emits syntactically valid prepare and cleanup scripts for both capture modes", () => {
    for (const captureMode of ["offline", "bounded-freeze"] as const) {
      const result = buildProductionSnapshotPlan({
        runId: `capture-syntax-${captureMode}`,
        expectedMachineIdSha256: SOURCE_MACHINE,
        service: "comis",
        dataDir: "/home/comis/.comis",
        captureMode,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const command of [result.value.prepare, result.value.stream, result.value.cleanup]) {
        const checked = spawnSync("bash", ["-n"], {
          input: command.stdin,
          encoding: "utf8",
        });
        expect(checked.status, checked.stderr).toBe(0);
      }
    }
  });
});
