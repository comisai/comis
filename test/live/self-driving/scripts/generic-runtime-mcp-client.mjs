#!/usr/bin/env node
// Configure, exercise, and clean one permission-gated Comis MCP client.
// Probe output is content-free; the temporary bearer is never printed.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { requireCodeRoot, rig } from "./_rig.mjs";

const TOKEN_ID = "generic-runtime-mcp-client";
const STATE_PATH = "/root/generic-runtime-mcp-client-state.json";
const CONFIG_PATH = `${rig.dataDir}/config.yaml`;
const command = process.argv[2];
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function writeConfig(config) {
  const YAML = requireCodeRoot("yaml");
  writeFileSync(CONFIG_PATH, YAML.stringify(config), { encoding: "utf8", mode: 0o600 });
  execFileSync("chown", [`${rig.comisUser}:${rig.comisUser}`, CONFIG_PATH]);
}

if (command === "configure") {
  const YAML = requireCodeRoot("yaml");
  const config = YAML.parse(readFileSync(CONFIG_PATH, "utf8")) ?? {};
  const secret = randomBytes(48).toString("base64url");
  config.gateway ??= {};
  config.gateway.tokens = (config.gateway.tokens ?? []).filter((token) => token.id !== TOKEN_ID);
  config.gateway.tokens.push({
    id: TOKEN_ID,
    secret,
    scopes: ["mcp-client"],
    mcpClient: {
      allowlist: ["obs_system_health"],
      sessionAllowlist: [],
      toolRateLimit: {},
    },
  });
  writeConfig(config);
  writeFileSync(STATE_PATH, `${JSON.stringify({ secret })}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ configured: true, tokenId: TOKEN_ID, allowlist: ["obs_system_health"] })}\n`);
  process.exit(0);
}

if (command === "probe") {
  if (!existsSync(STATE_PATH)) {
    process.stderr.write("MCP client state is absent; run configure first\n");
    process.exit(2);
  }
  const { secret } = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const runtimeRequire = createRequire(`${rig.codeRoot}/package.json`);
  const { Client } = await import(
    pathToFileURL(runtimeRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(runtimeRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${rig.gwPort}/mcp/v1`),
    { requestInit: { headers: { authorization: `Bearer ${secret}` } } },
  );
  const client = new Client({ name: "generic-runtime-live-probe", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const result = await client.callTool({
      name: "obs_system_health",
      arguments: { sinceHours: 1 },
    });
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    process.stdout.write(`${JSON.stringify({
      connected: true,
      toolCount: listed.tools.length,
      hasSystemHealthTool: listed.tools.some((tool) => tool.name === "obs_system_health"),
      isError: result.isError ?? false,
      reportHasSchemaVersionOne: /"schemaVersion":1/u.test(text),
      reportHasSessionDigest: /"sessions":\{/u.test(text),
      wrappedAsExternalContent: /<<<UNTRUSTED_[a-f0-9]+>>>/u.test(text),
      resultChars: text.length,
      resultHash: sha256(text),
    })}\n`);
  } finally {
    await client.close();
  }
  process.exit(0);
}

if (command === "cleanup") {
  const YAML = requireCodeRoot("yaml");
  const config = YAML.parse(readFileSync(CONFIG_PATH, "utf8")) ?? {};
  if (config.gateway?.tokens) {
    config.gateway.tokens = config.gateway.tokens.filter((token) => token.id !== TOKEN_ID);
    writeConfig(config);
  }
  rmSync(STATE_PATH, { force: true });
  process.stdout.write(`${JSON.stringify({ cleaned: true, tokenId: TOKEN_ID })}\n`);
  process.exit(0);
}

process.stderr.write("usage: generic-runtime-mcp-client.mjs <configure|probe|cleanup>\n");
process.exit(2);
