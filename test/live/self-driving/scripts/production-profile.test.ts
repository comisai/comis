import { describe, expect, it } from "vitest";

import {
  parseProductionProfile,
  productionProfileSummary,
} from "./production-profile.js";

const BASE_PROFILE = `
export SOURCE_HOST="comis-harel"
export TARGET_HOST="comis-test2"
export SOURCE_SSH_PORT="2222"
export SOURCE_ROLE="production"
export TARGET_ROLE="test"
export SOURCE_COMIS_USER="comis"
export TARGET_COMIS_USER="comis"
export SOURCE_DATA="/home/comis/.comis"
export TARGET_DATA="/home/comis/.comis"
export SOURCE_SERVICE="comis"
export TARGET_SERVICE="comis"
export SOURCE_MACHINE_ID_SHA256="${"a".repeat(64)}"
export TARGET_MACHINE_ID_SHA256="${"b".repeat(64)}"
export GWTOKEN="test-key"
`;

describe("production replay host profile", () => {
  it("parses explicit distinct production and test hosts", () => {
    const result = parseProductionProfile(BASE_PROFILE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toMatchObject({
      ssh: "comis-harel",
      role: "production",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
      sshPort: 2222,
    });
    expect(result.value.target).toMatchObject({
      ssh: "comis-test2",
      role: "test",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
    });
  });

  it("rejects a single-host VPS profile instead of guessing roles", () => {
    const result = parseProductionProfile('export VPS="one-box"\n');

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "missing_field",
        field: "SOURCE_HOST",
        message: "SOURCE_HOST is required",
      },
    });
  });

  it("rejects the same endpoint for source and target", () => {
    const result = parseProductionProfile(
      BASE_PROFILE.replace('TARGET_HOST="comis-test2"', 'TARGET_HOST="comis-harel"'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("same_host");
  });

  it("requires production and test role assignments", () => {
    const result = parseProductionProfile(
      BASE_PROFILE.replace('SOURCE_ROLE="production"', 'SOURCE_ROLE="test"'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "invalid_role", field: "SOURCE_ROLE" });
  });

  it("rejects unsafe SSH targets and non-absolute data paths", () => {
    const unsafeHost = parseProductionProfile(
      BASE_PROFILE.replace('SOURCE_HOST="comis-harel"', 'SOURCE_HOST="host; reboot"'),
    );
    expect(unsafeHost.ok).toBe(false);
    if (!unsafeHost.ok) expect(unsafeHost.error.kind).toBe("invalid_host");

    const ambiguousPort = parseProductionProfile(
      BASE_PROFILE.replace('SOURCE_HOST="comis-harel"', 'SOURCE_HOST="comis-harel:22"'),
    );
    expect(ambiguousPort.ok).toBe(false);
    if (!ambiguousPort.ok) expect(ambiguousPort.error.kind).toBe("invalid_host");

    const relativePath = parseProductionProfile(
      BASE_PROFILE.replace('TARGET_DATA="/home/comis/.comis"', 'TARGET_DATA=".comis"'),
    );
    expect(relativePath.ok).toBe(false);
    if (!relativePath.ok) expect(relativePath.error.kind).toBe("invalid_path");

    const traversingPath = parseProductionProfile(
      BASE_PROFILE.replace('TARGET_DATA="/home/comis/.comis"', 'TARGET_DATA="/home/comis/../root"'),
    );
    expect(traversingPath.ok).toBe(false);
    if (!traversingPath.ok) expect(traversingPath.error.kind).toBe("invalid_path");
  });

  it("rejects out-of-range separately modeled SSH ports", () => {
    const result = parseProductionProfile(
      BASE_PROFILE.replace('SOURCE_SSH_PORT="2222"', 'SOURCE_SSH_PORT="70000"'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_port");
  });

  it("requires full machine identity pins in the profile", () => {
    const missingPin = parseProductionProfile(
      BASE_PROFILE.replace(/^export SOURCE_MACHINE_ID_SHA256=.*$/mu, ""),
    );

    expect(missingPin.ok).toBe(false);
    if (!missingPin.ok) {
      expect(missingPin.error).toMatchObject({
        kind: "missing_field",
        field: "SOURCE_MACHINE_ID_SHA256",
      });
    }
  });

  it("never includes secret-bearing variables in the safe summary", () => {
    const result = parseProductionProfile(BASE_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = JSON.stringify(productionProfileSummary(result.value));
    expect(summary).toContain("comis-harel");
    expect(summary).toContain("comis-test2");
    expect(summary).not.toContain("GWTOKEN");
    expect(summary).not.toContain("test-key");
  });
});
