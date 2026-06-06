// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for mcp-config.ts.
 *
 * Always runs — no COMIS_LIVE required, no daemon needed.
 * Tests that buildMcpConfig writes the correct YAML structure
 * for each TRANSPORT_AUTH_MATRIX cell.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { buildMcpConfig } from "./mcp-config.js";

describe("buildMcpConfig", () => {
  it("returns a path to a file that exists (http + none)", () => {
    const p = buildMcpConfig({ transport: "http", auth: "none", label: "smoke" });
    expect(existsSync(p)).toBe(true);
    rmSync(p, { force: true });
  });

  it("patches transport: http into the YAML", () => {
    const p = buildMcpConfig({ transport: "http", auth: "none", label: "t-transport-http" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("transport: http");
    rmSync(p, { force: true });
  });

  it("patches auth: none into the YAML", () => {
    const p = buildMcpConfig({ transport: "http", auth: "none", label: "t-auth-none" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("auth: none");
    rmSync(p, { force: true });
  });

  it("patches transport: sse + auth: bearer + token into the YAML", () => {
    const p = buildMcpConfig({ transport: "sse", auth: "bearer", bearerToken: "tok", label: "t1" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("transport: sse");
    expect(content).toContain("auth: bearer");
    expect(content).toContain("token: tok");
    rmSync(p, { force: true });
  });

  it("writes a custom serverUrl into the YAML", () => {
    const p = buildMcpConfig({
      transport: "http",
      auth: "none",
      serverUrl: "http://localhost:12345/mcp",
      label: "t-url",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("http://localhost:12345/mcp");
    rmSync(p, { force: true });
  });

  it("places the mcp server under integrations.mcp.servers", () => {
    const p = buildMcpConfig({ transport: "http", auth: "none", label: "t-nesting" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("integrations:");
    expect(content).toContain("mcp:");
    expect(content).toContain("servers:");
    rmSync(p, { force: true });
  });

  it("includes a command field for stdio transport", () => {
    const p = buildMcpConfig({ transport: "stdio", auth: "none", label: "t-stdio" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("transport: stdio");
    expect(content).toContain("command:");
    rmSync(p, { force: true });
  });

  it("supports oauth auth type", () => {
    const p = buildMcpConfig({ transport: "http", auth: "oauth", label: "t-oauth" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("auth: oauth");
    rmSync(p, { force: true });
  });

  it("uses a custom filePrefix in the output filename", () => {
    const p = buildMcpConfig({
      transport: "http",
      auth: "none",
      label: "prefix-test",
      filePrefix: "mcp-custom",
    });
    expect(p).toMatch(/mcp-custom-/);
    rmSync(p, { force: true });
  });

  it("sanitises the label in the output filename", () => {
    const p = buildMcpConfig({ transport: "http", auth: "none", label: "has spaces & chars!" });
    expect(p).toMatch(/has_spaces___chars_/);
    rmSync(p, { force: true });
  });
});
