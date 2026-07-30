// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("durable recovery boot ordering", () => {
  it("installs graph and plain resume handlers before boot recovery starts", () => {
    const source = readFileSync(resolve("packages/daemon/src/daemon.ts"), "utf8");
    const graphHandler = source.indexOf("graphResumeHolder.ref =");
    const plainHandler = source.indexOf("plainResumeHolder.ref =");
    const recoveryStart = source.indexOf("await startAndResumeDurable");

    expect(graphHandler).toBeGreaterThanOrEqual(0);
    expect(plainHandler).toBeGreaterThanOrEqual(0);
    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(graphHandler).toBeLessThan(recoveryStart);
    expect(plainHandler).toBeLessThan(recoveryStart);
  });
});
