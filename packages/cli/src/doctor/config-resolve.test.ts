// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor config-resolution unit tests.
 *
 * Pins the store-aware single resolution path that every doctor check
 * consumes: `${VAR}` references resolve from env first, then the encrypted
 * secret store (mirroring daemon boot), unresolved references are reported
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

import { describe, it, expect } from "vitest";
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

  it("prefers an env value over the store value for the same reference", () => {
    const envToken = "e".repeat(40);
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({
        files: { "/cfg/config.yaml": CONFIG_YAML },
        env: { COMIS_GATEWAY_TOKEN: envToken, TELEGRAM_BOT_TOKEN: "12345:abcdef" },
        store: { COMIS_GATEWAY_TOKEN: TOKEN_48 },
      }),
    );

    expect(r.config?.gateway?.tokens?.[0]?.secret).toBe(envToken);
  });

  it("reports unresolved references with their config path and var name instead of silently dropping the config", () => {
    const r = resolveDoctorConfig(
      ["/cfg/config.yaml"],
      depsFor({ files: { "/cfg/config.yaml": CONFIG_YAML } }),
    );

    // The placeholder string fails the >=32-char token gate -> validation issues,
    // but the resolution must say WHY: the refs nothing resolved.
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
    expect(why).toContain("encrypted secret store");
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
    // The unresolved ${...} placeholders fail the token gate -> validationIssues
    // set. Section membership is still meaningful, so rawTopLevelKeys survives.
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
