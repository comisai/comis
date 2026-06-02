// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 111 (LEARN-03) daemon-composition-root field-plumbing guard — the SECOND
 * hop the sibling `setup-agents-tuned-alpha-wiring.test.ts` cannot see.
 *
 * That test drives `setupSingleAgent` with a `SingleAgentDeps` it CONSTRUCTS itself,
 * so it proves the `setupAgents → createPiExecutor` forward but is blind to the hop
 * UPSTREAM of it: in `daemon.ts` the memory bundle is destructured from
 * `setupMemory(...)` and then re-assembled into the `BootContext` object that
 * `bootAgents` (and thence `setupAgents`) consumes. A store can be destructured from
 * `setupMemory` yet OMITTED from that `BootContext` literal — so `bootAgents` receives
 * `tunedAlphaStore: undefined`, `SingleAgentDeps.tunedAlphaStore` is always undefined,
 * and the 111-03 gated `buildScoringAlphas` read never sees the store (the learned
 * alphas silently never apply in the live daemon — Pitfall 5, the SAME field-plumbing
 * class as the Phase-107/108 BLOCKERS). The keyless bench passes (it builds the adapter
 * directly) and the unit forward-test passes (it builds the deps directly), yet the
 * live daemon is a no-op. This is exactly the gap that reached `main` masked: the
 * per-package executor run never ran the full `lint:security`, which flagged the
 * destructured-but-unforwarded binding as an unused-var error at the phase boundary.
 *
 * THE INVARIANT (a source-grep belt, the 111-01/02/04 convention): in `daemon.ts`
 * `tunedAlphaStore` must appear in BOTH (a) the `setupMemory(...)` destructure block
 * AND (b) a downstream forwarding position (the `BootContext` literal that feeds
 * `bootAgents`). Removing the forward re-opens the no-op and re-trips this test.
 *
 * This is a `.test.ts` source-grep over our OWN composition root — it reads the file
 * with the real `node:fs` (this file does NOT mock it, unlike the sibling).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const daemonSrc = readFileSync(join(here, "daemon.ts"), "utf8");

describe("daemon.ts threads tunedAlphaStore from setupMemory into the BootContext (LEARN-03 field-plumbing)", () => {
  it("destructures tunedAlphaStore from setupMemory(...)", () => {
    // Find the destructure block whose closing line is `} = await setupMemory(`.
    const idx = daemonSrc.indexOf("= await setupMemory(");
    expect(idx, "daemon.ts must call setupMemory(...)").toBeGreaterThan(-1);
    // The destructure body is the `const { ... }` immediately preceding that call.
    const before = daemonSrc.slice(0, idx);
    const openBrace = before.lastIndexOf("const {");
    expect(openBrace, "setupMemory result must be destructured with const { ... }").toBeGreaterThan(-1);
    const destructureBlock = daemonSrc.slice(openBrace, idx);
    expect(
      destructureBlock.includes("tunedAlphaStore"),
      "tunedAlphaStore must be destructured from setupMemory(...)",
    ).toBe(true);
  });

  it("forwards tunedAlphaStore into the BootContext within the same boot function (no unforwarded no-op)", () => {
    // SCOPE to the boot function that calls setupMemory: from that call to the start of
    // the next top-level function (bootAgents). Within THIS scope tunedAlphaStore must
    // appear at least TWICE — once destructured from setupMemory and once more in the
    // BootContext literal the function returns. Pre-fix it appeared exactly ONCE here
    // (destructured-but-never-forwarded), which is the no-op the lint:security unused-var
    // error flagged. Scoping to this function is what makes the test RED on that gap
    // (the other tunedAlphaStore uses live in OTHER functions and must not mask it).
    // Scope from the START of the setupMemory destructure (the `const {` that opens it,
    // which carries the destructured tunedAlphaStore BEFORE the `= await setupMemory(`
    // keyword) to the next top-level function (bootAgents). Within THIS scope both the
    // destructure AND the BootContext forward (the Object.assign(boot, {...}) literal)
    // must mention tunedAlphaStore.
    const callIdx = daemonSrc.indexOf("= await setupMemory(");
    expect(callIdx, "daemon.ts must call setupMemory(...)").toBeGreaterThan(-1);
    const scopeStart = daemonSrc.lastIndexOf("const {", callIdx);
    const nextFnIdx = daemonSrc.indexOf("async function bootAgents(", callIdx);
    expect(nextFnIdx, "bootAgents must follow the setupMemory boot function").toBeGreaterThan(callIdx);
    const bootFnScope = daemonSrc.slice(scopeStart, nextFnIdx);
    const occurrencesInScope = bootFnScope.split("tunedAlphaStore").length - 1;
    expect(
      occurrencesInScope,
      "within the boot function that calls setupMemory, tunedAlphaStore must be destructured AND forwarded into the BootContext (>=2 occurrences in-scope)",
    ).toBeGreaterThanOrEqual(2);
  });

  it("the bootAgents BootContext destructure carries tunedAlphaStore alongside its memory-store siblings", () => {
    // bootAgents destructures the memory bundle from the BootContext; tunedAlphaStore
    // must ride that bundle (it is read in bootAgents and forwarded into setupAgents).
    // Assert it co-occurs with a known sibling (relationshipStore) so the bundle stays whole.
    const bootAgentsIdx = daemonSrc.indexOf("async function bootAgents(");
    expect(bootAgentsIdx, "daemon.ts must define bootAgents(...)").toBeGreaterThan(-1);
    const bootAgentsBody = daemonSrc.slice(bootAgentsIdx);
    expect(
      bootAgentsBody.includes("tunedAlphaStore"),
      "bootAgents must receive tunedAlphaStore from the BootContext",
    ).toBe(true);
    expect(
      bootAgentsBody.includes("relationshipStore"),
      "the memory-store sibling bundle (relationshipStore) must be present in bootAgents",
    ).toBe(true);
  });
});
