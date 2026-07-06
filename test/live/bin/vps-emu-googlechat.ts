// SPDX-License-Identifier: Apache-2.0
/**
 * `vps-emu-googlechat` — STANDALONE Google Chat emulator launcher for an EXTERNAL
 * daemon (the VPS production daemon, a test env). The Google Chat sibling of
 * `vps-emu.ts` (Telegram) and `vps-emu-msteams.ts` (Teams).
 *
 * Google Chat DEFAULTS to a PULL transport (like Telegram/Signal, unlike Teams'
 * push): the daemon connects OUT to three fake Google surfaces — the OAuth token
 * mint, the Pub/Sub pull endpoint, and the Chat REST API — that this emulator
 * serves on ONE loopback port. It also mints inbound Chat-event Bearers for the
 * OPT-IN webhook mode. So this launcher starts the `GoogleChatEmulator` + its
 * `/emu/*` drive-control surface, writes its public JWKS + a parseable
 * service-account key to files, and stays up. It is wired to an already-running
 * daemon by setting, ON THE DAEMON, the two OFF-BY-DEFAULT test seams:
 *
 *   channels.googlechat:              (config.yaml — enable the channel + test creds)
 *     enabled: true
 *     mode: pubsub                    (or webhook, to exercise the inbound-verify leg)
 *     serviceAccountKey: <saKeyPath printed below>   # or paste the JSON blob
 *     subscriptionName: projects/test-project/subscriptions/comis-emulator
 *     audienceType: project-number
 *     audience: <projectNumber printed below>
 *     allowFrom: ["users/selfdrive"]  # the driver's --from id (the immutable sender)
 *   env (daemon launch):
 *     COMIS_GOOGLECHAT_TEST_JWKS=<jwksPath printed below>   # local-JWKS inbound verify (webhook mode)
 *     COMIS_GOOGLECHAT_TEST_API=<apiRoot printed below>     # redirect Chat/Pub-Sub/token egress → here
 *
 * With both set, the daemon verifies inbound webhook tokens against this
 * emulator's JWKS AND its outbound Chat/Pub-Sub/token egress is redirected to this
 * emulator (a FULL local-JWKS verify, never a bypass — see
 * packages/daemon/src/wiring/googlechat-test-seams.ts). So the agent reply lands
 * in this emulator's per-space outbound oracle instead of escaping to real Google.
 * The driver (`self-driving/scripts/googlechat-drive.mjs`) then, per --mode, either
 * signs an inbound Bearer at `/emu/sign-token` and POSTs the event to the daemon's
 * `/channels/googlechat` (webhook), or injects the event onto the fake Pub/Sub
 * subscription at `/emu/pubsub-inject` for the daemon to pull (pubsub) — then polls
 * `/emu/outbound` for the reply.
 *
 * Writes the wiring to /tmp/comis-googlechat-emu.json and prints
 * `GOOGLECHAT_EMU_UP {json}`.
 *
 * TEST-HARNESS — lives under the test tree; consumes only the emulator subtree
 * (node: built-ins + jose at runtime; @comis types are erased).
 */
import { writeFileSync } from "node:fs";
import {
  createGoogleChatEmulator,
  registerGoogleChatDriveControl,
} from "../emulators/googlechat/googlechat-emulator.js";

const PROJECT_NUMBER = process.env["EMU_GOOGLECHAT_PROJECT_NUMBER"] ?? "000000000001";
const CLIENT_EMAIL =
  process.env["EMU_GOOGLECHAT_CLIENT_EMAIL"] ??
  "comis-emulator@test-project.iam.gserviceaccount.com";
const JWKS_PATH =
  process.env["EMU_GOOGLECHAT_JWKS_PATH"] ?? "/tmp/comis-googlechat-jwks.json";
const SA_KEY_PATH =
  process.env["EMU_GOOGLECHAT_SA_KEY_PATH"] ?? "/tmp/comis-googlechat-sa.json";

const emu = createGoogleChatEmulator({
  projectNumber: PROJECT_NUMBER,
  clientEmail: CLIENT_EMAIL,
});
registerGoogleChatDriveControl(emu);

const { apiRoot, port } = await emu.start();
// Persist the public JWKS so the daemon's COMIS_GOOGLECHAT_TEST_JWKS seam can read it.
emu.writeJwksFile(JWKS_PATH);
// Persist a parseable service-account key so the daemon's outbound token mint has
// creds to sign an assertion with — the emulator's token endpoint is opaque and
// never verifies it, but the adapter must obtain a token before it posts.
writeFileSync(SA_KEY_PATH, emu.fakeServiceAccountKeyJson(), "utf8");

const info = {
  apiRoot,
  port,
  projectNumber: PROJECT_NUMBER,
  clientEmail: CLIENT_EMAIL,
  jwksPath: JWKS_PATH,
  saKeyPath: SA_KEY_PATH,
  pid: process.pid,
  // The exact daemon-side wiring the operator must set (echoed for copy/paste).
  daemonEnv: {
    COMIS_GOOGLECHAT_TEST_JWKS: JWKS_PATH,
    COMIS_GOOGLECHAT_TEST_API: apiRoot,
  },
};
writeFileSync("/tmp/comis-googlechat-emu.json", JSON.stringify(info, null, 2));
// eslint-disable-next-line no-console
console.log("GOOGLECHAT_EMU_UP " + JSON.stringify(info));

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
