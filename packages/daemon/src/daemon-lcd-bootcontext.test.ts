// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-composition-root field-plumbing guard for the LCD store (`lcdStore`) —
 * the SECOND hop the sibling `setup-agents-lcd-wiring.test.ts` cannot see.
 *
 * That test drives `setupSingleAgent` with a `SingleAgentDeps` it CONSTRUCTS itself,
 * so it proves the `setupAgents → createPiExecutor` forward but is blind to the hop
 * UPSTREAM of it: in `daemon.ts` the memory bundle is destructured from
 * `setupMemory(...)` and then re-assembled into the `BootContext` object that
 * `bootAgents` (and thence `setupAgents`) consumes. `lcdStore` can be destructured
 * from `setupMemory` yet OMITTED from that `BootContext` literal — so `bootAgents`
 * receives `lcdStore: undefined`, `SingleAgentDeps.lcdStore` is always undefined,
 * the executor's `contextStore` is undefined, and the `dag` branch in
 * `context-engine.ts` silently falls back to pipeline in the live daemon (the loop
 * fix never reaches production). This is the SAME field-plumbing class as the
 * per-user / directional-relationship / tuned-alpha store BLOCKERS. The keyless
 * unit gates pass (the assembler is unit-tested with a hand-built store) yet the
 * live daemon never activates dag. This is exactly the gap that reached `main`
 * masked: the per-package executor run never ran the full `lint:security`, which
 * flags the destructured-but-unforwarded binding as an unused-var error at the
 * phase boundary.
 *
 * THE INVARIANT (a source-grep belt): in `daemon.ts` `lcdStore` must appear in
 * BOTH (a) the `setupMemory(...)` destructure block AND (b) a downstream
 * forwarding position (the `BootContext` literal that feeds `bootAgents`).
 * Removing the forward re-opens the no-op and re-trips this test.
 *
 * This is a `.test.ts` source-grep over our OWN composition root — it reads the file
 * with the real `node:fs` (this file does NOT mock it).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const daemonSrc = readFileSync(join(here, "daemon.ts"), "utf8");

describe("daemon.ts threads lcdStore from setupMemory into the BootContext (field-plumbing)", () => {
  it("destructures lcdStore from setupMemory(...)", () => {
    // Find the destructure block whose closing line is `} = await setupMemory(`.
    const idx = daemonSrc.indexOf("= await setupMemory(");
    expect(idx, "daemon.ts must call setupMemory(...)").toBeGreaterThan(-1);
    // The destructure body is the `const { ... }` immediately preceding that call.
    const before = daemonSrc.slice(0, idx);
    const openBrace = before.lastIndexOf("const {");
    expect(openBrace, "setupMemory result must be destructured with const { ... }").toBeGreaterThan(-1);
    const destructureBlock = daemonSrc.slice(openBrace, idx);
    expect(
      destructureBlock.includes("lcdStore"),
      "lcdStore must be destructured from setupMemory(...)",
    ).toBe(true);
  });

  it("forwards lcdStore into the BootContext within the same boot function (no unforwarded no-op)", () => {
    // SCOPE to the boot function that calls setupMemory: from the START of the
    // setupMemory destructure (the `const {` that opens it) to the next top-level
    // function (bootAgents). Within THIS scope lcdStore must appear at least TWICE —
    // once destructured from setupMemory and once more in the BootContext literal
    // (the Object.assign(boot, {...})). A single occurrence here
    // (destructured-but-never-forwarded) is the no-op the lint:security
    // unused-var error flags. Scoping to this function is what pins the test to
    // that gap (lcdStore uses in OTHER functions must not mask it).
    const callIdx = daemonSrc.indexOf("= await setupMemory(");
    expect(callIdx, "daemon.ts must call setupMemory(...)").toBeGreaterThan(-1);
    const scopeStart = daemonSrc.lastIndexOf("const {", callIdx);
    const nextFnIdx = daemonSrc.indexOf("async function bootAgents(", callIdx);
    expect(nextFnIdx, "bootAgents must follow the setupMemory boot function").toBeGreaterThan(callIdx);
    const bootFnScope = daemonSrc.slice(scopeStart, nextFnIdx);
    const occurrencesInScope = bootFnScope.split("lcdStore").length - 1;
    expect(
      occurrencesInScope,
      "within the boot function that calls setupMemory, lcdStore must be destructured AND forwarded into the BootContext (>=2 occurrences in-scope)",
    ).toBeGreaterThanOrEqual(2);
  });

  it("the bootAgents BootContext destructure carries lcdStore alongside its memory-store siblings", () => {
    // bootAgents destructures the memory bundle from the BootContext; lcdStore must
    // ride that bundle (it is read in bootAgents and forwarded into setupAgents).
    // Assert it co-occurs with a known sibling (entityStore) so the bundle stays whole.
    const bootAgentsIdx = daemonSrc.indexOf("async function bootAgents(");
    expect(bootAgentsIdx, "daemon.ts must define bootAgents(...)").toBeGreaterThan(-1);
    const bootAgentsBody = daemonSrc.slice(bootAgentsIdx);
    expect(
      bootAgentsBody.includes("lcdStore"),
      "bootAgents must receive lcdStore from the BootContext",
    ).toBe(true);
    expect(
      bootAgentsBody.includes("entityStore"),
      "the memory-store sibling bundle (entityStore) must be present in bootAgents",
    ).toBe(true);
  });

  it("forwards lcdStore into the setupAgents({...}) call", () => {
    // The terminal hop: bootAgents must pass lcdStore into the setupAgents({...})
    // deps object alongside entityStore. Scope from the setupAgents call to the end.
    const callIdx = daemonSrc.indexOf("= await setupAgents({");
    expect(callIdx, "daemon.ts must call setupAgents({...})").toBeGreaterThan(-1);
    // The deps object literal runs from the `{` after setupAgents to the matching
    // close; scan a generous window that includes the entityStore sibling line.
    const window = daemonSrc.slice(callIdx, callIdx + 4000);
    const entityIdx = window.indexOf("entityStore");
    expect(entityIdx, "setupAgents call must pass entityStore").toBeGreaterThan(-1);
    // lcdStore must appear in the same call's deps object (before the next 2 fn defs).
    const lcdIdx = window.indexOf("lcdStore");
    expect(lcdIdx, "setupAgents({...}) must pass lcdStore").toBeGreaterThan(-1);
  });
});
