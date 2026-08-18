#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Stages the generated capability-service protocol bundle as release assets.
 *
 * A companion service written in another language cannot install
 * `@comis/capability-service-sdk`: it is private and bundled inside the
 * `comisai` umbrella for the installed daemon. It consumes the neutral
 * `protocol/` bundle instead, and pins it by exact bytes — so the bundle has to
 * leave this repository as an immutable release artifact rather than a branch
 * commit that re-resolves as the branch moves.
 *
 * Two assets are produced per tag:
 *
 *   comis-capability-service-protocol-<tag>.tar.gz    the whole bundle
 *   comis-capability-service-protocol-<tag>.manifest.json  the sidecar manifest
 *
 * The sidecar is the committed manifest byte-for-byte, so a consumer can read
 * the protocol identity and bundle digest — and every artifact's hash — without
 * downloading and unpacking the archive.
 *
 * Everything is verified before anything is written. A release is the last
 * point at which drift is still cheap: once a companion pins a digest, a
 * bundle whose bytes disagree with its manifest, or a manifest that disagrees
 * with the digest the daemon asserts at handshake, fails every consumer at
 * runtime with a protocol mismatch instead of here with a named file.
 *
 * Deliberately dependency-free and written against node builtins only: the
 * release job checks the repository out without installing the workspace, and
 * the archive is emitted by a fixed-metadata USTAR writer rather than the host
 * `tar` so the same bytes are produced on any runner.
 */

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const sdkRoot = resolve(repositoryRoot, "packages/capability-service-sdk");

const ASSET_PREFIX = "comis-capability-service-protocol";
const BUNDLE_DIGEST_CONSTANT = "CAPABILITY_SERVICE_BUNDLE_DIGEST";

function parseArguments(argv) {
  const options = {
    tag: process.env.GITHUB_REF_NAME ?? "",
    out: "",
    protocolRoot: resolve(sdkRoot, "protocol"),
    constants: resolve(sdkRoot, "src/constants.ts"),
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) fail(`Missing value for ${flag}.`);
    if (flag === "--tag") options.tag = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--protocol-root") options.protocolRoot = resolve(value);
    else if (flag === "--constants") options.constants = resolve(value);
    else fail(`Unknown argument ${flag}.`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(options.tag)) {
    fail(`Release tag ${options.tag || "<missing>"} is not a vX.Y.Z tag.`);
  }
  if (options.out === "") fail("An output directory is required (--out).");
  return options;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Writes one fixed-metadata USTAR entry. Ownership, mode, and timestamps are
 * pinned so re-staging the same commit reproduces the same archive bytes.
 */
function tarHeader(name, size, isDirectory) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";

  if (Buffer.byteLength(name) > 100) fail(`Archive path is too long for USTAR: ${name}`);
  write(name, 0, 100);
  write(octal(isDirectory ? 0o755 : 0o644, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(0, 12), 136, 12);
  header.write("        ", 148, 8, "utf8");
  write(isDirectory ? "5" : "0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write(octal(0, 8), 329, 8);
  write(octal(0, 8), 337, 8);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

function buildArchive(root, entries) {
  const blocks = [tarHeader(`${root}/`, 0, true)];
  const directories = new Set();
  for (const entry of entries) {
    const segments = entry.path.split("/").slice(0, -1);
    let prefix = root;
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`;
      if (directories.has(prefix)) continue;
      directories.add(prefix);
      blocks.push(tarHeader(`${prefix}/`, 0, true));
    }
  }
  for (const entry of entries) {
    blocks.push(tarHeader(`${root}/${entry.path}`, entry.content.length, false));
    blocks.push(entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const options = parseArguments(process.argv.slice(2));

const manifestPath = join(options.protocolRoot, "manifest.json");
let manifestBytes;
try {
  manifestBytes = readFileSync(manifestPath);
} catch {
  fail(`No protocol manifest at ${manifestPath}. Run \`pnpm capability-protocol:generate\` first.`);
}
const manifest = JSON.parse(manifestBytes.toString("utf8"));

// Every inventoried artifact must still hash to what the manifest recorded.
const artifacts = [];
const drifted = [];
for (const artifact of manifest.artifacts) {
  const content = readFileSync(join(options.protocolRoot, artifact.path));
  if (sha256(content) !== artifact.sha256) drifted.push(artifact.path);
  artifacts.push({ path: artifact.path, content });
}
if (drifted.length > 0) {
  console.error(
    "The protocol bundle no longer matches its manifest. These artifacts drifted:",
  );
  for (const path of drifted) console.error(`  ${path}`);
  fail("Regenerate the bundle with `pnpm capability-protocol:generate` before tagging a release.");
}

// The overall digest is derived from the ordered path/hash pairs, so a
// consumer in any language reproduces it without depending on JSON key order.
const derivedDigest = sha256(
  manifest.artifacts.map((artifact) => `${artifact.path}\0${artifact.sha256}\n`).join(""),
);
if (derivedDigest !== manifest.bundleDigest) {
  fail(
    `Manifest bundleDigest ${manifest.bundleDigest} does not match the digest derived ` +
      `from its own artifact inventory (${derivedDigest}).`,
  );
}

// The daemon asserts this constant at handshake. A release whose asset carries
// a different digest hands every consumer a pin the host will reject.
const constantsSource = readFileSync(options.constants, "utf8");
const pinned = new RegExp(`${BUNDLE_DIGEST_CONSTANT}\\s*=\\s*"([a-f0-9]{64})"`).exec(constantsSource);
if (pinned === null) {
  fail(`Could not read ${BUNDLE_DIGEST_CONSTANT} from ${options.constants}.`);
}
if (pinned[1] !== manifest.bundleDigest) {
  fail(
    `${BUNDLE_DIGEST_CONSTANT} is ${pinned[1]} but the staged bundle is ` +
      `${manifest.bundleDigest}. The daemon would reject the digest this asset publishes.`,
  );
}

// The manifest cannot appear in its own inventory — it carries the hashes — so
// it is added to the archive explicitly. Without it the unpacked bundle has no
// record of the digest a consumer is meant to pin.
const archiveRoot = `${ASSET_PREFIX}-${options.tag}`;
const archive = gzipSync(
  buildArchive(archiveRoot, [{ path: "manifest.json", content: manifestBytes }, ...artifacts]),
  { level: 9 },
);

const outputDirectory = resolve(options.out);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, `${archiveRoot}.tar.gz`), archive);
writeFileSync(join(outputDirectory, `${archiveRoot}.manifest.json`), manifestBytes);

console.log(
  `Staged ${manifest.protocolId} bundle ${manifest.bundleDigest} ` +
    `(${artifacts.length} artifacts) as ${archiveRoot}.tar.gz and ${archiveRoot}.manifest.json`,
);
