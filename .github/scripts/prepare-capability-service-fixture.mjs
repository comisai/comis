#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function fail(message) {
  console.error(`prepare-capability-service-fixture: ${message}`);
  process.exit(1);
}

function readOptions(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("expected --name value arguments");
    options.set(name.slice(2), value);
  }
  for (const name of ["source-root", "source-commit", "fixture-root"]) {
    if (!options.has(name)) fail(`--${name} is required`);
  }
  return options;
}

function canonicalDirectory(path, label) {
  if (!isAbsolute(path) || !existsSync(path)) fail(`${label} must be an existing absolute path`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) fail(`${label} must be a directory`);
  return canonical;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeFixtureOnlyRevision(manifest) {
  const normalized = structuredClone(manifest);
  delete normalized.bundleDigest;
  const fixture = normalized.artifacts?.find((artifact) => artifact.path === "fixtures/valid.json");
  if (fixture === undefined) fail("protocol manifest does not inventory fixtures/valid.json");
  fixture.sha256 = "<canonical-valid-fixture>";
  return normalized;
}

function runGo(fixtureRoot, ...argumentsList) {
  execFileSync("go", argumentsList, { cwd: fixtureRoot, stdio: "inherit" });
}

function ratifyFixtureOnlyDigest(fixtureRoot, previousDigest, currentDigest) {
  const generatorPath = resolve(fixtureRoot, "internal/comiswire/generator/generator.go");
  const previousPin = `expectedBundleDigest = "${previousDigest}"`;
  const currentPin = `expectedBundleDigest = "${currentDigest}"`;
  const generator = readFileSync(generatorPath, "utf8");
  if (generator.split(previousPin).length !== 2) {
    fail("reviewed fixture generator does not contain exactly one expected bundle pin");
  }
  writeFileSync(generatorPath, generator.replace(previousPin, currentPin));
}

const options = readOptions(process.argv.slice(2));
const sourceRoot = canonicalDirectory(options.get("source-root"), "source root");
const fixtureRoot = canonicalDirectory(options.get("fixture-root"), "fixture root");
const sourceCommit = options.get("source-commit");
if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) fail("source commit must be a full lowercase Git hash");

const sourceManifest = readJson(resolve(
  sourceRoot,
  "packages/capability-service-sdk/protocol/manifest.json",
));
const fixtureManifest = readJson(resolve(fixtureRoot, "protocol/comis/manifest.json"));

// The companion source is reviewed against an exact protocol pin. A Comis PR may
// refresh only the canonical valid-example corpus in this test checkout. Any
// schema, catalog, limit, or other artifact change still requires a newly reviewed
// companion revision and fails before its digest guard is touched.
try {
  assert.deepStrictEqual(
    normalizeFixtureOnlyRevision(sourceManifest),
    normalizeFixtureOnlyRevision(fixtureManifest),
  );
} catch {
  fail("current protocol differs from the reviewed fixture beyond fixtures/valid.json");
}

runGo(
  fixtureRoot,
  "run",
  "./tools/protocolcheck",
  "-root",
  "protocol/comis",
  "-generated",
  "internal/comiswire/protocol.gen.go",
);

if (sourceManifest.bundleDigest !== fixtureManifest.bundleDigest) {
  ratifyFixtureOnlyDigest(
    fixtureRoot,
    fixtureManifest.bundleDigest,
    sourceManifest.bundleDigest,
  );
}

runGo(
  fixtureRoot,
  "run",
  "./tools/protocolsync",
  "-source-root",
  sourceRoot,
  "-source-commit",
  sourceCommit,
  "-destination-root",
  "protocol/comis",
);
runGo(
  fixtureRoot,
  "run",
  "./tools/protocolgen",
  "-protocol-root",
  "protocol/comis",
  "-output",
  "internal/comiswire/protocol.gen.go",
);
runGo(
  fixtureRoot,
  "run",
  "./tools/protocolcheck",
  "-root",
  "protocol/comis",
  "-generated",
  "internal/comiswire/protocol.gen.go",
);
