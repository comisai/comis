// SPDX-License-Identifier: Apache-2.0
/**
 * Transparency label-coverage gate.
 *
 * Walks the LIVE platform-tool descriptor registry — the single source of
 * truth for every emitted `AgentTool.name` — and asserts each tool is
 * EXPLICITLY classified for the activity transparency contract: either it
 * has a registered {@link hasRegisteredLabelSpec | LabelSpec} (user-meaningful
 * activity), or it is flagged `suppressActivity:true` (internal / read-only /
 * poll). A tool that is neither is an offender: it would ship with a silently
 * humanized fallback label and bypass the activity-transparency review.
 *
 * Why the registry walk (not a hardcoded list): the gate must enumerate the
 * live registry so a newly-added tool that forgets a spec/suppress flag fails
 * THIS test immediately (this is a coverage gate, not a fixture).
 *
 * Why `hasRegisteredLabelSpec` (not `resolveLabelSpec`): `resolveLabelSpec` is
 * TOTAL — it always returns a humanized fallback — so "did resolution succeed?"
 * passes for every tool and is a no-op gate. The coverage
 * check must ask "was a spec explicitly registered?".
 *
 * Why emitted names: `descriptor.name` is a registry-side label and is NOT
 * guaranteed to equal the emitted `AgentTool.name` (e.g. `notify`→`notify_user`,
 * `image`→`image_analyze`, `tts`→`tts_synthesize`). The activity stream resolves
 * on the EMITTED name, so the
 * gate (and the registrations) must key on `descriptor.build(ctx).name`.
 *
 * Scope note: `bash`/`exec`/`shell` are pi-agent-core builtins, NOT platform
 * descriptors — they are out of this registry and delegate to
 * shell-label-parser.ts. The gate walks only the platform
 * registry and does NOT expect shell tools.
 *
 * Importing the tool modules and the suppression-metadata module for their
 * side-effect registrations is what flips this test GREEN — the registry walk
 * just observes the resulting state.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { hasRegisteredLabelSpec, getToolMetadata, resolveLabelSpec } from "@comis/core";
import { createPlatformToolRegistry } from "../platform-tools/registry.js";

// Mirror the parity-test build harness: descriptor `build` callbacks return
// AgentTool objects whose `name`/`parameters` are static, captured at module
// load. The RPC stub is never invoked by `build`.
const STUB_CTX = {
  agentId: "test-agent",
  rpcCall: async () => ({}) as never,
} as never;

describe("transparency label-coverage gate", () => {
  it("fails when a platform tool lacks both a LabelSpec and a suppressActivity flag", () => {
    const offenders: string[] = [];
    for (const descriptor of createPlatformToolRegistry()) {
      const tool = descriptor.build(STUB_CTX);
      if (!tool) continue; // conditional descriptors gated off under the stub ctx
      const name = tool.name; // the EMITTED name (NOT descriptor.name)
      const suppressed = getToolMetadata(name)?.suppressActivity === true;
      const hasSpec = hasRegisteredLabelSpec(name); // NOT resolveLabelSpec, which is total and always returns a fallback
      if (!suppressed && !hasSpec) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("binds the notify activity-label spec on the EMITTED name notify_user, not the descriptor name notify", () => {
    // Proves the registration keyed on the emitted name: resolving the emitted
    // name returns the registered label, while the descriptor name falls back
    // to its bare humanized form. A descriptor-name keying would invert this.
    const emitted = resolveLabelSpec("notify_user");
    expect(hasRegisteredLabelSpec("notify_user")).toBe(true);
    expect(emitted.label).not.toBe("notify user"); // not the humanized fallback
    // The descriptor name has no registration of its own.
    expect(hasRegisteredLabelSpec("notify")).toBe(false);
  });
});
