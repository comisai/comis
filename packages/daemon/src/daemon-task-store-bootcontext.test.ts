// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const daemonSource = readFileSync(join(here, "daemon.ts"), "utf8");
const typeSource = readFileSync(join(here, "daemon-types.ts"), "utf8");
const proactiveSource = readFileSync(join(here, "wiring", "setup-proactive-schedulers.ts"), "utf8");

describe("daemon task-store ownership plumbing", () => {
  it("threads the initialized stores and boot id from scheduler setup into channel boot", () => {
    const setupCall = daemonSource.indexOf("= await setupSchedulers({");
    expect(setupCall).toBeGreaterThan(-1);
    const destructure = daemonSource.slice(daemonSource.lastIndexOf("const {", setupCall), setupCall);
    expect(destructure).toContain("followupTaskStores");
    expect(destructure).toContain("taskBootId");

    const channelBoot = daemonSource.indexOf("async function bootChannels(", setupCall);
    const forwardingScope = daemonSource.slice(setupCall, channelBoot);
    expect(forwardingScope).toContain("followupTaskStores");
    expect(forwardingScope).toContain("taskBootId");

    const requiredFields = daemonSource.slice(channelBoot, daemonSource.indexOf(">>;", channelBoot));
    expect(requiredFields).toContain('"followupTaskStores"');
    expect(requiredFields).toContain('"taskBootId"');
  });

  it("declares task ownership state on both boot context contracts", () => {
    expect(typeSource).toContain("followupTaskStores?: Awaited<ReturnType<typeof setupSchedulers>>");
    expect(typeSource).toContain("taskBootId?: Awaited<ReturnType<typeof setupSchedulers>>");
    expect(proactiveSource).toContain('| "followupTaskStores" | "taskBootId"');
  });
});
