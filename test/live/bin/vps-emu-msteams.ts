// SPDX-License-Identifier: Apache-2.0
/**
 * `vps-emu-msteams` — STANDALONE Microsoft Teams emulator launcher for an
 * EXTERNAL daemon (the VPS production daemon, a test env). The Teams sibling of
 * `vps-emu.ts`.
 *
 * Teams is the INVERSE of Telegram: the daemon does not connect OUT to the
 * emulator, it EXPOSES an inbound webhook + posts OUTBOUND to the Connector. So
 * this launcher starts the `MsTeamsEmulator` (the fake Bot Framework Connector +
 * AAD token endpoint + JWKS signer) + its `/emu/*` drive-control surface on ONE
 * loopback port, writes its public JWKS to a file, and stays up. It is wired to
 * an already-running daemon by setting, ON THE DAEMON, the two OFF-BY-DEFAULT
 * test seams:
 *
 *   channels.msteams:              (config.yaml — enable the channel + test creds)
 *     enabled: true
 *     authMode: secret
 *     appId:   <appId printed below>
 *     tenantId: <tenantId printed below>
 *     appPassword: any-non-empty
 *     allowMode: open
 *     cloud: public
 *   env (daemon launch):
 *     COMIS_MSTEAMS_TEST_JWKS=<jwksPath printed below>     # local-JWKS ingress validator
 *     COMIS_MSTEAMS_TEST_CONNECTOR=<apiRoot printed below>  # redirect Connector egress → here
 *
 * With those set, the daemon's ingress verifies inbound tokens against this
 * emulator's JWKS and its outbound Connector/token calls are redirected to this
 * emulator (the isSafeServiceUrl host allowlist is NOT relaxed — see
 * packages/daemon/src/wiring/msteams-test-seams.ts). The driver
 * (`self-driving/scripts/msteams-drive.mjs`) then obtains a signed Bearer from
 * `/emu/sign-token`, POSTs the activity to the daemon's
 * `/channels/msteams/api/messages`, and polls `/emu/outbound` for the reply.
 *
 * Writes the wiring to /tmp/comis-msteams-emu.json and prints `MSTEAMS_EMU_UP {json}`.
 *
 * TEST-HARNESS — lives under the test tree; consumes only the emulator subtree
 * (node: built-ins + jose at runtime; @comis types are erased).
 */
import { writeFileSync } from "node:fs";
import {
  createMsTeamsEmulator,
  registerMsTeamsDriveControl,
} from "../emulators/msteams/msteams-emulator.js";

const APP_ID = process.env["EMU_MSTEAMS_APP_ID"] ?? "test-app-id";
const TENANT_ID =
  process.env["EMU_MSTEAMS_TENANT_ID"] ?? "00000000-0000-0000-0000-000000000001";
const JWKS_PATH = process.env["EMU_MSTEAMS_JWKS_PATH"] ?? "/tmp/comis-msteams-jwks.json";

const emu = createMsTeamsEmulator({ appId: APP_ID, tenantId: TENANT_ID });
registerMsTeamsDriveControl(emu);

const { apiRoot, port } = await emu.start();
// Persist the public JWKS so the daemon's COMIS_MSTEAMS_TEST_JWKS seam can read it.
emu.writeJwksFile(JWKS_PATH);

const info = {
  apiRoot,
  port,
  appId: APP_ID,
  tenantId: TENANT_ID,
  jwksPath: JWKS_PATH,
  pid: process.pid,
  // The exact daemon-side wiring the operator must set (echoed for copy/paste).
  daemonEnv: {
    COMIS_MSTEAMS_TEST_JWKS: JWKS_PATH,
    COMIS_MSTEAMS_TEST_CONNECTOR: apiRoot,
  },
};
writeFileSync("/tmp/comis-msteams-emu.json", JSON.stringify(info, null, 2));
// eslint-disable-next-line no-console
console.log("MSTEAMS_EMU_UP " + JSON.stringify(info));

const stop = async (): Promise<void> => {
  try {
    await emu.stop();
  } catch {
    /* best-effort */
  }
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// Keep the event loop alive.
setInterval(() => {}, 1 << 30);
