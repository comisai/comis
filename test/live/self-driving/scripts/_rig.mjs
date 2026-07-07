// _rig.mjs — ONE place that decides where the rig lives, shared by every box-side .mjs helper.
// (deploy-scripts.sh globs *.mjs to /root/, so this module rides along and `./…` imports resolve.)
//
// Resolution order for every value (first hit wins):
//   1. explicit env  (COMIS_SRC, COMIS_DATA_DIR/DATA, COMIS_USER, COMIS_HOME, CHATID, SERVICE,
//      GW_PORT, EMU_DIR, GWTOKEN/COMIS_GATEWAY_TOKEN)
//   2. /root/comis-rig.env — rendered ON the box by deploy-scripts.sh from the local .live-env
//      (lines are `export K="${K:-value}"`, so bash sourcing keeps explicit-env-wins too)
//   3. auto-detection / the standard-install defaults.
//
// Code root: BOTH layouts are supported transparently —
//   installed package  <root>/node_modules/@comis/<pkg>/dist/…   (install.sh / npm i -g comisai)
//   source checkout    <root>/packages/<pkg>/dist/…              (rsync'd repo tree)
// so a helper never hand-builds either path: use comisDist()/importCli()/requireCodeRoot().
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const RIG_ENV_PATH = process.env.RIG_ENV || "/root/comis-rig.env";

const fileVars = (() => {
  const vars = {};
  try {
    for (const line of readFileSync(RIG_ENV_PATH, "utf8").split("\n")) {
      // `export K="${K:-value}"` (deploy-scripts renders this) or plain `K=value` / `K="value"`.
      const m =
        line.match(/^export\s+(\w+)="\$\{\w+:-(.*)\}"\s*$/) ||
        line.match(/^(?:export\s+)?(\w+)="?([^"]*)"?\s*$/);
      if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
    }
  } catch {
    /* no rig file — env + defaults carry it */
  }
  return vars;
})();

const pick = (...cands) => cands.find((v) => v !== undefined && v !== "");

const comisUser = pick(process.env.COMIS_USER, fileVars.COMIS_USER, "comis");
const comisHome = pick(process.env.COMIS_HOME, fileVars.COMIS_HOME, `/home/${comisUser}`);
const dataDir = pick(process.env.COMIS_DATA_DIR, process.env.DATA, fileVars.DATA, `${comisHome}/.comis`);

// The Comis code root on this box — an installed comisai package dir OR a source checkout.
const codeRoot = (() => {
  const explicit = pick(process.env.COMIS_SRC, fileVars.PKG, fileVars.SRC);
  if (explicit) return explicit;
  for (const cand of [
    `${comisHome}/.npm-global/lib/node_modules/comisai`, // install.sh dedicated-user default
    "/usr/lib/node_modules/comisai", // root-prefix global install
    "/usr/local/lib/node_modules/comisai",
    "/root/comis-src", // legacy rsync'd source rig
  ]) {
    if (existsSync(cand)) return cand;
  }
  return `${comisHome}/.npm-global/lib/node_modules/comisai`;
})();

// installed layout ⇔ @comis/* under the package's own node_modules; source ⇔ packages/<pkg>.
const layout = existsSync(`${codeRoot}/node_modules/@comis/cli/dist`)
  ? "installed"
  : existsSync(`${codeRoot}/packages/cli/dist`)
    ? "source"
    : "installed";

/** Absolute path into a @comis package (rel is package-relative, e.g. "dist/client/rpc-client.js"). */
export const comisDist = (pkg, rel) =>
  layout === "installed" ? `${codeRoot}/node_modules/@comis/${pkg}/${rel}` : `${codeRoot}/packages/${pkg}/${rel}`;

/** Dynamic-import a CLI dist module (e.g. importCli("client/rpc-client.js") → { withClient }). */
export const importCli = (rel) => import(comisDist("cli", `dist/${rel}`));

/** Require a third-party runtime dep (better-sqlite3, yaml, …) from the code root's tree. */
export const requireCodeRoot = (name) => {
  // installed: deps live at <root>/node_modules; source: pnpm nests them per-package.
  const anchors =
    layout === "installed"
      ? [`${codeRoot}/package.json`]
      : [`${codeRoot}/packages/daemon/package.json`, `${codeRoot}/packages/memory/package.json`, `${codeRoot}/package.json`];
  let lastErr;
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(name);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
};

/** Default the RPC client env (config path + gateway token) so ad-hoc calls need no env prefix. */
export const ensureRpcEnv = () => {
  if (!process.env.COMIS_CONFIG_PATHS) process.env.COMIS_CONFIG_PATHS = `${dataDir}/config.yaml`;
  const tok = pick(process.env.COMIS_GATEWAY_TOKEN, process.env.GWTOKEN, fileVars.GWTOKEN);
  if (tok && !process.env.COMIS_GATEWAY_TOKEN) process.env.COMIS_GATEWAY_TOKEN = tok;
};

export const rig = {
  comisUser,
  comisHome,
  dataDir,
  codeRoot,
  layout,
  chatId: pick(process.env.CHATID, fileVars.CHATID, "678314278"),
  service: pick(process.env.SERVICE, fileVars.SERVICE, "comis"),
  gwPort: Number(pick(process.env.GW_PORT, fileVars.GW_PORT, "4766")),
  emuDir: pick(process.env.EMU_DIR, fileVars.EMU_DIR, "/root/comis-emu"),
  emuWiringPath: pick(process.env.EMU_JSON, fileVars.EMU_JSON, "/tmp/comis-emu.json"),
};
