import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildProductionSnapshotPlan,
  deriveProductionSnapshotDataTreeIdentity,
  deriveProductionSnapshotEnvironmentEvidenceIdentity,
  parseProductionSnapshotManifest,
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";

const SOURCE_MACHINE = "a".repeat(64);
const FILE_HASH = "b".repeat(64);
const ACL_HASH = "c".repeat(64);
const XATTR_HASH = "d".repeat(64);
const CAPABILITY_HASH = "e".repeat(64);

const entryMetadata = {
  uid: 1001,
  gid: 1002,
  mtimeNs: "1752560000123456789",
  aclSha256: ACL_HASH,
  xattrSha256: XATTR_HASH,
  capabilitySha256: CAPABILITY_HASH,
} as const;

function makeManifest(
  overrides: Partial<ProductionSnapshotManifest> = {},
): ProductionSnapshotManifest {
  const base: ProductionSnapshotManifest = {
    schemaVersion: 1,
    runId: "capture-20260715-a1",
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "bounded-freeze",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_004_000,
    freezeDurationMs: 2_500,
    metadataIdentity: {
      acl: "captured",
      xattr: "captured",
      capability: "captured",
      gaps: [],
    },
    dataTreeIdentitySha256: "0".repeat(64),
    sourceEnvironmentEvidenceIdentitySha256: "0".repeat(64),
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 0, ...entryMetadata },
      {
        path: "data/.env",
        type: "file",
        mode: "0600",
        size: 84,
        sha256: FILE_HASH,
        ...entryMetadata,
      },
      {
        path: "data/memory.db",
        type: "file",
        mode: "0600",
        size: 4096,
        sha256: FILE_HASH,
        ...entryMetadata,
      },
      {
        path: "data/memory.db-wal",
        type: "file",
        mode: "0600",
        size: 2048,
        sha256: FILE_HASH,
        ...entryMetadata,
      },
      {
        path: "data/memory.db.copy",
        type: "hardlink",
        mode: "0600",
        size: 4096,
        hardlinkTarget: "data/memory.db",
        ...entryMetadata,
      },
      {
        path: "data/models/python",
        type: "symlink",
        mode: "0777",
        size: 10,
        linkTarget: "../python3",
        ...entryMetadata,
      },
      { path: "system", type: "directory", mode: "0700", size: 0, uid: 0, gid: 0, mtimeNs: entryMetadata.mtimeNs, aclSha256: ACL_HASH, xattrSha256: XATTR_HASH, capabilitySha256: CAPABILITY_HASH },
      { path: "system/etc", type: "directory", mode: "0700", size: 0, uid: 0, gid: 0, mtimeNs: entryMetadata.mtimeNs, aclSha256: ACL_HASH, xattrSha256: XATTR_HASH, capabilitySha256: CAPABILITY_HASH },
      { path: "system/etc/comis", type: "directory", mode: "0700", size: 0, uid: 0, gid: 0, mtimeNs: entryMetadata.mtimeNs, aclSha256: ACL_HASH, xattrSha256: XATTR_HASH, capabilitySha256: CAPABILITY_HASH },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 72,
        sha256: FILE_HASH,
        uid: 0,
        gid: 1002,
        mtimeNs: entryMetadata.mtimeNs,
        aclSha256: ACL_HASH,
        xattrSha256: XATTR_HASH,
        capabilitySha256: CAPABILITY_HASH,
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
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    dataTreeIdentitySha256:
      overrides.dataTreeIdentitySha256 ?? deriveProductionSnapshotDataTreeIdentity(merged),
    sourceEnvironmentEvidenceIdentitySha256:
      overrides.sourceEnvironmentEvidenceIdentitySha256 ??
      deriveProductionSnapshotEnvironmentEvidenceIdentity(merged),
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
    expect(result.value.stream.stdin).not.toContain("--hard-dereference");
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
    expect(script).toContain("--xattrs-include='*'");
    expect(script).toContain("--numeric-owner");
    expect(script).toContain("--no-recursion");
    expect(script).toContain("--sparse");
    expect(script).toContain("stat.mtimeNs.toString()");
    expect(script).toContain("stat.dev.toString()");
    expect(script).toContain("hardlinkTarget");
    expect(script).toContain('commandAvailable("getfacl")');
    expect(script).toContain('reason: "source_tool_unavailable"');
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
      linkTarget: "../python3",
    });
    expect(result.value.entries.find(({ path }) => path === "data/memory.db.copy")).toMatchObject({
      type: "hardlink",
      hardlinkTarget: "data/memory.db",
      uid: 1001,
      gid: 1002,
      mtimeNs: "1752560000123456789",
    });
  });

  it("separates restorable data identity from captured environment evidence", () => {
    const original = makeManifest();
    const environmentChanged = makeManifest({
      entries: original.entries.map((entry) =>
        entry.path === "system/etc/comis/env"
          ? { ...entry, sha256: "9".repeat(64) }
          : entry,
      ),
    });

    expect(environmentChanged.dataTreeIdentitySha256).toBe(
      original.dataTreeIdentitySha256,
    );
    expect(environmentChanged.sourceEnvironmentEvidenceIdentitySha256).not.toBe(
      original.sourceEnvironmentEvidenceIdentitySha256,
    );
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
          {
            path: "data",
            type: "directory",
            mode: "0700",
            size: 0,
            ...entryMetadata,
          },
          {
            path,
            type: "file",
            mode: "0600",
            size: 1,
            sha256: FILE_HASH,
            ...entryMetadata,
          },
          {
            path: "system/etc/comis/env",
            type: "file",
            mode: "0640",
            size: 1,
            sha256: FILE_HASH,
            uid: 0,
            gid: 1002,
            mtimeNs: entryMetadata.mtimeNs,
            aclSha256: ACL_HASH,
            xattrSha256: XATTR_HASH,
            capabilitySha256: CAPABILITY_HASH,
          },
        ],
      });
      const result = parseProductionSnapshotManifest(JSON.stringify(manifest));
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("unsafe_manifest_path");
    }
  });

  it("rejects absolute and root-escaping symlink targets", () => {
    for (const linkTarget of ["/usr/bin/python3", "../../../system/etc/comis/env"]) {
      const manifest = makeManifest({
        entries: makeManifest().entries.map((entry) =>
          entry.path === "data/models/python" && entry.type === "symlink"
            ? { ...entry, linkTarget }
            : entry,
        ),
      });

      expect(parseProductionSnapshotManifest(JSON.stringify(manifest)).ok, linkTarget).toBe(
        false,
      );
    }
  });

  it("rejects hardlink and metadata divergence from the canonical tree identity", () => {
    const mismatchedHardlink = makeManifest({
      entries: makeManifest().entries.map((entry) =>
        entry.path === "data/memory.db.copy" ? { ...entry, uid: entry.uid + 1 } : entry,
      ),
    });
    expect(parseProductionSnapshotManifest(JSON.stringify(mismatchedHardlink)).ok).toBe(false);

    const metadataChanged = makeManifest();
    const forged = {
      ...metadataChanged,
      entries: metadataChanged.entries.map((entry) =>
        entry.path === "data/.env" ? { ...entry, mtimeNs: "1752560000123456790" } : entry,
      ),
    };
    expect(parseProductionSnapshotManifest(JSON.stringify(forged)).ok).toBe(false);
  });

  it("declares unavailable metadata capabilities as explicit fidelity gaps", () => {
    const withoutOptionalMetadata = makeManifest({
      metadataIdentity: {
        acl: "unavailable",
        xattr: "unavailable",
        capability: "unavailable",
        gaps: [
          { kind: "acl", reason: "source_tool_unavailable" },
          { kind: "xattr", reason: "source_tool_unavailable" },
          { kind: "capability", reason: "source_tool_unavailable" },
        ],
      },
      entries: makeManifest().entries.map(
        ({ aclSha256: _acl, xattrSha256: _xattr, capabilitySha256: _capability, ...entry }) =>
          entry,
      ),
    });

    const result = parseProductionSnapshotManifest(JSON.stringify(withoutOptionalMetadata));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadataIdentity.gaps.map(({ kind }) => kind).sort()).toEqual([
      "acl",
      "capability",
      "xattr",
    ]);
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

  it("inventories a real nested session tree without dereferencing hardlinks", () => {
    const plan = buildProductionSnapshotPlan({
      runId: "capture-real-layout-a1",
      expectedMachineIdSha256: SOURCE_MACHINE,
      service: "comis",
      dataDir: "/home/comis/.comis",
      captureMode: "offline",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const marker = "cat > \"$builder\" <<'NODE'\n";
    const start = plan.value.prepare.stdin.indexOf(marker);
    const end = plan.value.prepare.stdin.indexOf("\nNODE\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const builder = plan.value.prepare.stdin.slice(start + marker.length, end);
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: builder,
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);

    const stage = mkdtempSync(join(tmpdir(), "comis-snapshot-layout-"));
    try {
      const sessionDir = join(
        stage,
        "tree",
        "data",
        "workspace",
        "sessions",
        "tenant_a",
        "telegram",
      );
      const systemDir = join(stage, "tree", "system", "etc", "comis");
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      mkdirSync(systemDir, { recursive: true, mode: 0o755 });
      const sessionPath = join(sessionDir, "session.jsonl");
      writeFileSync(sessionPath, '{"role":"user"}\n', { mode: 0o600 });
      linkSync(sessionPath, join(sessionDir, "session.jsonl.copy"));
      symlinkSync("session.jsonl", join(sessionDir, "latest"));
      writeFileSync(join(systemDir, "env"), "COMIS_DATA_DIR=/tmp/test\n", { mode: 0o640 });
      writeFileSync(join(stage, "exclusions.nul"), "", { mode: 0o600 });

      const built = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-",
          stage,
          "capture-real-layout-a1",
          SOURCE_MACHINE,
          "comis",
          "offline",
          "1752560000000",
          "1752560000100",
          "0",
        ],
        { input: builder, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const parsed = parseProductionSnapshotManifest(
        readFileSync(join(stage, "manifest.json"), "utf8"),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(
        parsed.value.entries.find(({ path }) => path.endsWith("session.jsonl.copy")),
      ).toMatchObject({
        type: "hardlink",
        hardlinkTarget: expect.stringMatching(/session\.jsonl$/u),
      });
      expect(
        parsed.value.entries.filter(({ type }) => type === "directory").every(({ size }) => size === 0),
      ).toBe(true);
      expect(parsed.value.dataTreeIdentitySha256).toBe(
        deriveProductionSnapshotDataTreeIdentity(parsed.value),
      );
      expect(parsed.value.sourceEnvironmentEvidenceIdentitySha256).toBe(
        deriveProductionSnapshotEnvironmentEvidenceIdentity(parsed.value),
      );

      unlinkSync(join(stage, "manifest.json"));
      unlinkSync(join(sessionDir, "latest"));
      symlinkSync("/usr/bin/python3", join(sessionDir, "latest"));
      const escaping = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-",
          stage,
          "capture-real-layout-a1",
          SOURCE_MACHINE,
          "comis",
          "offline",
          "1752560000000",
          "1752560000100",
          "0",
        ],
        { input: builder, encoding: "utf8" },
      );
      expect(escaping.status).not.toBe(0);
      expect(() => readFileSync(join(stage, "manifest.json"), "utf8")).toThrow();
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
