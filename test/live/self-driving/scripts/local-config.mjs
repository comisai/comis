import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

function fail(message) {
  console.error(message);
  process.exit(2);
}

let YAML;
try {
  YAML = createRequire(resolve(repo, "package.json"))("yaml");
} catch {
  fail(
    "the project yaml dependency is unavailable; install project dependencies before initializing the rig",
  );
}

function canonicalPath(input) {
  const missing = [];
  let existing = resolve(input);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...missing);
}

function parsePort(input) {
  if (!/^\d+$/.test(input)) fail(`gateway port must be an integer (got '${input}')`);
  const port = Number(input);
  if (port < 1024 || port > 65535) {
    fail(`gateway port must be between 1024 and 65535 (got '${input}')`);
  }
  return port;
}

function assertSelectedPaths(configPath, dataDir) {
  if (!isAbsolute(dataDir)) fail(`data root must be absolute (got '${dataDir}')`);
  const canonicalData = canonicalPath(dataDir);
  if (dataDir !== canonicalData) {
    fail(`data root must be canonical and symlink-free (use '${canonicalData}')`);
  }
  if (configPath !== resolve(dataDir, "config.yaml")) {
    fail(`config path must be exactly '${resolve(dataDir, "config.yaml")}'`);
  }
}

function assertContainedPath(label, input, dataDir) {
  if (input === undefined) return;
  if (typeof input !== "string" || !isAbsolute(input)) {
    fail(`${label} must be an absolute path inside '${dataDir}'`);
  }
  const canonical = canonicalPath(input);
  if (input !== canonical) {
    fail(`${label} must be canonical and symlink-free (use '${canonical}')`);
  }
  const canonicalData = canonicalPath(dataDir);
  if (canonical !== canonicalData && !canonical.startsWith(`${canonicalData}/`)) {
    fail(`${label} must stay inside the isolated data root '${canonicalData}'`);
  }
}

function parseConfig(configPath) {
  let config;
  try {
    config = YAML.parse(readFileSync(configPath, "utf8"), { uniqueKeys: true });
  } catch {
    fail(`cannot parse authoritative config '${configPath}'`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail(`authoritative config '${configPath}' must contain a YAML mapping`);
  }
  return config;
}

function validate(configPath, dataDir, portInput) {
  assertSelectedPaths(configPath, dataDir);
  const port = parsePort(portInput);
  const config = parseConfig(configPath);
  if (config.dataDir !== dataDir) {
    fail(`config dataDir must be exactly '${dataDir}' (got '${String(config.dataDir)}')`);
  }
  if (
    config.gateway === null ||
    typeof config.gateway !== "object" ||
    Array.isArray(config.gateway)
  ) {
    fail("config gateway must be a YAML mapping");
  }
  if (config.gateway.port !== port) {
    fail(`config gateway.port must be exactly ${port} (got '${String(config.gateway.port)}')`);
  }
  assertContainedPath("diagnostics.trajectory.dir", config.diagnostics?.trajectory?.dir, dataDir);
  assertContainedPath(
    "observability.trajectory.dirOverride",
    config.observability?.trajectory?.dirOverride,
    dataDir,
  );
  console.log(`validated isolated config root ${dataDir} on gateway port ${port}`);
}

function assertLocalInitSelection(configPath, dataDir, portInput) {
  assertSelectedPaths(configPath, dataDir);
  parsePort(portInput);
  if (process.env.RIG_MODE !== "local") {
    fail("local config initialization requires RIG_MODE=local");
  }
  if (process.env.DATA !== dataDir || process.env.COMIS_DATA_DIR !== dataDir) {
    fail("DATA and COMIS_DATA_DIR must match the selected local data root");
  }
  if (process.env.COMIS_CONFIG_PATHS !== configPath) {
    fail("COMIS_CONFIG_PATHS must name only the selected local config");
  }
  if (process.env.GW_PORT !== portInput) fail("GW_PORT must match the selected local gateway port");
  const service = process.env.SERVICE ?? "";
  if (service === "comis" || !/^[A-Za-z0-9_.-]+$/.test(service)) {
    fail("SERVICE must name a dedicated local rig and must not be 'comis'");
  }
  const home = process.env.HOME ?? "";
  if (!isAbsolute(home)) fail("HOME must be absolute before local config initialization");
  const everyday = canonicalPath(resolve(home, ".comis"));
  if (dataDir === everyday || dataDir.startsWith(`${everyday}/`)) {
    fail(`data root must not be inside the operator's everyday ${resolve(home, ".comis")} tree`);
  }
}

function ensureMasterKey(dataDir) {
  const envPath = resolve(dataDir, ".env");
  if (existsSync(envPath)) {
    chmodSync(envPath, 0o600);
    const current = readFileSync(envPath, "utf8");
    if (/^SECRETS_MASTER_KEY=/m.test(current)) {
      return { envPath, created: false };
    }
    appendFileSync(envPath, `\nSECRETS_MASTER_KEY=${randomBytes(32).toString("hex")}\n`);
    return { envPath, created: true };
  }
  writeFileSync(envPath, `SECRETS_MASTER_KEY=${randomBytes(32).toString("hex")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { envPath, created: true };
}

function initialize(configPath, dataDir, portInput, chatId) {
  assertLocalInitSelection(configPath, dataDir, portInput);
  if (existsSync(configPath)) {
    fail(`${configPath} already exists; local initialization never overwrites it`);
  }
  const port = parsePort(portInput);
  const config = parseConfig(resolve(here, "config.example.yaml"));
  const token = randomBytes(24).toString("hex");
  config.dataDir = dataDir;
  config.gateway.host = "127.0.0.1";
  config.gateway.port = port;
  config.gateway.tokens[0].secret = token;
  config.agents.default.elevatedReply.senderTrustMap = { [String(chatId)]: "admin" };
  config.channels.telegram.enabled = false;
  config.channels.telegram.allowFrom = [String(chatId)];
  delete config.channels.telegram.apiRoot;

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const masterKey = ensureMasterKey(dataDir);
  writeFileSync(configPath, YAML.stringify(config), { flag: "wx", mode: 0o600 });
  validate(configPath, dataDir, portInput);
  console.log(`wrote isolated local config ${configPath}`);
  console.log(
    `${masterKey.created ? "created" : "retained"} encrypted master-key file ${masterKey.envPath}`,
  );
  console.log(
    "provider credentials were not copied; add them through the encrypted CLI secret or OAuth flow",
  );
}

const [command, configPath, dataDir, portInput, chatId = "678314278"] =
  process.argv.slice(2);
if (!command || !configPath || !dataDir || !portInput) {
  fail(
    "usage: local-config.mjs <init|validate> <config-path> <data-root> <gateway-port> [chat-id]",
  );
}

if (command === "validate") validate(configPath, dataDir, portInput);
else if (command === "init") initialize(configPath, dataDir, portInput, chatId);
else fail(`unknown local config command '${command}'`);
