#!/usr/bin/env node
// Count-only durable-secret residency oracle.
//
// Usage: node secret-residency.mjs SECRET_NAME [SECRET_NAME ...]
//
// Values are retrieved through the authenticated loopback RPC and remain only
// in this process. Output contains names, file categories, and match counts;
// it never prints a value or matching bytes. Exit 1 means plaintext residency.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { ensureRpcEnv, importCli, rig } from "./_rig.mjs";

const secretNames = process.argv.slice(2);
if (secretNames.length === 0) {
  console.error("secret-residency.mjs: pass at least one secret name");
  process.exit(2);
}
if (secretNames.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
  console.error("secret-residency.mjs: secret names must use uppercase letters, digits, and underscores");
  process.exit(2);
}

ensureRpcEnv();
const { withClient } = await importCli("client/rpc-client.js");
const secretResults = await Promise.all(secretNames.map((name) =>
  withClient((client) => client.call("secrets.get", { name }))));
const secrets = secretResults.map((result, index) => {
  if (result?.exists !== true || typeof result.value !== "string" || result.value.length === 0) {
    throw new Error(`Secret ${secretNames[index]} is unavailable`);
  }
  return { name: secretNames[index], bytes: Buffer.from(result.value, "utf8") };
});

const categoryFor = (relativePath) => {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  if (basename.startsWith("secrets.db")) return "encryptedSecretStore";
  if (basename.startsWith("memory.db")) return "memoryAndFts";
  if (relativePath.startsWith("workspace/sessions/")) return "sessions";
  if (relativePath.startsWith("logs/")) return "logs";
  if (
    basename === ".env"
    || basename.startsWith("config.")
    || basename === "config.yaml"
  ) return "config";
  return "other";
};

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
};

const files = [];
const readErrors = [];
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      visit(absolutePath);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    try {
      const stat = lstatSync(absolutePath);
      if (!stat.isFile()) continue;
      files.push(absolutePath);
    } catch {
      readErrors.push(absolutePath.slice(rig.dataDir.length + 1));
    }
  }
};
visit(rig.dataDir);

const categories = [
  "config",
  "logs",
  "sessions",
  "memoryAndFts",
  "encryptedSecretStore",
  "other",
];
const report = Object.fromEntries(secretNames.map((name) => [
  name,
  {
    retrieved: true,
    totalMatches: 0,
    matchesByCategory: Object.fromEntries(categories.map((category) => [category, 0])),
    filesWithMatches: [],
  },
]));

for (const absolutePath of files) {
  let contents;
  try {
    contents = readFileSync(absolutePath);
  } catch {
    readErrors.push(absolutePath.slice(rig.dataDir.length + 1));
    continue;
  }
  const relativePath = absolutePath.slice(rig.dataDir.length + 1);
  const category = categoryFor(relativePath);
  for (const secret of secrets) {
    const count = countOccurrences(contents, secret.bytes);
    if (count === 0) continue;
    const secretReport = report[secret.name];
    secretReport.totalMatches += count;
    secretReport.matchesByCategory[category] += count;
    secretReport.filesWithMatches.push({ path: relativePath, count });
  }
}

const totalMatches = Object.values(report)
  .reduce((sum, secretReport) => sum + secretReport.totalMatches, 0);
console.log(JSON.stringify({
  schemaVersion: 1,
  scannedFiles: files.length,
  readErrors,
  totalMatches,
  secrets: report,
}, null, 2));
process.exit(totalMatches === 0 && readErrors.length === 0 ? 0 : 1);
