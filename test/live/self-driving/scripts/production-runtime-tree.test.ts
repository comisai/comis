import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RUNTIME_TREE_FACTS_BEGIN,
  RUNTIME_TREE_FACTS_END,
  buildRuntimeTreeProbeScript,
  compareRuntimeTreeAttestations,
  parseRuntimeTreeFacts,
} from "./production-runtime-tree.js";
import type { RuntimeTreeAttestation } from "./production-runtime-tree.js";

const roots: string[] = [];

interface RuntimeTreeFixture {
  readonly root: string;
  readonly packageJson: string;
  readonly tool: string;
  readonly emptyDirectory: string;
  readonly link: string;
}

function outputText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function clearFixtureXattrs(root: string): void {
  if (process.platform !== "darwin") return;
  const cleared = spawnSync("xattr", ["-cr", root], { encoding: "utf8" });
  expect(cleared.status, outputText(cleared.stderr)).toBe(0);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRuntimeTreeFixture(): RuntimeTreeFixture {
  const created = mkdtempSync(join(tmpdir(), "comis-runtime-tree-"));
  const root = realpathSync(created);
  roots.push(root);
  const packageJson = join(root, "package.json");
  const bin = join(root, "bin");
  const tool = join(bin, "tool.js");
  const emptyDirectory = join(root, "empty");
  const link = join(root, "current");

  chmodSync(root, 0o700);
  mkdirSync(bin, { mode: 0o775 });
  mkdirSync(emptyDirectory, { mode: 0o700 });
  writeFileSync(packageJson, '{"name":"comisai","version":"1.2.3"}\n', { mode: 0o666 });
  writeFileSync(tool, "export const value = 1;\n", { mode: 0o666 });
  chmodSync(packageJson, 0o666);
  chmodSync(tool, 0o666);
  chmodSync(bin, 0o775);
  symlinkSync("bin/tool.js", link);
  // Darwin assigns com.apple.provenance to test-created entries. Production
  // package trees must have no xattrs, so make the valid fixture explicit.
  clearFixtureXattrs(root);
  return { root, packageJson, tool, emptyDirectory, link };
}

function executeProbe(root: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-s", "--", root], {
    encoding: "utf8",
    input: buildRuntimeTreeProbeScript(),
    timeout: 30_000,
  });
}

function runProbe(root: string): { raw: string; facts: RuntimeTreeAttestation } {
  const result = executeProbe(root);
  const stderr = outputText(result.stderr);
  const stdout = outputText(result.stdout);
  expect(result.status, stderr).toBe(0);
  expect(stderr).toBe("");
  const parsed = parseRuntimeTreeFacts(stdout);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { raw: stdout, facts: parsed.value };
}

function expectProbeRejection(root: string): void {
  const result = executeProbe(root);
  expect(result.status).not.toBe(0);
  expect(outputText(result.stdout)).toBe("");
}

function makeFacts(overrides: Partial<RuntimeTreeAttestation> = {}): RuntimeTreeAttestation {
  return {
    digestSha256: "a".repeat(64),
    entryCount: 6,
    bytes: 61,
    root: "/opt/comis/node_modules/comisai",
    version: "1.2.3",
    ...overrides,
  };
}

function serializeFacts(facts: RuntimeTreeAttestation): string {
  return [
    RUNTIME_TREE_FACTS_BEGIN,
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `root=${facts.root}`,
    `version=${facts.version}`,
    RUNTIME_TREE_FACTS_END,
    "",
  ].join("\n");
}

function expectedFixtureDigest(fixture: RuntimeTreeFixture): string {
  const entries = [
    ["D", ".", fixture.root, Buffer.alloc(0)],
    ["D", "bin", join(fixture.root, "bin"), Buffer.alloc(0)],
    ["F", "bin/tool.js", fixture.tool, Buffer.from("export const value = 1;\n")],
    ["L", "current", fixture.link, Buffer.from("bin/tool.js")],
    ["D", "empty", fixture.emptyDirectory, Buffer.alloc(0)],
    [
      "F",
      "package.json",
      fixture.packageJson,
      Buffer.from('{"name":"comisai","version":"1.2.3"}\n'),
    ],
  ] as const;
  const digest = createHash("sha256").update(Buffer.from("comis-runtime-tree-v2\0"));
  for (const [kind, relativePath, absolutePath, payload] of entries) {
    const metadata = lstatSync(absolutePath, { bigint: true });
    const mode = (metadata.mode & 0o7777n).toString(8).padStart(4, "0");
    digest.update(Buffer.from(kind));
    for (const field of [
      Buffer.from(relativePath),
      Buffer.from(mode),
      Buffer.from(metadata.uid.toString()),
      Buffer.from(metadata.gid.toString()),
      Buffer.from(metadata.mtimeNs.toString()),
      payload,
    ]) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(field.length));
      digest.update(length).update(field);
    }
  }
  return digest.digest("hex");
}

describe("production runtime tree attestation", () => {
  it("emits deterministic canonical v2 facts from a real tree", () => {
    const fixture = makeRuntimeTreeFixture();
    const first = runProbe(fixture.root);
    const repeated = runProbe(fixture.root);

    expect(first.raw).toBe(repeated.raw);
    expect(first.facts).toEqual({
      digestSha256: expectedFixtureDigest(fixture),
      entryCount: 6,
      bytes:
        Buffer.byteLength('{"name":"comisai","version":"1.2.3"}\n') +
        Buffer.byteLength("export const value = 1;\n"),
      root: fixture.root,
      version: "1.2.3",
    });
    expect(first.raw).not.toContain("tool.js");
    expect(first.raw).not.toContain("export const value");
  });

  it("hashes file bytes paths modes directories and link targets", () => {
    const fixture = makeRuntimeTreeFixture();
    const baseline = runProbe(fixture.root).facts;

    writeFileSync(fixture.tool, "export const value = 2;\n");
    const contentChanged = runProbe(fixture.root).facts;
    expect(contentChanged.digestSha256).not.toBe(baseline.digestSha256);
    expect(contentChanged.bytes).toBe(baseline.bytes);

    writeFileSync(fixture.tool, "export const value = 1;\n");
    chmodSync(fixture.tool, 0o444);
    const modeChanged = runProbe(fixture.root).facts;
    expect(modeChanged.digestSha256).not.toBe(baseline.digestSha256);
    expect(modeChanged.bytes).toBe(baseline.bytes);

    chmodSync(fixture.tool, 0o666);
    unlinkSync(fixture.link);
    symlinkSync("package.json", fixture.link);
    clearFixtureXattrs(fixture.root);
    const linkChanged = runProbe(fixture.root).facts;
    expect(linkChanged.digestSha256).not.toBe(baseline.digestSha256);
    expect(linkChanged.entryCount).toBe(baseline.entryCount);
    expect(linkChanged.bytes).toBe(baseline.bytes);

    unlinkSync(fixture.link);
    symlinkSync("bin/tool.js", fixture.link);
    clearFixtureXattrs(fixture.root);
    renameSync(fixture.emptyDirectory, join(fixture.root, "vacant"));
    const emptyDirectoryPathChanged = runProbe(fixture.root).facts;
    expect(emptyDirectoryPathChanged.digestSha256).not.toBe(baseline.digestSha256);
    expect(emptyDirectoryPathChanged.entryCount).toBe(baseline.entryCount);
    expect(emptyDirectoryPathChanged.bytes).toBe(baseline.bytes);
  });

  it("binds nanosecond modification time into the tree digest", () => {
    const fixture = makeRuntimeTreeFixture();
    const baseline = runProbe(fixture.root).facts;
    const changed = spawnSync("python3", ["-", fixture.tool], {
      encoding: "utf8",
      input: [
        "import os, sys",
        "value = os.stat(sys.argv[1], follow_symlinks=False)",
        "os.utime(sys.argv[1], ns=(value.st_atime_ns, value.st_mtime_ns + 1000), follow_symlinks=False)",
        "",
      ].join("\n"),
    });
    expect(changed.status, outputText(changed.stderr)).toBe(0);
    const mtimeChanged = runProbe(fixture.root).facts;

    expect(mtimeChanged.digestSha256).not.toBe(baseline.digestSha256);
    expect(mtimeChanged.entryCount).toBe(baseline.entryCount);
    expect(mtimeChanged.bytes).toBe(baseline.bytes);
  });

  it("hashes relative path bytes independently from file content", () => {
    const fixture = makeRuntimeTreeFixture();
    const firstName = Buffer.from(`${fixture.root}/raw-first`);
    const secondName = Buffer.from(`${fixture.root}/raw-second`);
    writeFileSync(firstName, "same\n", { mode: 0o666 });
    clearFixtureXattrs(fixture.root);
    const first = runProbe(fixture.root).facts;
    renameSync(firstName, secondName);
    const second = runProbe(fixture.root).facts;

    expect(second.digestSha256).not.toBe(first.digestSha256);
    expect(second.entryCount).toBe(first.entryCount);
    expect(second.bytes).toBe(first.bytes);
  });

  it("accepts safe internal links and rejects escaping dangling or cyclic links", () => {
    const internal = makeRuntimeTreeFixture();
    expect(runProbe(internal.root).facts.entryCount).toBe(6);

    const escaping = makeRuntimeTreeFixture();
    unlinkSync(escaping.link);
    symlinkSync("../outside", escaping.link);
    expectProbeRejection(escaping.root);

    const dangling = makeRuntimeTreeFixture();
    unlinkSync(dangling.link);
    symlinkSync("missing", dangling.link);
    expectProbeRejection(dangling.root);

    const absolute = makeRuntimeTreeFixture();
    unlinkSync(absolute.link);
    symlinkSync("/etc/passwd", absolute.link);
    expectProbeRejection(absolute.root);

    const cyclic = makeRuntimeTreeFixture();
    unlinkSync(cyclic.link);
    symlinkSync("second", cyclic.link);
    symlinkSync("current", join(cyclic.root, "second"));
    expectProbeRejection(cyclic.root);

    const linkedRoot = makeRuntimeTreeFixture();
    const holder = realpathSync(mkdtempSync(join(tmpdir(), "comis-runtime-root-link-")));
    roots.push(holder);
    const rootLink = join(holder, "runtime");
    symlinkSync(linkedRoot.root, rootLink);
    expectProbeRejection(rootLink);
  });

  it("accepts live package modes while rejecting privileged permission bits", () => {
    const liveModes = makeRuntimeTreeFixture();
    chmodSync(liveModes.root, 0o700);
    chmodSync(liveModes.emptyDirectory, 0o777);
    chmodSync(liveModes.packageJson, 0o600);
    chmodSync(liveModes.tool, 0o666);
    expect(runProbe(liveModes.root).facts.entryCount).toBe(6);

    for (const mode of [0o4666, 0o2666]) {
      const fixture = makeRuntimeTreeFixture();
      chmodSync(fixture.tool, mode);
      expectProbeRejection(fixture.root);
    }
    const privilegedDirectory = makeRuntimeTreeFixture();
    chmodSync(privilegedDirectory.emptyDirectory, 0o2700);
    expectProbeRejection(privilegedDirectory.root);
  });

  it("rejects hardlinked regular files and special filesystem entries", () => {
    const hardlinked = makeRuntimeTreeFixture();
    linkSync(hardlinked.tool, join(hardlinked.root, "tool-hardlink"));
    expectProbeRejection(hardlinked.root);

    const special = makeRuntimeTreeFixture();
    const fifo = spawnSync("python3", ["-", join(special.root, "pipe")], {
      encoding: "utf8",
      input: "import os, sys\nos.mkfifo(sys.argv[1], 0o644)\n",
    });
    expect(fifo.status, outputText(fifo.stderr)).toBe(0);
    expectProbeRejection(special.root);

  });

  it("rejects nonempty extended attributes when the filesystem supports them", () => {
    const fixture = makeRuntimeTreeFixture();
    const setAttribute = spawnSync("python3", ["-", fixture.tool], {
      encoding: "utf8",
      input: [
        "import ctypes, errno, os, sys",
        "try:",
        "    if hasattr(os, 'setxattr'):",
        "        os.setxattr(sys.argv[1], b'user.comis_runtime_tree_test', b'present')",
        "    elif sys.platform == 'darwin':",
        "        libc = ctypes.CDLL(None, use_errno=True)",
        "        path = os.fsencode(sys.argv[1])",
        "        value = b'present'",
        "        result = libc.setxattr(path, b'comis_runtime_tree_test', value, len(value), 0, 0)",
        "        if result != 0:",
        "            raise OSError(ctypes.get_errno(), 'setxattr failed')",
        "    else:",
        "        raise OSError(errno.ENOTSUP, 'setxattr unavailable')",
        "except OSError as error:",
        "    if error.errno in (errno.ENOTSUP, getattr(errno, 'EOPNOTSUPP', errno.ENOTSUP), errno.EPERM):",
        "        raise SystemExit(77)",
        "    raise",
        "",
      ].join("\n"),
    });
    if (setAttribute.status === 77) return;
    expect(setAttribute.status, outputText(setAttribute.stderr)).toBe(0);
    expectProbeRejection(fixture.root);
  });

  it("keeps the generated probe metadata read only and valid Bash", () => {
    const fixture = makeRuntimeTreeFixture();
    const before = [fixture.root, fixture.packageJson, fixture.tool, fixture.emptyDirectory].map(
      (path) => {
        const stat = lstatSync(path, { bigint: true });
        return {
          path,
          mode: stat.mode,
          size: stat.size,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
        };
      },
    );
    const script = buildRuntimeTreeProbeScript();

    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(script).toContain("python3");
    expect(script).toContain("O_NOFOLLOW");
    expect(script).toContain("O_NOATIME");
    expect(script).toContain("follow_symlinks=False");
    expect(script).not.toMatch(/(?:^|\s)(?:rm|mv|cp|chmod|chown|tee|install)(?:\s|$)/mu);
    runProbe(fixture.root);

    const after = [fixture.root, fixture.packageJson, fixture.tool, fixture.emptyDirectory].map(
      (path) => {
        const stat = lstatSync(path, { bigint: true });
        return {
          path,
          mode: stat.mode,
          size: stat.size,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
        };
      },
    );
    expect(after).toEqual(before);
  });

  it("fails closed when a regular file mutates during hashing", async () => {
    const fixture = makeRuntimeTreeFixture();
    const largeFile = join(fixture.root, "large.bin");
    writeFileSync(largeFile, "", { mode: 0o666 });
    chmodSync(largeFile, 0o666);
    truncateSync(largeFile, 128 * 1024 * 1024);
    clearFixtureXattrs(fixture.root);
    const child = spawn("bash", ["-s", "--", fixture.root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(buildRuntimeTreeProbeScript());

    const mutation = setInterval(() => appendFileSync(largeFile, "x"), 1);
    const outcome = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout }));
    }).finally(() => clearInterval(mutation));

    expect(outcome.code).not.toBe(0);
    expect(outcome.stdout).toBe("");
  }, 30_000);

  it("parses only the bounded canonical facts envelope", () => {
    const valid = serializeFacts(makeFacts());
    expect(parseRuntimeTreeFacts(valid)).toEqual({ ok: true, value: makeFacts() });
    expect(parseRuntimeTreeFacts("x".repeat(8193)).ok).toBe(false);
    expect(parseRuntimeTreeFacts(`banner\n${valid}`).ok).toBe(false);
    expect(parseRuntimeTreeFacts(valid.slice(0, -1)).ok).toBe(false);
    expect(parseRuntimeTreeFacts(valid.replace("bytes=61", "bytes=061")).ok).toBe(false);
    expect(parseRuntimeTreeFacts(valid.replace("entryCount=6", "entryCount=0")).ok).toBe(false);
    expect(parseRuntimeTreeFacts(valid.replace("digestSha256=", "digestSha256=A")).ok).toBe(false);
    expect(parseRuntimeTreeFacts(valid.replace("root=/opt", "root=relative/opt")).ok).toBe(false);
    expect(parseRuntimeTreeFacts(valid.replace("version=1.2.3", "version=latest")).ok).toBe(false);
    expect(
      parseRuntimeTreeFacts(valid.replace("version=1.2.3", "unknown=value\nversion=1.2.3")).ok,
    ).toBe(false);
    expect(
      parseRuntimeTreeFacts(valid.replace("version=1.2.3", "version=1.2.3\nversion=1.2.3")).ok,
    ).toBe(false);
  });

  it("compares tree identity independently from absolute install roots", () => {
    const expected = makeFacts();
    const matching = makeFacts({ root: "/srv/comis/node_modules/comisai" });
    expect(compareRuntimeTreeAttestations(expected, matching)).toEqual({
      ok: true,
      value: undefined,
    });

    for (const [field, actual] of [
      ["digestSha256", makeFacts({ digestSha256: "b".repeat(64) })],
      ["entryCount", makeFacts({ entryCount: 7 })],
      ["bytes", makeFacts({ bytes: 62 })],
      ["version", makeFacts({ version: "1.2.4" })],
    ] as const) {
      const result = compareRuntimeTreeAttestations(expected, actual);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("runtime_tree_mismatch");
        expect(result.error.field).toBe(field);
      }
    }
  });
});
