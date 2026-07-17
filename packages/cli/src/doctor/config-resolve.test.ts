// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor config-resolution unit tests.
 *
 * Pins the store-aware single resolution path that every doctor check
 * consumes: `${VAR}` references resolve through the daemon's effective
 * environment, unresolved references are reported
 * with their config path and var name, and load-stage failures are
 * distinguished from validation failures.
 *
 * Motivating failure mode: without this, the raw `${COMIS_GATEWAY_TOKEN}`
 * placeholder fails the >=32-char token gate, buildDoctorContext silently
 * drops the config, and doctor claims "No gateway URL configured" /
 * "No channels configured" against a live, fully configured daemon.
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateMasterKey } from "@comis/core";
import { describe, it, expect } from "vitest";
import { offlineSecretSet } from "../util/offline-secrets-store.js";
import { resolveDoctorConfig, describeConfigUnavailable } from "./config-resolve.js";

const TOKEN_48 = "t".repeat(48);

/** A minimal config whose only secret lives behind a ${REF} placeholder. */
const CONFIG_YAML = [
  "gateway:",
  "  host: 127.0.0.1",
  "  port: 4766",
  "  tokens:",
  "    - id: admin",
  "      secret: ${COMIS_GATEWAY_TOKEN}",
  '      scopes: ["*"]',
  "channels:",
  "  telegram:",
  "    enabled: true",
  "    botToken: ${TELEGRAM_BOT_TOKEN}",
].join("\n");

function depsFor(overrides: {
  files?: Record<string, string>;
  env?: Record<string, string>;
  store?: Record<string, string>;
}) {
  return {
    readFile: (p: string) => {
      const content = overrides.files?.[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    getEnv: (k: string) => overrides.env?.[k],
    getStoreSecret: (k: string) => overrides.store?.[k],
  };
}

describe("resolveDoctorConfig", () => {
  it("resolves placeholder secrets from the encrypted store so doctor validates the config the daemon boots with", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: { "/cfg/config.yaml": CONFIG_YAML },
        store: { COMIS_GATEWAY_TOKEN: TOKEN_48, TELEGRAM_BOT_TOKEN: "12345:abcdef" },
      }),
    );

    expect(r.loadError).toBeUndefined();
    expect(r.validationIssues).toBeUndefined();
    expect(r.unresolvedRefs ?? []).toHaveLength(0);
    expect(r.config?.gateway?.port).toBe(4766);
    expect(r.config?.channels?.telegram?.enabled).toBe(true);
    expect(r.foundPath).toBe("/cfg/config.yaml");
  });

  it("prefers the encrypted-store value over a shadowed environment value like daemon boot", () => {
    const envToken = "e".repeat(40);
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: { "/cfg/config.yaml": CONFIG_YAML },
        env: { COMIS_GATEWAY_TOKEN: envToken, TELEGRAM_BOT_TOKEN: "12345:abcdef" },
        store: { COMIS_GATEWAY_TOKEN: TOKEN_48 },
      }),
    );

    expect(r.config?.gateway?.tokens?.[0]?.secret).toBe(TOKEN_48);
  });

  it("selects secrets.json in file mode even when a stale encrypted store exists", () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "comis-doctor-file-store-"));
    const configPath = resolve(dataDir, "config.yaml");
    const envFilePath = resolve(dataDir, ".env");
    const previousDataDir = process.env["COMIS_DATA_DIR"];
    const staleEncryptedValue = "e".repeat(48);
    const currentFileValue = "f".repeat(48);

    try {
      const masterKey = generateMasterKey();
      writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });
      const staleWrite = offlineSecretSet({
        name: "COMIS_GATEWAY_TOKEN",
        value: staleEncryptedValue,
        dataDir,
        envFilePath,
      });
      expect(staleWrite.ok).toBe(true);
      writeFileSync(
        resolve(dataDir, "secrets.json"),
        JSON.stringify({
          schemaVersion: 1,
          secrets: {
            COMIS_GATEWAY_TOKEN: {
              value: currentFileValue,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        configPath,
        [
          "security:",
          "  storage: file",
          "gateway:",
          "  tokens:",
          "    - id: admin",
          "      secret: ${COMIS_GATEWAY_TOKEN}",
          '      scopes: ["*"]',
        ].join("\n"),
        { mode: 0o600 },
      );
      process.env["COMIS_DATA_DIR"] = dataDir;

      const resolution = resolveDoctorConfig([configPath]);

      expect(resolution.validationIssues).toBeUndefined();
      expect(resolution.config?.gateway.tokens[0]?.secret).toBe(currentFileValue);
    } finally {
      if (previousDataDir === undefined) delete process.env["COMIS_DATA_DIR"];
      else process.env["COMIS_DATA_DIR"] = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports unresolved references with their config path and var name instead of silently dropping the config", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": CONFIG_YAML } }),
    );

    // Bootstrap-equivalent substitution fails before schema validation, and
    // the resolution must still say WHY: the references nothing resolved.
    expect(r.config).toBeUndefined();
    expect(r.validationIssues?.length).toBeGreaterThan(0);
    const refs = r.unresolvedRefs ?? [];
    expect(refs.map((u) => u.varName)).toContain("COMIS_GATEWAY_TOKEN");
    const tokenRef = refs.find((u) => u.varName === "COMIS_GATEWAY_TOKEN");
    expect(tokenRef?.path).toContain("gateway.tokens[0].secret");
  });

  it("distinguishes a missing config file from an invalid one", () => {
    const missing = resolveDoctorConfig(["/cfg/nope.yaml"], depsFor({}));
    expect(missing.loadError?.kind).toBe("missing");
    expect(missing.config).toBeUndefined();

    const corrupt = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": "gateway: [unclosed" } }),
    );
    expect(corrupt.loadError?.kind).toBe("unparseable");
    expect(corrupt.loadError?.message).toContain("/cfg/config.yaml");
  });

  it("treats a non-object config document as corrupt rather than valid-empty", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": "- just\n- a\n- list" } }),
    );
    expect(r.loadError?.kind).toBe("not-object");
  });

  it("merges every readable config layer from left to right like daemon startup", () => {
    const r = resolveDoctorConfig(
      ["/cfg/base.yaml", "/cfg/local.yaml"],
      depsFor({
        files: {
          "/cfg/base.yaml": [
            "gateway:",
            "  host: 0.0.0.0",
            "  port: 4766",
            "channels:",
            "  telegram:",
            "    enabled: true",
            "    botToken: ${TELEGRAM_BOT_TOKEN}",
          ].join("\n"),
          "/cfg/local.yaml": [
            "gateway:",
            "  port: 9876",
            "logLevel: warn",
          ].join("\n"),
        },
        store: { TELEGRAM_BOT_TOKEN: "12345:abcdef" },
      }),
    );

    expect(r.loadError).toBeUndefined();
    expect(r.validationIssues).toBeUndefined();
    expect(r.config?.gateway.host).toBe("0.0.0.0");
    expect(r.config?.gateway.port).toBe(9876);
    expect(r.config?.channels.telegram?.enabled).toBe(true);
    expect(r.config?.logLevel).toBe("warn");
    expect(r.foundPath).toBe("/cfg/local.yaml");
    expect(new Set(r.rawTopLevelKeys)).toEqual(new Set(["gateway", "channels", "logLevel"]));
  });

  it("fails when a later readable layer is corrupt instead of silently ignoring it", () => {
    const r = resolveDoctorConfig(
      ["/cfg/base.yaml", "/cfg/local.yaml"],
      depsFor({
        files: {
          "/cfg/base.yaml": "gateway:\n  port: 4766",
          "/cfg/local.yaml": "gateway: [unclosed",
        },
      }),
    );

    expect(r.config).toBeUndefined();
    expect(r.loadError?.kind).toBe("unparseable");
    expect(r.loadError?.message).toContain("/cfg/local.yaml");
  });

  it("applies the operational environment layer below explicit YAML settings", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: { "/cfg/config.yaml": "gateway:\n  host: 127.0.0.1\n" },
        env: {
          COMIS_GATEWAY_HOST: "0.0.0.0",
          COMIS_GATEWAY_PORT: "8123",
          COMIS_TRAJECTORY_DIR: "/srv/trajectories",
        },
      }),
    );

    expect(r.config?.gateway.host).toBe("127.0.0.1");
    expect(r.config?.gateway.port).toBe(8123);
    expect(r.config?.observability.trajectory.dirOverride).toBe("/srv/trajectories");
  });

  it("uses the same bare and escaped variable-reference semantics as bootstrap", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: {
          "/cfg/config.yaml": [
            "channels:",
            "  telegram:",
            "    enabled: true",
            "    botToken: $TELEGRAM_BOT_TOKEN",
            "integrations:",
            "  mcp:",
            "    servers:",
            "      - name: literal-env",
            "        transport: stdio",
            "        command: /usr/bin/true",
            '        env: { LITERAL_VALUE: "$${LITERAL_VALUE}" }',
            "        enabled: true",
          ].join("\n"),
        },
        env: { TELEGRAM_BOT_TOKEN: "12345:abcdef" },
      }),
    );

    expect(r.validationIssues).toBeUndefined();
    expect(r.config?.channels.telegram.botToken).toBe("12345:abcdef");
    expect(r.config?.integrations.mcp.servers[0]?.env?.LITERAL_VALUE).toBe(
      "${LITERAL_VALUE}",
    );
    expect(r.unresolvedRefs).toBeUndefined();
  });

  it("ignores missing references in disabled MCP servers exactly like bootstrap", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: {
          "/cfg/config.yaml": [
            "integrations:",
            "  mcp:",
            "    servers:",
            "      - name: disabled-server",
            "        transport: stdio",
            "        command: /usr/bin/true",
            "        env: { UNUSED_TOKEN: '${UNUSED_TOKEN}' }",
            "        enabled: false",
          ].join("\n"),
        },
      }),
    );

    expect(r.config?.integrations.mcp.servers[0]?.enabled).toBe(false);
    expect(r.config?.integrations.mcp.servers[0]?.env?.UNUSED_TOKEN).toBe(
      "${UNUSED_TOKEN}",
    );
    expect(r.unresolvedRefs).toBeUndefined();
  });

  it("fails on a missing reference in an earlier enabled layer even when a later layer replaces it", () => {
    const r = resolveDoctorConfig(
      ["/cfg/base.yaml", "/cfg/local.yaml"],
      depsFor({
        files: {
          "/cfg/base.yaml": [
            "integrations:",
            "  mcp:",
            "    servers:",
            "      - name: enabled-server",
            "        transport: stdio",
            "        command: /usr/bin/true",
            "        env: { REQUIRED_TOKEN: '${REQUIRED_TOKEN}' }",
            "        enabled: true",
          ].join("\n"),
          "/cfg/local.yaml": "integrations:\n  mcp:\n    servers: []\n",
        },
      }),
    );

    expect(r.config).toBeUndefined();
    expect(r.validationIssues?.[0]).toContain("REQUIRED_TOKEN");
    expect(r.unresolvedRefs).toContainEqual({
      path: "integrations.mcp.servers[0].env.REQUIRED_TOKEN",
      varName: "REQUIRED_TOKEN",
    });
  });
});

describe("describeConfigUnavailable", () => {
  it("names the unresolved secret refs and the places checked when validation failed because nothing resolved them", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": CONFIG_YAML } }),
    );
    const why = describeConfigUnavailable(r);
    expect(why).toBeDefined();
    expect(why).toContain("COMIS_GATEWAY_TOKEN");
    expect(why).toContain("configured secret store");
  });

  it("returns undefined when the config resolved cleanly so callers keep their configured-path messages", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: { "/cfg/config.yaml": CONFIG_YAML },
        store: { COMIS_GATEWAY_TOKEN: TOKEN_48, TELEGRAM_BOT_TOKEN: "12345:abcdef" },
      }),
    );
    expect(describeConfigUnavailable(r)).toBeUndefined();
  });

  it("surfaces the load error verbatim when the file itself could not be read", () => {
    const r = resolveDoctorConfig(["/cfg/nope.yaml"], depsFor({}));
    expect(describeConfigUnavailable(r)).toContain("No config file found");
  });
});

describe("resolveDoctorConfig rawTopLevelKeys", () => {
  it("exposes the pre-defaults top-level keys the config wrote, not the fully-defaulted validated set", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: { "/cfg/config.yaml": CONFIG_YAML },
        store: { COMIS_GATEWAY_TOKEN: TOKEN_48, TELEGRAM_BOT_TOKEN: "12345:abcdef" },
      }),
    );
    expect(r.config).toBeDefined();
    // Only the two sections the file actually wrote — NOT the dozens the
    // validated, fully-defaulted AppConfig would report as present.
    expect(new Set(r.rawTopLevelKeys)).toEqual(new Set(["gateway", "channels"]));
    expect(r.rawTopLevelKeys?.length).toBe(2);
  });

  it("still exposes rawTopLevelKeys when the config parses but fails schema validation", () => {
    // The unresolved ${...} placeholders fail config substitution. Section
    // membership is still meaningful, so rawTopLevelKeys survives.
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": CONFIG_YAML } }),
    );
    expect(r.validationIssues?.length).toBeGreaterThan(0);
    expect(new Set(r.rawTopLevelKeys)).toEqual(new Set(["gateway", "channels"]));
  });

  it("omits rawTopLevelKeys when the config file is missing, unparseable, or not an object", () => {
    const missing = resolveDoctorConfig(["/cfg/nope.yaml"], depsFor({}));
    expect(missing.rawTopLevelKeys).toBeUndefined();

    const unparseable = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": "gateway: [unclosed" } }),
    );
    expect(unparseable.rawTopLevelKeys).toBeUndefined();

    const notObject = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": "- just\n- a\n- list" } }),
    );
    expect(notObject.rawTopLevelKeys).toBeUndefined();
  });
});
