// wire-emu.mjs — VPS (run as ROOT): point the daemon's Telegram adapter at the RUNNING emulator.
// Reads the emulator wiring (/tmp/comis-emu.json — written by vps-emu on boot) and rewrites
// $DATA/config.yaml's channels.telegram to { enabled, apiRoot: <emu>, botToken: <emu fake token> },
// ensuring allowFrom contains the drive CHATID. The port is KERNEL-ALLOCATED, so this must re-run
// after EVERY restart-emu.sh (then restart the daemon: bash /root/restart-daemon.sh).
//
// File-edit (not the config.patch RPC) on purpose: works with the daemon DOWN and needs no gateway
// token; the ORIGINAL channel block is preserved once at $DATA/config.pre-emu.yaml (first wire only)
// so the box can be rewired to real Telegram by restoring it.
//
//   node /root/wire-emu.mjs           # wire → prints the patch; then restart the daemon
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rig, requireCodeRoot } from "./_rig.mjs";

const YAML = requireCodeRoot("yaml");
const emu = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
if (!emu.apiRoot || !emu.botToken) throw new Error(`bad emulator wiring at ${rig.emuWiringPath}: ${JSON.stringify(emu)}`);

const cfgPath = `${rig.dataDir}/config.yaml`;
const backup = `${rig.dataDir}/config.pre-emu.yaml`;
if (!existsSync(cfgPath)) {
  console.error(`no ${cfgPath} — a fresh box has no config (install-vps.sh runs --no-init).`);
  console.error("Bootstrap one first:  node /root/init-config.mjs   (renders the rig template + token)");
  process.exit(2);
}
const cfg = YAML.parse(readFileSync(cfgPath, "utf8")) ?? {};
if (!existsSync(backup)) copyFileSync(cfgPath, backup); // first wire only — keep the REAL-telegram original

cfg.channels ??= {};
const tg = (cfg.channels.telegram ??= {});
const before = { apiRoot: tg.apiRoot, botToken: tg.botToken ? "<set>" : "<unset>" };
tg.enabled = true;
tg.apiRoot = emu.apiRoot;
tg.botToken = emu.botToken; // the emulator's fake token LITERAL (a ${REF} would resolve to the real one)
tg.allowFrom ??= [];
if (!tg.allowFrom.map(String).includes(String(rig.chatId))) tg.allowFrom.push(String(rig.chatId));

writeFileSync(cfgPath, YAML.stringify(cfg));
try {
  chmodSync(cfgPath, 0o600);
  chmodSync(backup, 0o600);
  execFileSync("chown", [`${rig.comisUser}:${rig.comisUser}`, cfgPath, backup]);
} catch {
  /* non-root local runs: ownership already right */
}
console.log(
  `wired channels.telegram → ${emu.apiRoot} (was ${before.apiRoot ?? "<real Telegram>"}), ` +
    `botToken=<emulator>, allowFrom+=${rig.chatId}; original kept at ${backup}`,
);
console.log("NEXT: bash /root/restart-daemon.sh   (the daemon reads config at boot)");
