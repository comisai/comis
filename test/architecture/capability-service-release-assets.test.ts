// SPDX-License-Identifier: Apache-2.0
/**
 * Guards that the capability-service protocol bundle actually ships as pinned
 * release artifacts.
 *
 * External services do not import `@comis/capability-service-sdk` — it is
 * `private: true` and bundled inside the `comisai` umbrella, reachable only to
 * an installed daemon. A companion service in another language consumes the
 * generated `protocol/` bundle instead, and the ratified distribution decision
 * is a pinned GitHub release artifact rather than a branch commit: a consumer
 * that pins a commit re-resolves to whatever that branch later becomes, while a
 * release asset's bytes are fixed for the tag that produced them.
 *
 * Nothing else can catch a regression here. `capability-service-protocol-bundle.test.ts`
 * proves the committed bundle is internally consistent, but a self-consistent
 * bundle that no workflow ever uploads is still unreachable to every external
 * consumer — that test's own header already claimed release artifacts existed
 * while no workflow attached one. Workflow files are not built, linted, or
 * executed by `pnpm validate`, and the upload only happens on a tag push, which
 * no pull request exercises.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";
import { CAPABILITY_SERVICE_BUNDLE_DIGEST } from "../../packages/capability-service-sdk/src/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SDK_ROOT = resolve(REPO_ROOT, "packages/capability-service-sdk");
const PROTOCOL_ROOT = resolve(SDK_ROOT, "protocol");
const CONSTANTS_FILE = resolve(SDK_ROOT, "src/constants.ts");
const STAGER = resolve(REPO_ROOT, ".github/scripts/stage-capability-protocol-release.mjs");
const RELEASE_WORKFLOW = ".github/workflows/dockerhub-release.yml";

/**
 * The asset basename a consumer pins. DevCrew records the exact download URL in
 * `protocol/comis/provenance.json`, so renaming these breaks every pin that
 * already shipped — treat a change here as a coordinated release-train step.
 */
const ASSET_PREFIX = "comis-capability-service-protocol";
const DESIGN_REF =
  "COMIS-CAPABILITY-SERVICE-PLATFORM-DESIGN.md §13.1 + ratification item 13 — SDK distribution is pinned GitHub release artifacts, npm publication deferred";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

interface StageResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stage(args: readonly string[]): StageResult {
  try {
    const stdout = execFileSync(process.execPath, [STAGER, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** Entry names and file bodies of a USTAR archive, in archive order. */
function readTar(archive: Buffer): Array<{ readonly name: string; readonly body: Buffer | null }> {
  const entries: Array<{ name: string; body: Buffer | null }> = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "");
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const typeflag = field(156, 1);
    offset += 512;
    const body = typeflag === "5" ? null : archive.subarray(offset, offset + size);
    entries.push({ name, body });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface ProtocolManifest {
  readonly protocolId: string;
  readonly bundleDigest: string;
  readonly artifacts: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

function manifest(): ProtocolManifest {
  return JSON.parse(readFileSync(resolve(PROTOCOL_ROOT, "manifest.json"), "utf8")) as ProtocolManifest;
}

describe("capability-service release assets", () => {
  it("attaches the protocol bundle to the release the tag creates", () => {
    const workflow = read(RELEASE_WORKFLOW);
    const violations: ViolationCitation[] = [];

    if (!workflow.includes("stage-capability-protocol-release.mjs")) {
      violations.push({
        file: RELEASE_WORKFLOW,
        line: 0,
        snippet:
          "never stages the capability-service protocol bundle — the generated schemas, fixtures, and manifest reach no external consumer",
      });
    }
    // `softprops/action-gh-release` uploads nothing without a `files:` input,
    // so a staging step alone still ships an assetless release.
    if (!/^\s*files:/m.test(workflow)) {
      violations.push({
        file: RELEASE_WORKFLOW,
        line: 0,
        snippet:
          "the release action declares no `files:` input, so nothing is uploaded even if the bundle was staged",
      });
    }
    if (!workflow.includes(ASSET_PREFIX)) {
      violations.push({
        file: RELEASE_WORKFLOW,
        line: 0,
        snippet: `does not name the \`${ASSET_PREFIX}\` assets a consumer pins`,
      });
    }

    expect(
      violations,
      formatViolations({
        description: "The release ships no capability-service protocol bundle.",
        violations,
        suggestedFix:
          "Stage the bundle with .github/scripts/stage-capability-protocol-release.mjs in the github-release job and pass the staged files to the release action.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("stages exactly the bundle the SDK pins", () => {
    const out = scratch("capability-release-");
    const result = stage(["--tag", "v9.9.9", "--out", out]);

    expect(result.stderr + result.stdout).toContain(CAPABILITY_SERVICE_BUNDLE_DIGEST);
    expect(result.status).toBe(0);

    const staged = readdirSync(out).sort();
    expect(staged).toEqual([
      `${ASSET_PREFIX}-v9.9.9.manifest.json`,
      `${ASSET_PREFIX}-v9.9.9.tar.gz`,
    ]);

    // The sidecar manifest is what a consumer reads to learn the digest and
    // protocol identity without unpacking the archive; it must be the exact
    // committed bytes, not a re-serialization.
    const sidecar = readFileSync(join(out, `${ASSET_PREFIX}-v9.9.9.manifest.json`));
    expect(sha256(sidecar)).toBe(sha256(readFileSync(resolve(PROTOCOL_ROOT, "manifest.json"))));

    const entries = readTar(gunzipSync(readFileSync(join(out, `${ASSET_PREFIX}-v9.9.9.tar.gz`))));
    const files = new Map(
      entries.filter((entry) => entry.body !== null).map((entry) => [entry.name, entry.body!]),
    );
    const root = `${ASSET_PREFIX}-v9.9.9`;

    const current = manifest();
    expect(files.has(`${root}/manifest.json`)).toBe(true);
    for (const artifact of current.artifacts) {
      const body = files.get(`${root}/${artifact.path}`);
      expect(body, `${artifact.path} is missing from the release archive`).toBeDefined();
      expect(sha256(body!), artifact.path).toBe(artifact.sha256);
    }
    // Nothing beyond the inventoried bundle may ride along into the asset.
    expect([...files.keys()].sort()).toEqual(
      [`${root}/manifest.json`, ...current.artifacts.map((a) => `${root}/${a.path}`)].sort(),
    );
  });

  it("refuses to ship a bundle whose bytes drifted from its manifest", () => {
    const root = scratch("capability-drift-");
    const protocolRoot = join(root, "protocol");
    cpSync(PROTOCOL_ROOT, protocolRoot, { recursive: true });
    const victim = join(protocolRoot, "schemas/handshake.request.schema.json");
    writeFileSync(victim, `${readFileSync(victim, "utf8")}\n`);

    const result = stage([
      "--tag",
      "v9.9.9",
      "--out",
      join(root, "out"),
      "--protocol-root",
      protocolRoot,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schemas/handshake.request.schema.json");
  });

  it("refuses to ship a bundle the SDK constant no longer pins", () => {
    const root = scratch("capability-constant-");
    const constants = join(root, "constants.ts");
    writeFileSync(
      constants,
      readFileSync(CONSTANTS_FILE, "utf8").replace(CAPABILITY_SERVICE_BUNDLE_DIGEST, "0".repeat(64)),
    );

    const result = stage([
      "--tag",
      "v9.9.9",
      "--out",
      join(root, "out"),
      "--constants",
      constants,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(CAPABILITY_SERVICE_BUNDLE_DIGEST);
  });

  it("keeps the bundle out of npm publication", () => {
    const sdk = JSON.parse(readFileSync(resolve(SDK_ROOT, "package.json"), "utf8")) as {
      private?: boolean;
    };
    const publish = read(".github/workflows/npm-publish.yml");

    // Ratification item 13 defers npm publication of the SDK. `pnpm publish -r`
    // skips a private package, so the release path must not special-case it back in.
    expect(sdk.private).toBe(true);
    expect(publish).not.toContain("capability-service-sdk");
  });
});
