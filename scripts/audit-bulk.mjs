// SPDX-License-Identifier: Apache-2.0
/**
 * Production-dependency vulnerability audit via npm's bulk advisory endpoint.
 *
 * `pnpm audit` (through at least pnpm 11) still calls the registry's
 * quick-audit endpoints, which npm retired — both now answer HTTP 410, so the
 * CI audit job cannot use it. This script performs the same check against the
 * supported endpoint: it walks the pnpm-lock.yaml PRODUCTION dependency
 * closure (importers' dependencies/optionalDependencies, resolved through
 * snapshots — devDependencies excluded) and POSTs the name→versions map to
 * `POST /-/npm/v1/security/advisories/bulk`, which returns only the
 * advisories affecting the submitted versions.
 *
 * Exit codes: 0 = no advisories; 1 = advisories found or the audit could not
 * run (fail CLOSED — an unreachable registry must not pass as a clean audit).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REGISTRY_BULK_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const BATCH_SIZE = 200;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = parse(readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8"));

/** Split a snapshot ref ("name@1.2.3(peer@x)") into [name, version]. */
function splitRef(ref) {
  const base = ref.includes("(") ? ref.slice(0, ref.indexOf("(")) : ref;
  const at = base.lastIndexOf("@");
  if (at <= 0) return null; // scoped names keep their leading @
  return [base.slice(0, at), base.slice(at + 1)];
}

// Seed the walk with every importer's PROD deps (dependencies +
// optionalDependencies; devDependencies deliberately excluded).
const queue = [];
for (const importer of Object.values(lockfile.importers ?? {})) {
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, entry] of Object.entries(importer?.[section] ?? {})) {
      const version = typeof entry === "string" ? entry : entry?.version;
      if (typeof version === "string" && !version.startsWith("link:")) {
        queue.push(`${name}@${version}`);
      }
    }
  }
}

// Resolve the closure through snapshots (dependencies + optionalDependencies).
const snapshots = lockfile.snapshots ?? {};
const seen = new Set();
const versionsByName = new Map();
while (queue.length > 0) {
  const ref = queue.pop();
  if (seen.has(ref)) continue;
  seen.add(ref);
  const parts = splitRef(ref);
  if (!parts) continue;
  const [name, version] = parts;
  if (!versionsByName.has(name)) versionsByName.set(name, new Set());
  versionsByName.get(name).add(version);
  const snap = snapshots[ref] ?? snapshots[`${name}@${version}`];
  if (!snap) continue;
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [depName, depVersion] of Object.entries(snap[section] ?? {})) {
      if (typeof depVersion === "string" && !depVersion.startsWith("link:")) {
        queue.push(`${depName}@${depVersion}`);
      }
    }
  }
}

const names = [...versionsByName.keys()].sort();
if (names.length === 0) {
  console.error("audit-bulk: resolved 0 production packages from pnpm-lock.yaml — refusing to pass an empty audit");
  process.exit(1);
}

async function postBatch(batch) {
  const body = {};
  for (const name of batch) body[name] = [...versionsByName.get(name)];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(REGISTRY_BULK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

let advisoryCount = 0;
try {
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const result = await postBatch(names.slice(i, i + BATCH_SIZE));
    for (const [name, advisories] of Object.entries(result)) {
      for (const adv of advisories) {
        advisoryCount++;
        const installed = [...versionsByName.get(name)].join(", ");
        console.log(
          `[${adv.severity}] ${name} (installed: ${installed}; vulnerable: ${adv.vulnerable_versions}) — ${adv.title} ${adv.url}`,
        );
      }
    }
  }
} catch (err) {
  console.error(`audit-bulk: bulk advisory request failed — ${err.message}`);
  process.exit(1);
}

if (advisoryCount > 0) {
  console.error(`audit-bulk: ${advisoryCount} advisories affect the production dependency closure (${names.length} packages checked)`);
  process.exit(1);
}
console.log(`audit-bulk: no known vulnerabilities across ${names.length} production packages`);
