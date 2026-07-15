import { describe, expect, it } from "vitest";

import {
  attestSourceReadOnly,
  attestSourceSnapshotReady,
  attestTargetMutation,
  buildHostProbeScript,
  buildInstallerRemoteArgs,
  parseHostFacts,
} from "./production-host.js";
import type { ProductionReplayProfile } from "./production-profile.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);

function makeProfile(): ProductionReplayProfile {
  return {
    source: {
      ssh: "comis-harel",
      role: "production",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
      expectedMachineIdSha256: SOURCE_MACHINE,
    },
    target: {
      ssh: "comis-test2",
      role: "test",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
      expectedMachineIdSha256: TARGET_MACHINE,
    },
  };
}

const SOURCE_FACTS = [
  `machineIdSha256=${SOURCE_MACHINE}`,
  "environmentRole=",
  "osId=ubuntu",
  "osVersion=24.04",
  "arch=x86_64",
  "sudoReady=true",
  "systemdReady=true",
  "freezeReady=true",
  "bashReady=true",
  "tarReady=true",
  "rsyncReady=true",
  "curlReady=true",
  "nodeReady=true",
  "npmReady=true",
  "comisInstalled=true",
  "comisVersion=1.0.53",
  "serviceState=active",
  "serviceEnabled=true",
  "dataExists=true",
  "dataMode=700",
  "dataBytes=304734958",
  "diskFreeBytes=90000000000",
  "",
].join("\n");

const TARGET_FACTS = SOURCE_FACTS
  .replace(SOURCE_MACHINE, TARGET_MACHINE)
  .replace("nodeReady=true", "nodeReady=false")
  .replace("npmReady=true", "npmReady=false")
  .replace("comisInstalled=true", "comisInstalled=false")
  .replace("comisVersion=1.0.53", "comisVersion=")
  .replace("serviceState=active", "serviceState=missing")
  .replace("serviceEnabled=true", "serviceEnabled=false")
  .replace("dataExists=true", "dataExists=false")
  .replace("dataMode=700", "dataMode=")
  .replace("dataBytes=304734958", "dataBytes=0");

describe("production replay host safety", () => {
  it("parses bounded host facts without reading content-bearing artifacts", () => {
    const result = parseHostFacts(SOURCE_FACTS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      machineIdSha256: SOURCE_MACHINE,
      osId: "ubuntu",
      comisInstalled: true,
      comisVersion: "1.0.53",
      serviceState: "active",
      dataBytes: 304734958,
    });
  });

  it("keeps the host probe strictly read-only", () => {
    const script = buildHostProbeScript();

    expect(script).toContain("systemctl is-active");
    expect(script).toContain("LoadState");
    expect(script).toContain("sha256sum");
    expect(script).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable)/u);
    expect(script).not.toMatch(/(?:^|\s)(?:rm|mv|cp|chown|chmod|tee|apt|dnf|npm\s+install)(?:\s|$)/mu);
    expect(script).not.toContain("secrets.db");
    expect(script).not.toContain("/.env");
  });

  it("attests the source only when its pinned identity matches and it is not marked test", () => {
    const profile = makeProfile();
    const facts = parseHostFacts(SOURCE_FACTS);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;

    expect(attestSourceReadOnly(profile, facts.value)).toEqual({ ok: true, value: undefined });

    const wrong = attestSourceReadOnly(profile, { ...facts.value, machineIdSha256: TARGET_MACHINE });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.kind).toBe("machine_mismatch");

    const testMarked = attestSourceReadOnly(profile, { ...facts.value, environmentRole: "test" });
    expect(testMarked.ok).toBe(false);
    if (!testMarked.ok) expect(testMarked.error.kind).toBe("role_mismatch");

    const inactive = { ...facts.value, serviceState: "inactive" as const };
    expect(attestSourceReadOnly(profile, inactive).ok).toBe(true);
    const snapshotReady = attestSourceSnapshotReady(profile, inactive);
    expect(snapshotReady.ok).toBe(false);
    if (!snapshotReady.ok) expect(snapshotReady.error.kind).toBe("unsupported_host");
  });

  it("allows bootstrap on a pinned fresh target but requires the test marker for restore", () => {
    const profile = makeProfile();
    const facts = parseHostFacts(TARGET_FACTS);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;

    expect(attestTargetMutation(profile, facts.value, "bootstrap")).toEqual({
      ok: true,
      value: undefined,
    });

    const restore = attestTargetMutation(profile, facts.value, "restore");
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.error.kind).toBe("role_mismatch");

    const marked = attestTargetMutation(
      profile,
      { ...facts.value, environmentRole: "test" },
      "restore",
    );
    expect(marked).toEqual({ ok: true, value: undefined });

    const existingUnmarked = attestTargetMutation(
      profile,
      { ...facts.value, comisInstalled: true, dataExists: true, serviceState: "inactive" },
      "bootstrap",
    );
    expect(existingUnmarked.ok).toBe(false);
    if (!existingUnmarked.ok) expect(existingUnmarked.error.kind).toBe("role_mismatch");

    const unknownRole = attestTargetMutation(
      profile,
      { ...facts.value, environmentRole: "staging" },
      "bootstrap",
    );
    expect(unknownRole.ok).toBe(false);
    if (!unknownRole.ok) expect(unknownRole.error.kind).toBe("role_mismatch");
  });

  it("refuses target mutation when identity is unpinned or points at the source machine", () => {
    const profile = makeProfile();
    const facts = parseHostFacts(TARGET_FACTS);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;

    const unpinned = attestTargetMutation(
      { ...profile, target: { ...profile.target, expectedMachineIdSha256: undefined } },
      facts.value,
      "bootstrap",
    );
    expect(unpinned.ok).toBe(false);
    if (!unpinned.ok) expect(unpinned.error.kind).toBe("identity_unpinned");

    const sourceMachine = attestTargetMutation(
      profile,
      { ...facts.value, machineIdSha256: SOURCE_MACHINE },
      "bootstrap",
    );
    expect(sourceMachine.ok).toBe(false);
    if (!sourceMachine.ok) expect(sourceMachine.error.kind).toBe("source_target_conflict");
  });

  it("builds a pinned non-interactive installer invocation from the repository script", () => {
    const result = buildInstallerRemoteArgs("1.0.53", "comis");

    expect(result).toEqual({
      ok: true,
      value: [
        "sudo",
        "bash",
        "-s",
        "--",
        "--yes",
        "--no-prompt",
        "--no-init",
        "--no-service-start",
        "--no-autostart",
        "--service",
        "systemd",
        "--user",
        "comis",
        "--install-method",
        "npm",
        "--version",
        "1.0.53",
        "--with-browser",
        "--with-xvfb",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("curl");

    const unsafe = buildInstallerRemoteArgs("latest; reboot", "comis");
    expect(unsafe.ok).toBe(false);
  });
});
