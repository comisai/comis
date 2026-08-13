// mcp-server-patch.mjs — safely update bounded parallelism for one existing MCP server.
//
// This intentionally accepts only the two per-server concurrency controls. The generic
// cfg-patch helper deep-merges objects, but MCP servers are stored as an array; replacing that
// array from a redacted operator view can silently erase credentials or unrelated servers.
//
// Usage on a rig host:
//   node /root/mcp-server-patch.mjs <server-name> \
//     '{"maxConcurrency":4,"supportsParallelToolCalls":true}'

import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { comisDist, requireCodeRoot, rig } from "./_rig.mjs";

const YAML = requireCodeRoot("yaml");
const configPath = `${rig.dataDir}/config.yaml`;
const serverName = process.argv[2];
const patchArg = process.argv[3];

if (typeof serverName !== "string" || serverName.length === 0 || patchArg === undefined) {
  console.error(
    "usage: mcp-server-patch.mjs <server-name> "
      + "'<JSON with maxConcurrency and/or supportsParallelToolCalls>'",
  );
  process.exit(2);
}

const patchRaw = existsSync(patchArg) ? readFileSync(patchArg, "utf8") : patchArg;
const patch = JSON.parse(patchRaw);
const allowedKeys = new Set(["maxConcurrency", "supportsParallelToolCalls"]);

if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
  console.error("MCP server patch must be a JSON object");
  process.exit(2);
}
const patchKeys = Object.keys(patch);
if (patchKeys.length === 0 || patchKeys.some((key) => !allowedKeys.has(key))) {
  console.error(
    "MCP server patch may contain only maxConcurrency and supportsParallelToolCalls",
  );
  process.exit(2);
}
if (
  patch.maxConcurrency !== undefined
  && (!Number.isInteger(patch.maxConcurrency) || patch.maxConcurrency < 1)
) {
  console.error("maxConcurrency must be a positive integer");
  process.exit(2);
}
if (
  patch.supportsParallelToolCalls !== undefined
  && typeof patch.supportsParallelToolCalls !== "boolean"
) {
  console.error("supportsParallelToolCalls must be boolean");
  process.exit(2);
}

const config = YAML.parse(readFileSync(configPath, "utf8")) ?? {};
const servers = config.integrations?.mcp?.servers;
if (!Array.isArray(servers)) {
  console.error("config has no integrations.mcp.servers array");
  process.exit(1);
}
const matches = servers.filter((entry) => entry?.name === serverName);
if (matches.length !== 1) {
  console.error(`expected exactly one MCP server named ${JSON.stringify(serverName)}`);
  process.exit(1);
}
Object.assign(matches[0], patch);

const { AppConfigSchema } = await import(comisDist("core", "dist/index.js"));
const validation = AppConfigSchema.safeParse(config);
if (!validation.success) {
  console.error("MCP server patch refused because the resulting config is invalid");
  for (const issue of validation.error.issues) {
    console.error(`  ${issue.path.join(".") || "<root>"}: ${issue.message}`);
  }
  process.exit(1);
}

const backupPath = `${configPath}.bak-mcp-server`;
copyFileSync(configPath, backupPath);
writeFileSync(configPath, YAML.stringify(config));
if (typeof process.getuid === "function" && process.getuid() === 0) {
  execFileSync("chown", [
    `${rig.comisUser}:${rig.comisUser}`,
    configPath,
    backupPath,
  ]);
}

console.log(`patched MCP server ${JSON.stringify(serverName)} (backup: ${backupPath})`);
for (const key of patchKeys) console.log(`${key}=${JSON.stringify(patch[key])}`);
