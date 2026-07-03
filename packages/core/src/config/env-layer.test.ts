// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildGatewayEnvLayer — env-vars-to-config-layer projection.
 * Validates that empty/invalid values are dropped (a typo never silently
 * relocates the daemon to a privileged port or broadens its bind).
 */

import { describe, it, expect } from "vitest";
import { buildGatewayEnvLayer } from "./env-layer.js";

describe("buildGatewayEnvLayer", () => {
  it("returns empty layer when no env vars set", () => {
    expect(buildGatewayEnvLayer({})).toEqual({});
  });

  it("projects COMIS_GATEWAY_HOST onto gateway.host", () => {
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_HOST: "0.0.0.0" })).toEqual({
      gateway: { host: "0.0.0.0" },
    });
  });

  it("projects valid numeric COMIS_GATEWAY_PORT onto gateway.port", () => {
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_PORT: "8080" })).toEqual({
      gateway: { port: 8080 },
    });
  });

  it("projects both fields when both env vars set", () => {
    expect(
      buildGatewayEnvLayer({ COMIS_GATEWAY_HOST: "::", COMIS_GATEWAY_PORT: "9000" }),
    ).toEqual({ gateway: { host: "::", port: 9000 } });
  });

  it("drops empty-string host so schema default still wins", () => {
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_HOST: "" })).toEqual({});
  });

  it("drops non-numeric port (typo never silently relocates daemon)", () => {
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_PORT: "not-a-number" })).toEqual({});
  });

  it("drops out-of-range ports (0, >65535, negative)", () => {
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_PORT: "0" })).toEqual({});
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_PORT: "65536" })).toEqual({});
    expect(buildGatewayEnvLayer({ COMIS_GATEWAY_PORT: "-1" })).toEqual({});
  });

  it("treats undefined env values as unset", () => {
    expect(
      buildGatewayEnvLayer({ COMIS_GATEWAY_HOST: undefined, COMIS_GATEWAY_PORT: undefined }),
    ).toEqual({});
  });

  it("returns layer with only valid fields when one is bad and the other ok", () => {
    expect(
      buildGatewayEnvLayer({ COMIS_GATEWAY_HOST: "0.0.0.0", COMIS_GATEWAY_PORT: "garbage" }),
    ).toEqual({ gateway: { host: "0.0.0.0" } });
  });

  // In addition to the gateway vars, env-layer.ts recognises COMIS_TRAJECTORY_DIR.

  it("projects COMIS_TRAJECTORY_DIR onto observability.trajectory.dirOverride", () => {
    expect(
      buildGatewayEnvLayer({ COMIS_TRAJECTORY_DIR: "/var/comis/trj" }),
    ).toEqual({ observability: { trajectory: { dirOverride: "/var/comis/trj" } } });
  });

  it("drops empty COMIS_TRAJECTORY_DIR — empty string and undefined produce no observability key", () => {
    expect(buildGatewayEnvLayer({ COMIS_TRAJECTORY_DIR: "" })).not.toHaveProperty("observability");
    expect(buildGatewayEnvLayer({ COMIS_TRAJECTORY_DIR: undefined })).not.toHaveProperty("observability");
  });

  it("combines gateway and trajectory env keys when both set", () => {
    const result = buildGatewayEnvLayer({
      COMIS_GATEWAY_HOST: "0.0.0.0",
      COMIS_TRAJECTORY_DIR: "/tmp/trj",
    });
    expect(result).toEqual({
      gateway: { host: "0.0.0.0" },
      observability: { trajectory: { dirOverride: "/tmp/trj" } },
    });
  });
});
