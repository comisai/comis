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
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file's own directory. In the source checkout that is
// <repo>/test/live/self-driving/scripts; on the box it is /root (deploy-scripts.sh globs *.mjs
// there), which is exactly why the repo root is only derived in local mode.
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "../../../..");
const localRigEnvPath = resolve(scriptsDir, ".rig-env");

const readRigEnv = (path) => {
  const vars = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
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
};

// RIG_MODE=local — the rig is THIS machine: the daemon runs from this checkout against a local data
// dir (default ~/.comis) and every default below shifts from the VPS production-install layout to
// the caller's own. A bare helper invoked after local-up must discover that mode from the rendered
// checkout-local .rig-env; deciding "remote" before reading it split injection from the trajectory
// oracle (the emulator worked, while evidence was searched under /home/comis/.comis).
const initialRigEnvPath =
  process.env.RIG_ENV ||
  (process.env.RIG_MODE === "remote" ? "/root/comis-rig.env" : localRigEnvPath);
let fileVars = readRigEnv(initialRigEnvPath);
const resolvedMode = process.env.RIG_MODE || fileVars.RIG_MODE || "remote";
const isLocal = resolvedMode === "local";
const RIG_ENV_PATH =
  process.env.RIG_ENV || (isLocal ? localRigEnvPath : "/root/comis-rig.env");
if (RIG_ENV_PATH !== initialRigEnvPath) fileVars = readRigEnv(RIG_ENV_PATH);

const pick = (...cands) => cands.find((v) => v !== undefined && v !== "");

const comisUser = pick(process.env.COMIS_USER, fileVars.COMIS_USER, isLocal ? userInfo().username : "comis");
const comisHome = pick(
  process.env.COMIS_HOME,
  fileVars.COMIS_HOME,
  isLocal ? homedir() : `/home/${comisUser}`,
);
const dataDir = pick(process.env.COMIS_DATA_DIR, process.env.DATA, fileVars.DATA, `${comisHome}/.comis`);

// The Comis code root on this box — an installed comisai package dir OR a source checkout.
const codeRoot = (() => {
  const explicit = pick(process.env.COMIS_SRC, fileVars.PKG, fileVars.SRC);
  if (explicit) return explicit;
  // Local mode: the checkout this helper lives in IS the build under test — never an installed
  // package elsewhere on the machine. Resolving to a stale global `comisai` here would reproduce
  // the exact wrong-build false result the remote rig's provenance checks exist to catch.
  if (isLocal && existsSync(`${repoRoot}/packages/daemon/dist`)) return repoRoot;
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
  /** "local" (this machine) or "remote" (the VPS production install) — the shell twin is `_rig.sh`. */
  mode: isLocal ? "local" : "remote",
  /** True when the rig is this machine, so a helper can skip ownership/privilege steps. */
  isLocal,
  comisUser,
  comisHome,
  dataDir,
  codeRoot,
  layout,
  /** The repo root — meaningful in local mode (in remote mode the helper runs from /root). */
  repoRoot,
  chatId: pick(process.env.CHATID, fileVars.CHATID, "678314278"),
  service: pick(process.env.SERVICE, fileVars.SERVICE, "comis"),
  gwPort: Number(pick(process.env.GW_PORT, fileVars.GW_PORT, "4766")),
  emuDir: pick(process.env.EMU_DIR, fileVars.EMU_DIR, isLocal ? repoRoot : "/root/comis-emu"),
  emuWiringPath: pick(process.env.EMU_JSON, fileVars.EMU_JSON, "/tmp/comis-emu.json"),
};
