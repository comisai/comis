// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveEffectiveTrajectoryConfig } from "./trajectory-runtime-config.js";

describe("effective trajectory runtime configuration", () => {
  it("preserves diagnostics controls and applies the configured directory precedence", () => {
    const explicit = resolveEffectiveTrajectoryConfig({
      diagnostics: {
        trajectory: {
          enabled: false,
          dir: "/diagnostics/trajectory",
          maxFileBytes: 4_096,
          eventTypes: ["background_task:notified"],
        },
      },
      observability: {
        trajectory: { dirOverride: "/observability/trajectory" },
      },
    } as never);
    const override = resolveEffectiveTrajectoryConfig({
      diagnostics: {
        trajectory: {
          enabled: true,
          maxFileBytes: 8_192,
        },
      },
      observability: {
        trajectory: { dirOverride: "/observability/trajectory" },
      },
    } as never);

    expect(explicit).toEqual({
      enabled: false,
      dir: "/diagnostics/trajectory",
      maxFileBytes: 4_096,
      eventTypes: ["background_task:notified"],
    });
    expect(override).toEqual({
      enabled: true,
      dir: "/observability/trajectory",
      maxFileBytes: 8_192,
    });
  });
});
