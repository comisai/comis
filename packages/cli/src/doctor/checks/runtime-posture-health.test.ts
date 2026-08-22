// SPDX-License-Identifier: Apache-2.0
import { AppConfigSchema } from "@comis/core";
import { describe, expect, it } from "vitest";
import type { DoctorContext } from "../types.js";
import { runtimePostureHealthCheck } from "./runtime-posture-health.js";

function makeContext(
  overrides: Partial<DoctorContext> = {},
): DoctorContext {
  return {
    config: AppConfigSchema.parse({
      agents: {
        default: {
          autonomy: { profile: "standard" },
        },
      },
    }),
    configPaths: ["/tmp/comis/config.yaml"],
    dataDir: "/tmp/comis",
    daemonPidFile: "/tmp/comis/daemon.pid",
    secretPresent: () => false,
    platform: "darwin",
    ...overrides,
  };
}

describe("runtimePostureHealthCheck", () => {
  it("reports the missing canary secret and the non-Linux autonomy downshift", async () => {
    const findings = await runtimePostureHealthCheck.run(makeContext());

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "warn",
          check: "Canary secret",
          message: expect.stringContaining("CANARY_SECRET"),
        }),
        expect.objectContaining({
          status: "warn",
          check: "Autonomy isolation",
          message: expect.stringContaining("assistant"),
          suggestion: expect.stringMatching(/Linux|autonomy\.profile/),
        }),
      ]),
    );
  });

  it("passes when the canary is configured and autonomy is disabled on this host", async () => {
    const findings = await runtimePostureHealthCheck.run(
      makeContext({
        config: AppConfigSchema.parse({
          agents: {
            default: {
              autonomy: { profile: "assistant" },
            },
          },
        }),
        secretPresent: () => true,
      }),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        status: "pass",
        check: "Runtime posture",
      }),
    ]);
  });

  it("reports an inaccessible secret store without claiming the canary is absent", async () => {
    const context = {
      ...makeContext({
        config: AppConfigSchema.parse({
          agents: {
            default: {
              autonomy: { profile: "assistant" },
            },
          },
        }),
      }),
      secretPresent: () => "unavailable",
    } as unknown as DoctorContext;

    const findings = await runtimePostureHealthCheck.run(context);

    expect(findings).toEqual([
      expect.objectContaining({
        status: "warn",
        check: "Canary secret",
        message: expect.stringContaining("could not be verified"),
        suggestion: expect.stringContaining("secrets list"),
      }),
    ]);
    expect(findings[0]?.message).not.toContain("is not configured");
  });

  it("does not warn about autonomy platform support on Linux", async () => {
    const findings = await runtimePostureHealthCheck.run(
      makeContext({
        secretPresent: () => true,
        platform: "linux",
      }),
    );

    expect(findings.some((finding) => finding.check === "Autonomy isolation")).toBe(false);
  });
});
