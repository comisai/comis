// SPDX-License-Identifier: Apache-2.0
/**
 * Real-filesystem round-trip test for the write-config step's plaintext .env.
 *
 * The sibling 10-write-config.test.ts mocks node:fs AND loadEnvFile, so it only
 * ever inspects the in-memory string handed to writeFileSync. That hides a
 * whole failure class: a secret that looks fine in the captured string can
 * still be corrupted by the REAL line-based .env reader the daemon runs at
 * boot. Google Chat's service-account key is the first channel secret that is a
 * multi-line JSON blob, so it is exactly the value that reader mangles.
 *
 * This test uses NO mocks: it drives the actual writeConfigStep against a real
 * temp home in "file" storage mode with a pretty-printed (multi-line) key, then
 * reads the produced .env back through the REAL loadEnvFile and asserts the key
 * survives as parseable JSON — the property the daemon depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, safePath } from "@comis/core";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { writeConfigStep } from "./10-write-config.js";

// A pretty-printed service-account key, byte-for-byte the shape the Google
// Cloud console downloads (and what `--googlechat-sa-key "$(cat key.json)"`
// expands to). The multi-line structure is what breaks the line-based reader.
const SA_KEY_OBJECT = {
  type: "service_account",
  project_id: "example-project",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIexampleBODY\n-----END PRIVATE KEY-----\n",
  client_email: "bot@example-project.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};
const MULTILINE_SA_KEY = JSON.stringify(SA_KEY_OBJECT, null, 2);

/** Minimal prompter stub — the step only draws spinners + log lines. */
function stubPrompter(): WizardPrompter {
  const spinner: Spinner = {
    start: () => {},
    update: () => {},
    stop: () => {},
  };
  const noop = () => {};
  return {
    intro: noop,
    outro: noop,
    note: noop,
    text: async () => "",
    select: async () => "",
    multiselect: async () => [],
    password: async () => "",
    confirm: async () => false,
    spinner: () => spinner,
    group: (async () => ({})) as WizardPrompter["group"],
    log: { info: noop, warn: noop, error: noop, success: noop },
  };
}

function googlechatFileState(home: string): WizardState {
  return {
    completedSteps: [],
    provider: { id: "anthropic", apiKey: "sk-test-key-123" },
    agentName: "test-agent",
    model: "claude-sonnet-4-5-20250929",
    storageMode: "file",
    channels: [
      {
        type: "googlechat",
        serviceAccountKey: MULTILINE_SA_KEY,
        subscriptionName: "projects/p/subscriptions/s",
        mode: "pubsub",
        validated: false,
      },
    ],
    gateway: { port: 4766, bindMode: "loopback", token: "test-token-value" },
    dataDir: safePath(home, ".comis", "data"),
  };
}

describe("write-config .env round-trip (real loadEnvFile, file storage mode)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "comis-writecfg-"));
    // The step resolves paths via os.homedir(); on POSIX that honors $HOME.
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes a multi-line Google Chat SA key that survives loadEnvFile as parseable JSON", async () => {
    // Sanity: os.homedir() must resolve to our temp home, or the step would
    // write into the developer's real ~/.comis.
    expect(homedir()).toBe(tmpHome);

    await writeConfigStep.execute(googlechatFileState(tmpHome), stubPrompter());

    const envPath = join(tmpHome, ".comis", ".env");
    expect(existsSync(envPath)).toBe(true);

    // Read the produced .env exactly as the daemon does at boot.
    const env: Record<string, string | undefined> = {};
    loadEnvFile(envPath, env);

    // The daemon does JSON.parse(${GOOGLECHAT_SA_KEY}); a truncated "{" throws.
    expect(env.GOOGLECHAT_SA_KEY).toBeDefined();
    const parsed = JSON.parse(env.GOOGLECHAT_SA_KEY as string) as {
      client_email?: string;
      private_key?: string;
    };
    expect(parsed.client_email).toBe(SA_KEY_OBJECT.client_email);
    expect(parsed.private_key).toBe(SA_KEY_OBJECT.private_key);
  });
});
