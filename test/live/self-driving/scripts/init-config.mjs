// init-config.mjs — VPS (run as ROOT): bootstrap a rig-ready config.yaml on a FRESH box.
// Closes the last gap between `install-vps.sh --no-init` (which deliberately writes no config) and a
// green Phase 0: renders /root/config.example.yaml (shipped by deploy-scripts.sh) into
// $DATA/config.yaml with a freshly GENERATED ≥32-char gateway token, the rig CHATID in
// allowFrom/senderTrustMap, and channels.telegram DISABLED (wire-emu.mjs enables it with the live
// emulator port — rendering it enabled would leave the adapter polling a placeholder URL).
// Also: ensures the secrets master key exists (`comis secrets init` when $DATA/.env is absent),
// fixes ownership, and updates /root/comis-rig.env's GWTOKEN so the RPC helpers work immediately
// (the next deploy-scripts.sh re-render re-fetches the same token from the config literal).
//
//   node /root/init-config.mjs            # refuses if $DATA/config.yaml already exists
//   node /root/init-config.mjs --force    # replace an existing config (backup kept)
// Env: PROVIDER / MODEL override the template's agent provider+model (e.g. PROVIDER=openai-codex
// MODEL=gpt-5.5); DATA/CHATID/GW_PORT/COMIS_USER come from /root/comis-rig.env via _rig.mjs.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { rig, requireCodeRoot } from "./_rig.mjs";

const YAML = requireCodeRoot("yaml");
const force = process.argv.includes("--force");
const templatePath = "/root/config.example.yaml";
const cfgPath = `${rig.dataDir}/config.yaml`;

if (!existsSync(templatePath)) {
  console.error(`no ${templatePath} — run deploy-scripts.sh first (it ships the template)`);
  process.exit(2);
}
if (existsSync(cfgPath) && !force) {
  console.error(`${cfgPath} already exists — this box is NOT fresh. Re-run with --force to replace it`);
  console.error(`(a backup is kept at config.yaml.pre-init); the emulator wire is wire-emu.mjs, not this.`);
  process.exit(2);
}

const cfg = YAML.parse(readFileSync(templatePath, "utf8"));
const token = randomBytes(24).toString("hex"); // 48 chars — comfortably over the ≥32 floor

cfg.dataDir = rig.dataDir;
cfg.gateway.port = rig.gwPort;
cfg.gateway.tokens[0].secret = token;

const agent = cfg.agents.default;
if (process.env.PROVIDER) agent.provider = process.env.PROVIDER;
if (process.env.MODEL) agent.model = process.env.MODEL;
// The template carries the default drive id — re-key trust + ingress to THIS rig's CHATID.
agent.elevatedReply.senderTrustMap = { [String(rig.chatId)]: "admin" };
cfg.channels.telegram.allowFrom = [String(rig.chatId)];
// Disabled until wire-emu.mjs points it at a RUNNING emulator (kernel-allocated port).
cfg.channels.telegram.enabled = false;
delete cfg.channels.telegram.apiRoot; // the "http://127.0.0.1:PORT" placeholder — wire-emu sets the real one

mkdirSync(rig.dataDir, { recursive: true });
if (existsSync(cfgPath)) copyFileSync(cfgPath, `${cfgPath}.pre-init`);
writeFileSync(cfgPath, YAML.stringify(cfg), { mode: 0o600 });

// Fresh box → no master key → security.storage: encrypted cannot open. `comis secrets init` is
// idempotent-by-guard here (only runs when $DATA/.env is absent). COMIS_CONFIG_PATHS pins the CLI
// to THIS config so the key lands in THIS dataDir even when it isn't the default ~/.comis.
// SKIP_SECRETS_INIT=1 skips it (scratch renders / boxes where the operator owns key management).
let secretsNote = "master key already present";
if (process.env.SKIP_SECRETS_INIT === "1") {
  secretsNote = "skipped (SKIP_SECRETS_INIT=1)";
} else if (!existsSync(`${rig.dataDir}/.env`)) {
  try {
    execSync(`su - ${rig.comisUser} -c "COMIS_CONFIG_PATHS='${cfgPath}' comis secrets init"`, { stdio: "pipe", timeout: 60000 });
    secretsNote = "generated a new secrets master key (comis secrets init)";
  } catch (e) {
    secretsNote = `comis secrets init FAILED (${String(e?.message || e).slice(0, 120)}) — run it as ${rig.comisUser} before driving`;
  }
}
try {
  execSync(`chown -R ${rig.comisUser}:${rig.comisUser} '${rig.dataDir}'`);
} catch {
  /* non-root runs: ownership already right */
}

// Keep the box-side rig env coherent so revoke.mjs & co work immediately (RIG_ENV overrides the
// path — same env _rig.mjs reads, so scratch renders never touch the real rig env).
const rigEnvPath = process.env.RIG_ENV || "/root/comis-rig.env";
try {
  if (existsSync(rigEnvPath)) {
    const lines = readFileSync(rigEnvPath, "utf8").split("\n");
    const rendered = `export GWTOKEN="\${GWTOKEN:-${token}}"`;
    const i = lines.findIndex((l) => l.startsWith("export GWTOKEN="));
    if (i === -1) lines.push(rendered);
    else lines[i] = rendered;
    writeFileSync(rigEnvPath, lines.join("\n"), { mode: 0o600 });
  }
} catch {
  /* rig env absent — deploy-scripts.sh will render it (and auto-fetch this token) */
}

console.log(`wrote ${cfgPath} (provider=${agent.provider} model=${agent.model} chatId=${rig.chatId}; telegram disabled until wired)`);
console.log(`gateway token (also in the config + ${rigEnvPath}): ${token}`);
console.log(`secrets: ${secretsNote}`);
console.log("NEXT:");
console.log(`  1. provider credentials:  su - ${rig.comisUser} -c 'comis secrets set ANTHROPIC_API_KEY'   (or comis oauth login …)`);
console.log("  2. emulator + wire + restart:  WIRE=1 ./deploy-emu.sh   (locally)   — or on-box:");
console.log("       bash /root/restart-emu.sh && node /root/wire-emu.mjs && bash /root/restart-daemon.sh");
