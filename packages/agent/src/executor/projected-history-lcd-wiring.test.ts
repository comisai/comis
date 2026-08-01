// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("projected conversation LCD wiring", () => {
  it("reconciles persisted history before turn preparation can read it", () => {
    const executor = source("./pi-executor/pi-executor.ts");
    const projection = executor.indexOf("projectInboundConversation(sm)");
    const reconciliation = executor.indexOf(
      "ingestProjectedConversationHistory",
      projection,
    );
    const preparation = executor.indexOf("prepareTurn({", projection);

    expect(projection).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(projection);
    expect(reconciliation).toBeLessThan(preparation);
  });

  it("projects the completed turn before persisting canonical LCD history", () => {
    const postExecution = source("./executor-post-execution.ts");
    const contextGate = postExecution.indexOf(
      "if (shouldRunContextStorePasses(config)",
    );
    const nextStage = postExecution.indexOf("attributeRecallUsage", contextGate);
    const block = postExecution.slice(contextGate, nextStage);

    expect(block).toContain("projectInboundConversation(sm)");
    expect(block).toContain("ingestProjectedConversationHistory");
    expect(block).toMatch(
      /session\.agent\.state\.messages\s*=\s*completedProjection\.value\.messages/,
    );
  });
});
