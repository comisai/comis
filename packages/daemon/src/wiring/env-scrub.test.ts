// SPDX-License-Identifier: Apache-2.0
import { selectSecretStore } from "@comis/memory";
import { PROVIDER_SECRET_KEYS } from "@comis/agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  SENSITIVE_EXACT_KEYS,
  SENSITIVE_PREFIXES,
  buildMergedEnv,
} from "./env-scrub.js";
import { setupSecretManager } from "./setup-secret-manager.js";

const DOCUMENTED_SENSITIVE_NAMES = [...new Set([
  ...Object.values(PROVIDER_SECRET_KEYS).flat(),
  "SECRETS_MASTER_KEY",
  "CANARY_SECRET",
  "OAUTH_OPENAI_CODEX",
  "ELEVENLABS_API_KEY",
  "DEEPGRAM_API_KEY",
  "FAL_KEY",
  "SEARCH_API_KEY",
  "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "JINA_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "MSTEAMS_APP_PASSWORD",
  "IRC_NICKSERV_PASSWORD",
  "EMAIL_PASSWORD",
  "EMAIL_OAUTH_CLIENT_ID",
  "EMAIL_OAUTH_CLIENT_SECRET",
  "EMAIL_REFRESH_TOKEN",
  "COMIS_GATEWAY_TOKEN",
])];

const originalEnv = process.env;

afterEach(() => {
  process.env = originalEnv;
});

describe("daemon sensitive environment scrub", () => {
  it("scrubs every documented credential while retaining the SecretManager snapshot", () => {
    const sensitiveEnv = Object.fromEntries(
      DOCUMENTED_SENSITIVE_NAMES.map((name) => [name, `test-value-for-${name}`]),
    );
    process.env = {
      PATH: "/usr/bin",
      HOME: "/tmp/user_a",
      NODE_ENV: "test",
      COMIS_DATA_DIR: "/tmp/comis-test",
      COMIS_GATEWAY_URL: "ws://example.com/ws",
      AZURE_OPENAI_ENDPOINT: "https://example.com/azure-openai",
      ...sensitiveEnv,
    };

    const sensitiveNames = new Set<string>([
      ...SENSITIVE_EXACT_KEYS,
      ...Object.keys(process.env).filter((key) =>
        SENSITIVE_PREFIXES.some((prefix) => key.startsWith(prefix)),
      ),
    ]);
    const selected = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/comis-test",
      env: process.env as Record<string, string | undefined>,
      sensitiveNames,
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    const envSnapshot = selected.value.secretStore.decryptAll();
    expect(envSnapshot.ok).toBe(true);
    if (!envSnapshot.ok) return;
    for (const name of DOCUMENTED_SENSITIVE_NAMES) {
      expect(envSnapshot.value.get(name), `${name} was absent from the env secret snapshot`).toBe(
        `test-value-for-${name}`,
      );
    }

    const { mergedEnv } = buildMergedEnv(selected.value.secretStore, "env");
    const { secretManager } = setupSecretManager(mergedEnv);

    for (const name of DOCUMENTED_SENSITIVE_NAMES) {
      expect(process.env[name], `${name} remained in process.env`).toBeUndefined();
      expect(secretManager.get(name), `${name} was lost from SecretManager`).toBe(
        `test-value-for-${name}`,
      );
    }

    expect(process.env["PATH"]).toBe("/usr/bin");
    expect(process.env["HOME"]).toBe("/tmp/user_a");
    expect(process.env["NODE_ENV"]).toBe("test");
    expect(process.env["COMIS_DATA_DIR"]).toBe("/tmp/comis-test");
    expect(process.env["COMIS_GATEWAY_URL"]).toBe("ws://example.com/ws");
    expect(process.env["AZURE_OPENAI_ENDPOINT"]).toBe("https://example.com/azure-openai");
  });
});
