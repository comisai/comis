// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const daemonSource = readFileSync(resolve(repoRoot, "packages/daemon/src/daemon.ts"), "utf8");
const proactiveSourcePath = resolve(
  repoRoot,
  "packages/daemon/src/wiring/setup-proactive-schedulers.ts",
);

describe("scheduler activation composition wiring", () => {
  it("uses the unified proactive runtime after channel delivery is bound", () => {
    const channelsReady = daemonSource.indexOf("await setupChannels(");
    const proactiveReady = daemonSource.indexOf("setupProactiveSchedulers(");
    const gatewayBoot = daemonSource.indexOf("async function bootGateway(");

    expect(channelsReady).toBeGreaterThan(-1);
    expect(proactiveReady).toBeGreaterThan(channelsReady);
    expect(proactiveReady).toBeLessThan(gatewayBoot);
    expect(daemonSource).not.toContain("setupHeartbeat(");
    expect(daemonSource).not.toContain("createWakeCoalescer(");
  });

  it("publishes the tool assembler before proactive scheduler activation", () => {
    const toolsReady = daemonSource.indexOf("const { assembleToolsForAgent,");
    const proactiveReady = daemonSource.indexOf("setupProactiveSchedulers(");

    expect(toolsReady).toBeGreaterThan(-1);
    expect(proactiveReady).toBeGreaterThan(toolsReady);
    expect(daemonSource.slice(toolsReady, proactiveReady)).toMatch(
      /Object\.assign\(boot,\s*\{[^}]*assembleToolsForAgent/,
    );
  });

  it("binds every late-bound runtime dependency before one activation gate", () => {
    const proactiveSource = readFileSync(proactiveSourcePath, "utf8");
    const cronBind = proactiveSource.indexOf("cronRuntimeBinding.bind(");
    const corePortsBind = proactiveSource.indexOf("schedulerCorePortBindings.bind(");
    const activation = proactiveSource.indexOf("activateProactiveSchedulers(");

    expect(cronBind).toBeGreaterThan(-1);
    expect(corePortsBind).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(cronBind);
    expect(activation).toBeGreaterThan(corePortsBind);
  });

  it("closes every scheduler admission surface when a later boot stage fails", () => {
    const catchBlock = daemonSource.slice(
      daemonSource.lastIndexOf("} catch (e: unknown) {"),
      daemonSource.indexOf("// Only run when invoked directly"),
    );

    expect(catchBlock).toContain("closePartialBootSchedulerAdmission(boot)");
    expect(catchBlock.indexOf("closePartialBootSchedulerAdmission(boot)"))
      .toBeLessThan(catchBlock.indexOf("releaseDataDirLock(boot.dataDir)"));
  });
});
