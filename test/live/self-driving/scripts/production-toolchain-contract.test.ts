import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  TOOLCHAIN_CONTRACT_SCHEMA,
  TOOLCHAIN_CONTRACT_SCHEMA_SHA256,
  TOOLCHAIN_CONTRACT_SCHEMA_VERSION,
  TOOLCHAIN_ENVIRONMENT,
  TOOLCHAIN_ENVIRONMENT_SHA256,
  TOOLCHAIN_EXECUTION_CONTRACT_SHA256,
  TOOLCHAIN_EXECUTION_CONTRACT_V1,
  TOOLCHAIN_FEATURE_CONTRACT_SHA256,
  TOOLCHAIN_FEATURE_NAMES,
  TOOLCHAIN_HELPERS,
  TOOLCHAIN_PROBE_PROGRAM_SHA256,
  TOOLCHAIN_SOURCE_ENVELOPE_BEGIN,
  TOOLCHAIN_SOURCE_ENVELOPE_END,
  TOOLCHAIN_TARGET_ENVELOPE_BEGIN,
  TOOLCHAIN_TARGET_ENVELOPE_END,
  TOOLCHAIN_ROOT_SHELL_PREFIX,
  TOOLCHAIN_ROOT_SCRIPT_PREFIX,
  buildToolchainRootShellCommand,
  buildToolchainRootScriptCommand,
  buildToolchainProbeProgram,
  compareToolchainCompatibility,
  compareToolchainContracts,
  computeToolchainContractDigest,
  createToolchainContractV1,
  parseToolchainProbeOutput,
  serializeToolchainContract,
  type ToolchainContractV1,
  type ToolchainToolFactsV1,
  type ToolchainToolName,
  type ToolchainRole,
} from "./production-toolchain-contract.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);
const SOURCE_BOOT = "c".repeat(64);
const TARGET_BOOT = "d".repeat(64);
const SOURCE_KERNEL = "e".repeat(64);
const TARGET_KERNEL = "f".repeat(64);

const REQUIRED_HELPERS = [
  "bash",
  "systemctl",
  "stat",
  "readlink",
  "install",
  "mv",
  "rm",
  "ln",
  "chmod",
  "tar",
  "zstd",
  "unshare",
  "mount",
  "findmnt",
  "sync",
  "flock",
  "sha256sum",
  "sudo",
  "realpath",
  "python3",
] as const;

function makeToolFacts(
  name: ToolchainToolName,
  seed: number,
  overrides: Partial<ToolchainToolFactsV1> = {},
): ToolchainToolFactsV1 {
  const path = TOOLCHAIN_HELPERS[name];
  const digest = (offset: number): string =>
    ((seed + offset) % 256).toString(16).padStart(2, "0").repeat(32);
  return {
    name,
    path,
    resolvedPath: name === "python3" ? "/usr/bin/python3.12" : path,
    ownerUid: 0,
    ownerGid: 0,
    modeOctal: "0755",
    pathChainRootOwned: true,
    pathChainNonWritable: true,
    pathIdentitySha256: digest(0),
    binarySha256: digest(1),
    versionSha256: digest(2),
    ...overrides,
  };
}

function makeContract(
  role: ToolchainRole,
  overrides: {
    readonly machineIdSha256?: string;
    readonly bootIdSha256?: string;
    readonly kernelIdentitySha256?: string;
    readonly toolOverrides?: Partial<
      Record<ToolchainToolName, Partial<ToolchainToolFactsV1>>
    >;
  } = {},
): ToolchainContractV1 {
  const names = Object.keys(TOOLCHAIN_HELPERS) as ToolchainToolName[];
  const tools = names.map((name, index) =>
    makeToolFacts(
      name,
      index,
      overrides.toolOverrides?.[name],
    ),
  );
  const created = createToolchainContractV1({
    role,
    machineIdSha256:
      overrides.machineIdSha256 ?? (role === "source" ? SOURCE_MACHINE : TARGET_MACHINE),
    bootIdSha256:
      overrides.bootIdSha256 ?? (role === "source" ? SOURCE_BOOT : TARGET_BOOT),
    kernelIdentitySha256:
      overrides.kernelIdentitySha256 ??
      (role === "source" ? SOURCE_KERNEL : TARGET_KERNEL),
    tools,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function envelope(contract: ToolchainContractV1): string {
  const serialized = serializeToolchainContract(contract);
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) throw new Error(serialized.error.message);
  return serialized.value;
}

function replaceEnvelopeJson(
  raw: string,
  mutate: (value: Record<string, unknown>) => void,
): string {
  const lines = raw.trimEnd().split("\n");
  const value = JSON.parse(lines[1] as string) as Record<string, unknown>;
  mutate(value);
  return `${lines[0]}\n${JSON.stringify(value)}\n${lines[2]}\n`;
}

function pythonHeredoc(program: string): string {
  const marker = "COMIS_TOOLCHAIN_PROBE_PYTHON_V1";
  const start = program.indexOf(`<<'${marker}'\n`);
  const end = program.lastIndexOf(`\n${marker}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return program.slice(start + marker.length + 5, end);
}

describe("production runtime vault toolchain contract", () => {
  it("builds a content-free fixed-environment read-only remote probe", () => {
    const built = buildToolchainProbeProgram("source", SOURCE_MACHINE);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const program = built.value;
    expect(program).toContain(
      "exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C TZ=Etc/UTC",
    );
    expect(program).toContain(
      "/usr/bin/unshare --mount --propagation private",
    );
    expect(program).toContain("/usr/bin/bash --noprofile --norc -c");
    expect(program).toContain("/usr/bin/python3 -I -S -B -");
    expect(program).toContain(`source ${SOURCE_MACHINE}`);
    expect(program).toContain(TOOLCHAIN_PROBE_PROGRAM_SHA256);
    expect(program).toContain(TOOLCHAIN_ENVIRONMENT_SHA256);
    expect(spawnSync("bash", ["-n"], { input: program }).status).toBe(0);
    const python = pythonHeredoc(program);
    expect(createHash("sha256").update(python).digest("hex")).toBe(
      TOOLCHAIN_PROBE_PROGRAM_SHA256,
    );
    expect(
      spawnSync(
        "python3",
        ["-c", "import sys; compile(sys.stdin.read(), '<toolchain-probe>', 'exec')"],
        { input: python },
      ).status,
    ).toBe(0);

    for (const [name, path] of Object.entries(TOOLCHAIN_HELPERS)) {
      expect(python, name).toContain(JSON.stringify(path));
    }
    for (const forbidden of [
      "API_KEY",
      "AUTHORIZATION",
      "HOME=",
      "PASSWORD",
      "SECRET",
      "TOKEN",
    ]) {
      expect(program).not.toContain(forbidden);
    }
    expect(program).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable|kill)/u);
    expect(program).not.toContain("/home/");
    expect(program).not.toContain("/srv/");
    expect(program).not.toContain("/opt/comis");
  });

  it("exports one absolute sanitized root execution contract for runtime-vault", () => {
    expect(TOOLCHAIN_HELPERS.sudo).toBe("/usr/bin/sudo");
    expect(TOOLCHAIN_ROOT_SHELL_PREFIX).toEqual([
      "/usr/bin/sudo",
      "--",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "LC_ALL=C",
      "TZ=Etc/UTC",
      "/usr/bin/bash",
      "--noprofile",
      "--norc",
      "-s",
      "--",
    ]);
    expect(TOOLCHAIN_ROOT_SCRIPT_PREFIX).toEqual([
      "/usr/bin/sudo",
      "--",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "LC_ALL=C",
      "TZ=Etc/UTC",
      "/usr/bin/bash",
      "--noprofile",
      "--norc",
    ]);
    expect(TOOLCHAIN_EXECUTION_CONTRACT_V1).toMatchObject({
      schema: "comis-runtime-vault-toolchain-execution",
      schemaVersion: 1,
      environment: TOOLCHAIN_ENVIRONMENT,
      helpers: TOOLCHAIN_HELPERS,
      rootShellPrefix: TOOLCHAIN_ROOT_SHELL_PREFIX,
      rootScriptPrefix: TOOLCHAIN_ROOT_SCRIPT_PREFIX,
    });
    expect(TOOLCHAIN_EXECUTION_CONTRACT_SHA256).toMatch(/^[a-f0-9]{64}$/u);

    expect(buildToolchainRootShellCommand(["machine", "/absolute/path"])).toEqual({
      ok: true,
      value: [...TOOLCHAIN_ROOT_SHELL_PREFIX, "machine", "/absolute/path"],
    });
    expect(
      buildToolchainRootScriptCommand("/var/lib/comis/receive.sh", ["arg"]),
    ).toEqual({
      ok: true,
      value: [
        ...TOOLCHAIN_ROOT_SCRIPT_PREFIX,
        "/var/lib/comis/receive.sh",
        "arg",
      ],
    });
    expect(buildToolchainRootScriptCommand("relative.sh", []).ok).toBe(false);
    expect(
      buildToolchainRootShellCommand(["unsafe\nargument"]).ok,
    ).toBe(false);
    expect(
      buildToolchainRootShellCommand("not-an-array" as unknown as readonly string[]).ok,
    ).toBe(false);
  });

  it("pins every runtime helper and every functional feature in the probe", () => {
    const built = buildToolchainProbeProgram("target", TARGET_MACHINE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const program = built.value;

    for (const name of REQUIRED_HELPERS) {
      expect(TOOLCHAIN_HELPERS).toHaveProperty(name);
      expect(TOOLCHAIN_HELPERS[name]).toMatch(/^\/usr\/bin\/[a-z0-9]+$/u);
    }
    expect(Object.keys(TOOLCHAIN_HELPERS)).toEqual(
      [...Object.keys(TOOLCHAIN_HELPERS)].sort(),
    );
    expect(TOOLCHAIN_ENVIRONMENT).toEqual({
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      TZ: "Etc/UTC",
    });

    for (const feature of TOOLCHAIN_FEATURE_NAMES) {
      expect(program, feature).toContain(JSON.stringify(feature));
      expect(program, feature).toContain(
        `pass_feature(features, ${JSON.stringify(feature)})`,
      );
    }
    expect(program).not.toContain("features = {name: True for name in FEATURE_NAMES}");
    expect(program).toContain("require(set(features) == set(FEATURE_NAMES))");
    expect(program).toContain('"--create"');
    expect(program).toContain('"--file=-"');
    expect(program).toContain('"--format=posix"');
    expect(program).toContain('"--zstd"');
    expect(program).toContain('"--numeric-owner"');
    expect(program).toContain('"--pax-option=delete=atime,delete=ctime"');
    expect(program).toContain("corrupt.zst");
    expect(program).toContain('[zstd, "-dc", corrupt]');
    expect(program).toContain("/usr/bin/mount --make-rprivate /");
    expect(program).toContain('"-t", "tmpfs"');
    expect(program).toContain('"--bind"');
    expect(program).toContain(
      "remount,bind,ro,noatime,nodiratime,nosuid,nodev,noexec",
    );
    expect(program).toContain('"--target", bind_root');
    expect(program).toContain('[sync, "-f", sync_file]');
    expect(program).toContain('[sync, "-f", scratch]');
    expect(program).toContain('[flock, "-n", str(contender_descriptor)');
    expect(program).toContain("pass_fds=(contender_descriptor,)");
    expect(program).toContain(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(program).toContain('[realpath, "-e", "--", realpath_link + "/leaf"]');
    expect(program).toContain('[realpath, "-m", "--", missing_path]');
    expect(program).toContain("sys.version_info >= (3, 12)");
    expect(program).toContain("tarfile.data_filter");
    expect(program).toContain("TarInfo(\"entry\").replace");
    expect(program).toContain("os.listxattr");
    expect(program).toContain("os.supports_dir_fd");
    expect(program).toContain("os.O_NOFOLLOW");
    expect(program).toContain("os.O_DIRECTORY");
    expect(program).toContain("os.lchown");
    expect(program).toContain("os.utime");
    expect(program).toContain("renameat2");
    expect(program).toContain("RENAME_NOREPLACE");
    expect(program).toContain('[readlink, "-f", "--", canonical_link]');
    expect(program).toContain('[install, "-d", "-m", "0700", "-o", "root", "-g", "root"');
    expect(program).toContain('[mv, "--no-clobber", "--"');
    expect(program).toContain('[ln, "--"');
    expect(program).toContain('[stat_command, "-Lc", stat_format');
    expect(program).toContain('[rm, "-rf", "--"');
    expect(program).toContain("os.setxattr");
    expect(program).toContain("os.removexattr");
    expect(program).toContain("tarfile.open(fileobj=sys.stdin.buffer, mode=\"r|\")");
    expect(program).toContain("decoder.stdout");
    expect(program).toContain("sys.flags.isolated == 1");
    expect(program).toContain("os.O_NOATIME");
    expect(program).toContain('[env, "-i", "PATH=/usr/bin:/bin", "LC_ALL=C", "TZ=Etc/UTC"');
    expect(program).toContain('bash, "--noprofile", "--norc", script_path');
    expect(program).toContain("archive-stream\\n");
  });

  it("rejects unsafe probe role and machine identity arguments", () => {
    expect(buildToolchainProbeProgram("source", "not-a-digest").ok).toBe(false);
    expect(
      buildToolchainProbeProgram("other" as ToolchainRole, SOURCE_MACHINE).ok,
    ).toBe(false);
    expect(buildToolchainProbeProgram("target", TARGET_MACHINE).ok).toBe(true);
    expect(
      buildToolchainProbeProgram(
        "source",
        [SOURCE_MACHINE] as unknown as string,
      ).ok,
    ).toBe(false);
  });

  it("round trips exact bounded role-specific canonical envelopes", () => {
    const source = makeContract("source");
    const target = makeContract("target");
    const sourceRaw = envelope(source);
    const targetRaw = envelope(target);

    expect(sourceRaw.startsWith(`${TOOLCHAIN_SOURCE_ENVELOPE_BEGIN}\n`)).toBe(true);
    expect(sourceRaw.endsWith(`${TOOLCHAIN_SOURCE_ENVELOPE_END}\n`)).toBe(true);
    expect(targetRaw.startsWith(`${TOOLCHAIN_TARGET_ENVELOPE_BEGIN}\n`)).toBe(true);
    expect(targetRaw.endsWith(`${TOOLCHAIN_TARGET_ENVELOPE_END}\n`)).toBe(true);
    expect(parseToolchainProbeOutput(sourceRaw)).toEqual({ ok: true, value: source });
    expect(parseToolchainProbeOutput(targetRaw, {
      role: "target",
      expectedMachineIdSha256: TARGET_MACHINE,
    })).toEqual({ ok: true, value: target });
    expect(parseToolchainProbeOutput(targetRaw, { role: "source" }).ok).toBe(false);
    expect(
      parseToolchainProbeOutput(targetRaw, {
        expectedMachineIdSha256: SOURCE_MACHINE,
      }).ok,
    ).toBe(false);
    expect(Buffer.byteLength(sourceRaw, "utf8")).toBeLessThan(32 * 1024);
  });

  it("binds schema role host boot kernel probe features and every tool digest", () => {
    const source = makeContract("source");
    expect(TOOLCHAIN_CONTRACT_SCHEMA_SHA256).toBe(
      "c74d87f6e694a84f85fd872169babe71a9ca723176b1b81a8d35d28385a4e68f",
    );
    expect(TOOLCHAIN_ENVIRONMENT_SHA256).toBe(
      "0a5b66483308a2349c5c9d890f1904adcb62ec584d4880dd66bd6baba5c28d58",
    );
    expect(TOOLCHAIN_FEATURE_CONTRACT_SHA256).toBe(
      "41f2a77d9680902be5147a0285965df0d4179c2b857c9a044fc09128f9a6015a",
    );
    expect(source).toMatchObject({
      schema: TOOLCHAIN_CONTRACT_SCHEMA,
      schemaVersion: TOOLCHAIN_CONTRACT_SCHEMA_VERSION,
      schemaDigestSha256: TOOLCHAIN_CONTRACT_SCHEMA_SHA256,
      role: "source",
      machineIdSha256: SOURCE_MACHINE,
      bootIdSha256: SOURCE_BOOT,
      kernelIdentitySha256: SOURCE_KERNEL,
      probeProgramSha256: TOOLCHAIN_PROBE_PROGRAM_SHA256,
      environmentSha256: TOOLCHAIN_ENVIRONMENT_SHA256,
      executionContractSha256: TOOLCHAIN_EXECUTION_CONTRACT_SHA256,
      featureDigestSha256: TOOLCHAIN_FEATURE_CONTRACT_SHA256,
    });
    expect(source.tools).toHaveLength(Object.keys(TOOLCHAIN_HELPERS).length);
    for (const tool of source.tools) {
      expect(tool.path).toBe(TOOLCHAIN_HELPERS[tool.name]);
      expect(tool.ownerUid).toBe(0);
      expect(tool.ownerGid).toBe(0);
      expect(tool.pathChainRootOwned).toBe(true);
      expect(tool.pathChainNonWritable).toBe(true);
      expect(tool.toolDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    }

    const baseline = source.toolchainDigestSha256;
    const changes = [
      makeContract("target", {
        machineIdSha256: SOURCE_MACHINE,
        bootIdSha256: SOURCE_BOOT,
        kernelIdentitySha256: SOURCE_KERNEL,
      }),
      makeContract("source", { machineIdSha256: "1".repeat(64) }),
      makeContract("source", { bootIdSha256: "2".repeat(64) }),
      makeContract("source", { kernelIdentitySha256: "3".repeat(64) }),
      makeContract("source", {
        toolOverrides: { tar: { binarySha256: "4".repeat(64) } },
      }),
      makeContract("source", {
        toolOverrides: { tar: { versionSha256: "5".repeat(64) } },
      }),
    ];
    for (const changed of changes) {
      expect(changed.toolchainDigestSha256).not.toBe(baseline);
      expect(computeToolchainContractDigest(changed)).toBe(
        changed.toolchainDigestSha256,
      );
    }
    expect(
      makeContract("source", {
        toolOverrides: { mount: { modeOctal: "4755" } },
      }).tools.find((tool) => tool.name === "mount")?.modeOctal,
    ).toBe("4755");
  });

  it("matches Python canonical digest semantics used by the remote probe", () => {
    const contract = makeContract("source");
    const { toolDigestSha256, ...toolFacts } = contract.tools[0] as (typeof contract.tools)[number];
    const { toolchainDigestSha256, ...unsignedContract } = contract;
    const python = [
      "import hashlib,json,sys",
      "domain=sys.argv[1].encode('ascii')",
      "value=json.loads(sys.stdin.read())",
      "payload=json.dumps(value,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode('utf8')",
      "print(hashlib.sha256(domain+b'\\0'+payload).hexdigest())",
      "",
    ].join("\n");
    const toolResult = spawnSync(
      "python3",
      ["-c", python, "comis-runtime-vault-toolchain-tool-v1"],
      { encoding: "utf8", input: JSON.stringify(toolFacts) },
    );
    const contractResult = spawnSync(
      "python3",
      ["-c", python, "comis-runtime-vault-toolchain-contract-v1"],
      { encoding: "utf8", input: JSON.stringify(unsignedContract) },
    );

    expect(toolResult.status).toBe(0);
    expect(toolResult.stdout.trim()).toBe(toolDigestSha256);
    expect(contractResult.status).toBe(0);
    expect(contractResult.stdout.trim()).toBe(toolchainDigestSha256);
  });

  it("rejects missing duplicate unknown oversized and malformed facts", () => {
    const valid = envelope(makeContract("source"));
    const lines = valid.trimEnd().split("\n");
    const duplicate = valid.replace(
      '"role":"source"',
      '"role":"source","role":"source"',
    );
    const missing = replaceEnvelopeJson(valid, (value) => {
      delete value.bootIdSha256;
    });
    const unknown = replaceEnvelopeJson(valid, (value) => {
      value.unexpected = true;
    });
    const malformedDigest = replaceEnvelopeJson(valid, (value) => {
      value.machineIdSha256 = "A".repeat(64);
    });
    const arrayMachineDigest = replaceEnvelopeJson(valid, (value) => {
      value.machineIdSha256 = [SOURCE_MACHINE];
    });
    const unknownFeature = replaceEnvelopeJson(valid, (value) => {
      const features = value.features as Record<string, unknown>;
      features.unexpected = true;
    });
    const failedFeature = replaceEnvelopeJson(valid, (value) => {
      const features = value.features as Record<string, unknown>;
      features.syncFile = false;
    });
    const duplicateTool = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as unknown[];
      tools[1] = tools[0];
    });
    const unknownTool = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], name: "curl" };
    });
    const wrongPath = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], path: "/tmp/bash" };
    });
    const nonRoot = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], ownerUid: 1000 };
    });
    const writableAncestor = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], pathChainNonWritable: false };
    });
    const wrongProgram = replaceEnvelopeJson(valid, (value) => {
      value.probeProgramSha256 = "1".repeat(64);
    });
    const wrongFeatureDigest = replaceEnvelopeJson(valid, (value) => {
      value.featureDigestSha256 = "2".repeat(64);
    });
    const wrongToolDigest = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], toolDigestSha256: "3".repeat(64) };
    });
    const arrayBinaryDigest = replaceEnvelopeJson(valid, (value) => {
      const tools = value.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], binarySha256: ["1".repeat(64)] };
    });
    const wrongContractDigest = replaceEnvelopeJson(valid, (value) => {
      value.toolchainDigestSha256 = "4".repeat(64);
    });

    for (const candidate of [
      duplicate,
      missing,
      unknown,
      malformedDigest,
      arrayMachineDigest,
      unknownFeature,
      failedFeature,
      duplicateTool,
      unknownTool,
      wrongPath,
      nonRoot,
      writableAncestor,
      wrongProgram,
      wrongFeatureDigest,
      wrongToolDigest,
      arrayBinaryDigest,
      wrongContractDigest,
      `${TOOLCHAIN_TARGET_ENVELOPE_BEGIN}\n${lines[1]}\n${TOOLCHAIN_TARGET_ENVELOPE_END}\n`,
      valid.replace("\n", "\r\n"),
      valid.slice(0, -1),
      `banner\n${valid}`,
      `${"x".repeat(32 * 1024 + 1)}\n`,
      `${TOOLCHAIN_SOURCE_ENVELOPE_BEGIN}\nnot-json\n${TOOLCHAIN_SOURCE_ENVELOPE_END}\n`,
    ]) {
      expect(parseToolchainProbeOutput(candidate).ok, candidate.slice(0, 80)).toBe(
        false,
      );
    }

    expect(
      parseToolchainProbeOutput(valid, {
        expectedMachineIdSha256: [SOURCE_MACHINE] as unknown as string,
      }).ok,
    ).toBe(false);
    expect(parseToolchainProbeOutput([valid] as unknown as string).ok).toBe(false);

    const source = makeContract("source");
    const malformedFactory = createToolchainContractV1({
      role: "source",
      machineIdSha256: [SOURCE_MACHINE] as unknown as string,
      bootIdSha256: source.bootIdSha256,
      kernelIdentitySha256: source.kernelIdentitySha256,
      tools: source.tools,
    });
    expect(malformedFactory.ok).toBe(false);
  });

  it("compares repeat samples only within the same role for exact stability", () => {
    const source = makeContract("source");
    expect(compareToolchainContracts(source, structuredClone(source))).toEqual({
      ok: true,
      value: {
        stable: true,
        role: "source",
        machineIdSha256: SOURCE_MACHINE,
        bootIdSha256: SOURCE_BOOT,
        toolchainDigestSha256: source.toolchainDigestSha256,
      },
    });

    const rebooted = compareToolchainContracts(
      source,
      makeContract("source", { bootIdSha256: "1".repeat(64) }),
    );
    expect(rebooted).toMatchObject({
      ok: false,
      error: { kind: "toolchain_stability_mismatch", field: "bootIdSha256" },
    });

    const changedTool = compareToolchainContracts(
      source,
      makeContract("source", {
        toolOverrides: { zstd: { versionSha256: "2".repeat(64) } },
      }),
    );
    expect(changedTool).toMatchObject({
      ok: false,
      error: { kind: "toolchain_stability_mismatch", field: "toolsDigestSha256" },
    });
    expect(compareToolchainContracts(source, makeContract("target"))).toMatchObject({
      ok: false,
      error: { kind: "toolchain_stability_mismatch", field: "role" },
    });
  });

  it("reports cross-role compatibility without requiring identical tools or kernels", () => {
    const source = makeContract("source");
    const target = makeContract("target", {
      toolOverrides: {
        bash: {
          resolvedPath: "/usr/bin/bash-5.3",
          pathIdentitySha256: "1".repeat(64),
          binarySha256: "2".repeat(64),
          versionSha256: "3".repeat(64),
        },
        python3: {
          resolvedPath: "/usr/bin/python3.13",
          pathIdentitySha256: "4".repeat(64),
          binarySha256: "5".repeat(64),
          versionSha256: "6".repeat(64),
        },
      },
    });

    expect(compareToolchainCompatibility(source, target)).toEqual({
      ok: true,
      value: {
        compatible: true,
        schema: TOOLCHAIN_CONTRACT_SCHEMA,
        schemaVersion: 1,
        schemaDigestSha256: TOOLCHAIN_CONTRACT_SCHEMA_SHA256,
        probeProgramSha256: TOOLCHAIN_PROBE_PROGRAM_SHA256,
        environmentSha256: TOOLCHAIN_ENVIRONMENT_SHA256,
        executionContractSha256: TOOLCHAIN_EXECUTION_CONTRACT_SHA256,
        featureDigestSha256: TOOLCHAIN_FEATURE_CONTRACT_SHA256,
        sourceMachineIdSha256: SOURCE_MACHINE,
        targetMachineIdSha256: TARGET_MACHINE,
        sourceToolchainDigestSha256: source.toolchainDigestSha256,
        targetToolchainDigestSha256: target.toolchainDigestSha256,
      },
    });
    expect(compareToolchainCompatibility(target, source)).toMatchObject({
      ok: false,
      error: { kind: "toolchain_incompatible", field: "role" },
    });
    expect(
      compareToolchainCompatibility(
        source,
        makeContract("target", { machineIdSha256: SOURCE_MACHINE }),
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "toolchain_incompatible", field: "machineIdSha256" },
    });
  });
});
