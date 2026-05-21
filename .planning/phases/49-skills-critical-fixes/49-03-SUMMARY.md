---
phase: 49-skills-critical-fixes
plan: 03
subsystem: security
tags: [security, prompt-injection, mcp-bridge, external-content, wrap, daemon-plumbing, tdd]

# Dependency graph
requires:
  - phase: 49-01
    provides: "ExternalContentSource union extended with mcp_tool member + EXTERNAL_SOURCE_LABELS['mcp_tool']='MCP tool result'"
provides:
  - "mcpToolsToAgentTools signature extended to 5 positional parameters; LAST is onSuspiciousContent?: WrapExternalContentOptions['onSuspiciousContent']"
  - "MCP tool success-path text wrapped with wrapExternalContent({ source: 'mcp_tool', onSuspiciousContent }) AFTER source-profile cap"
  - "PlatformToolBuildContext.onSuspiciousContent optional field (additive — parity-test stable)"
  - "Daemon setup-tools.ts forwards onSuspiciousContent at 2 new hops: getMcpTools 5th arg (L305) + PlatformToolBuildContext literal shorthand (L407)"
  - "4 new test cases in mcp-tool-bridge.test.ts locking the wrap contract"
affects:
  - "Phase 49 gate (pnpm validate post Plans 01+02+03+04) — Plan 03 is the MCP-bridge / tools-side branch of CRIT-01"
  - "Phase 50 merge order — Plan 03 edits at L300+L400 are non-adjacent to Phase 50's L704 deletion (3-way merge clean)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cap-then-wrap source-textual ordering: when both a content cap and a boundary-marker wrap apply to the same source, the cap MUST appear textually BEFORE the wrap so wrap markers are never truncated mid-content. Verified at compile-time-equivalent via line-number comparison in acceptance criteria (WRAP_LINE > CAP_LINE)."
    - "5th positional optional callback forwarding: the daemon's onSuspiciousContent reaches mcp-tool-bridge.ts via a 4-hop chain (agents-helpers.ts:buildAuditBundle → setup-tools.ts:213 destructure → setup-tools.ts:300 5th arg → mcp-tool-bridge.ts:execute wrap call). The shape is identical to link-formatter.ts:injectLinkContext — the canonical 'wrap inside generic function with optional onSuspiciousContent last-parameter' analog."

key-files:
  created: []
  modified:
    - "packages/skills/src/skills/bridge/mcp-tool-bridge.ts"
    - "packages/skills/src/skills/bridge/mcp-tool-bridge.test.ts"
    - "packages/skills/src/platform-tools/registry.ts"
    - "packages/daemon/src/wiring/setup-tools.ts"

key-decisions:
  - "Cap-then-wrap order (per RESEARCH.md Open Question 1 — overriding the Code Examples wrap-then-cap snippet): wrap markers + SECURITY NOTICE add fixed ~150-byte boilerplate AFTER the per-source cap. The cap governs CONTENT length, not wrapper overhead. Wrap-then-cap would truncate the closing <<<END_UNTRUSTED_xxx>>> marker mid-content and break the boundary contract."
  - "5th-positional optional, NOT options-object refactor: preserves all existing 4-arg callers (only known caller is setup-tools.ts:300, which Task 4 updates). Options-object refactor was rejected as scope creep per RESEARCH.md Pitfall #3."
  - "`if (textParts)` guard before wrap: preserves the existing empty-content fallback path ('Tool returned no text content'). When textParts === '' after sanitize+cap, wrap is skipped and the fallback string ships as before."
  - "Error paths (!result.ok, isError=true, catch block) NOT wrapped: error content is operator-facing diagnostic, not a prompt-injection vector. The 'MCP tool error:' / 'crashed unexpectedly' prefixes already mark errors as control-plane. Wrapping them would obscure diagnostics with security-notice noise."
  - "Updated 7 pre-existing tests via Rule 1 (auto-fix): they previously asserted exact-equality on unwrapped output. After the wrap edit, output now contains content + ~700 bytes of boundary markers + SECURITY NOTICE; updated assertions to `toContain(content)` (envelope) and JSON-aware tests now extract inner content via `<<<UNTRUSTED_xxx>>>…<<<END_UNTRUSTED_xxx>>>` regex before parsing."

patterns-established:
  - "Inline cap-then-wrap rationale comment: when source code applies both a content cap and a boundary-marker wrap to the same byte stream, an in-source comment immediately above the wrap call ('// CRIT-01: wrap AFTER cap so SECURITY NOTICE boilerplate is preserved') serves as the canonical in-source reference — defends against a future maintainer reverting to wrap-then-cap."

requirements-completed: [CRIT-01]

# Metrics
duration: 5m 28s
completed: 2026-05-21
---

# Phase 49 Plan 03: MCP Bridge wrapExternalContent Integration Summary

**MCP tool success-path text now wrapped with `wrapExternalContent({ source: 'mcp_tool' })` AFTER the source-profile cap — closes the 5th of 5 CRIT-01 external-content bypass sites and threads onSuspiciousContent through 4 forwarding hops from the daemon audit aggregator to the skills-side wrap call.**

## Performance

- **Duration:** 5m 28s
- **Started:** 2026-05-21T18:29:13Z (Task 1 commit)
- **Completed:** 2026-05-21T18:34:41Z (Task 4 commit)
- **Tasks:** 5 (RED + GREEN-source + GREEN-registry + GREEN-daemon + VALIDATE)
- **Files modified:** 4

## Accomplishments

- Extended `mcpToolsToAgentTools` signature from 4 to 5 positional parameters. New 5th parameter `onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"]` is LAST/optional — all pre-existing 4-arg callers continue compiling unchanged.
- Wrapped MCP tool success-path `textParts` with `wrapExternalContent({ source: "mcp_tool", onSuspiciousContent })` AFTER the source-profile cap at `mcp-tool-bridge.ts:283`. Source-textual order verified: WRAP_LINE=283 > CAP_LINE=271.
- Added `PlatformToolBuildContext.onSuspiciousContent` optional field (additive — `tool-registry-parity.test.ts` passes unchanged via `STUB_CTX as never` cast).
- Daemon `setup-tools.ts` forwards `onSuspiciousContent` at 2 new hops:
  - L305 — `getMcpTools` passes it as the new 5th argument to `mcpToolsToAgentTools`.
  - L407 — `PlatformToolBuildContext` literal forwards it via shorthand field name between `eventBus` and `imageGenProvider`.
- 4 new test cases in `mcp-tool-bridge.test.ts` lock the wrap contract:
  - `wraps success-path text content with UNTRUSTED_ markers`
  - `fires onSuspiciousContent callback with source=mcp_tool when MCP result contains injection pattern`
  - `does NOT wrap error-path content (isError=true ships diagnostics raw)`
  - `cap-then-wrap order: profile cap applies to content, wrap markers preserved intact`
- Validation: skills tests 4086/5 skip, daemon tests 2595/0 skip, root `pnpm build` clean across all 16 packages, `pnpm lint:security` 0 errors / 1663 pre-existing warnings, `pnpm cycles` no circular deps.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add failing wrap-integration tests** — `4d384644` (test)
   - 4 new RED test cases in mcp-tool-bridge.test.ts; ToolSourceProfile type-only import added; canonical injection-pattern string constructed via concatenation to avoid verbatim literal in source.
   - RED gate: 3 of 4 fail (UNTRUSTED markers missing, callback not invoked, wrap markers absent on capped content). The 4th — error-path no-wrap — passes pre-fix because the error path already doesn't wrap.
   - 1 file changed, 109 insertions.

2. **Task 2 (GREEN): Wrap MCP tool result text after cap** — `bf540367` (feat)
   - Extended `@comis/core` import for `wrapExternalContent` + `WrapExternalContentOptions`.
   - Extended `mcpToolsToAgentTools` signature with 5th positional optional.
   - Wrapped `textParts` AFTER the source-profile cap (L283) with `if (textParts)` guard preserving empty-content fallback.
   - Inline source comment `// CRIT-01: wrap AFTER cap so SECURITY NOTICE boilerplate is preserved` documents the cap-then-wrap rationale at the call site.
   - Updated 7 pre-existing tests (Rule 1 auto-fix) that asserted exact-equality on unwrapped output: `toBe(content)` → `toContain(content)`; JSON-aware tests extract inner content via `<<<UNTRUSTED_xxx>>>…<<<END_UNTRUSTED_xxx>>>` regex before `JSON.parse`.
   - 4 RED tests now GREEN; full skills test suite 4086/5 skip — no regression.
   - 2 files changed, 55 insertions, 12 deletions.

3. **Task 3 (GREEN-registry): Add PlatformToolBuildContext.onSuspiciousContent** — `c810a537` (feat)
   - Extended type-only import from `@comis/core` to bring in `WrapExternalContentOptions`.
   - Added optional field between `eventBus` and `imageGenProvider` (matching daemon ctx literal forwarding order).
   - Parity test `tool-registry-parity.test.ts` passes unchanged — optional-field addition is parity-safe via `STUB_CTX as never` narrowing.
   - 1 file changed, 8 insertions, 1 deletion.

4. **Task 4 (GREEN-daemon): Forward onSuspiciousContent through setup-tools.ts** — `408591fb` (feat)
   - L305 — `getMcpTools` passes `onSuspiciousContent` as the new 5th argument. The variable was already in lexical scope from the pre-existing L213 destructure of `deps` — closure capture, no re-destructure.
   - L407 — `PlatformToolBuildContext` literal forwards via shorthand field name.
   - End-to-end chain verified: AgentsHandle.onSuspiciousContent → setup-tools.ts:213 destructure → setup-tools.ts:305 5th arg → mcp-tool-bridge.ts:283 wrap call.
   - Daemon build clean against skills' new signature; daemon vitest suite 2595/0 skip.
   - 1 file changed, 2 insertions.

5. **Task 5 (VALIDATE)** — no commit (validation-only task per the plan).
   - `cd packages/skills && pnpm vitest run` — 191 files, 4086 pass, 5 pre-existing skips.
   - `cd packages/daemon && pnpm vitest run` — 133 files, 2595 pass.
   - `pnpm build` (root) — all 16 packages clean.
   - `pnpm lint:security` exit 0 (0 errors, 1663 pre-existing warnings).
   - `pnpm cycles` exit 0 (no circular deps).

_Note: TDD gate sequence — test(49-03) → feat(49-03) → feat(49-03) → feat(49-03) — is satisfied. The plan-level TDD gate (RED commit before GREEN commit) is verified by the chronological order of `4d384644` (test) before `bf540367` (feat)._

## Files Created/Modified

- `packages/skills/src/skills/bridge/mcp-tool-bridge.ts` — Added wrap call site at L283, extended signature with 5th positional optional, extended `@comis/core` import. Source-textual cap-then-wrap order verified.
- `packages/skills/src/skills/bridge/mcp-tool-bridge.test.ts` — 4 new RED-then-GREEN test cases for wrap-on-success, callback-fires-on-suspicious, no-wrap-on-error, cap-then-wrap order; 7 pre-existing tests updated to assert against wrapped output (envelope-aware assertions).
- `packages/skills/src/platform-tools/registry.ts` — Added `onSuspiciousContent` optional field to `PlatformToolBuildContext`; extended `@comis/core` type-only import for `WrapExternalContentOptions`.
- `packages/daemon/src/wiring/setup-tools.ts` — Forwarded `onSuspiciousContent` at 2 hops (getMcpTools 5th arg + PlatformToolBuildContext literal shorthand).

### Verbatim before/after — mcp-tool-bridge.ts signature (L178-184)

**Before:**
```typescript
export function mcpToolsToAgentTools(
  tools: McpToolDefinition[],
  callTool: McpClientManager["callTool"],
  toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>,
  logger?: McpBridgeLogger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): AgentTool<any>[] {
```

**After:**
```typescript
export function mcpToolsToAgentTools(
  tools: McpToolDefinition[],
  callTool: McpClientManager["callTool"],
  toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>,
  logger?: McpBridgeLogger,
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): AgentTool<any>[] {
```

### Verbatim before/after — mcp-tool-bridge.ts wrap insertion (L268-289)

**Before:**
```typescript
          // Source-gate: cap text to resolved profile's maxChars limit
          const profile = resolveSourceProfile(sanitizedName, toolSourceProfiles?.[sanitizedName]);
          if (textParts.length > profile.maxChars) {
            const { truncated } = truncateJsonAware(textParts, profile.maxChars);
            textParts = truncated;
          }

          const successResult = {
            content: [{ type: "text" as const, text: textParts || "Tool returned no text content" }],
            details: { success: true },
          };
```

**After:**
```typescript
          // Source-gate: cap text to resolved profile's maxChars limit
          const profile = resolveSourceProfile(sanitizedName, toolSourceProfiles?.[sanitizedName]);
          if (textParts.length > profile.maxChars) {
            const { truncated } = truncateJsonAware(textParts, profile.maxChars);
            textParts = truncated;
          }

          // CRIT-01: wrap AFTER cap so SECURITY NOTICE boilerplate is preserved
          // (wrap-then-cap would truncate the closing <<<END_UNTRUSTED_xxx>>>
          // marker mid-content). Fixed ~150-byte wrapper boilerplate sits beyond
          // the per-source maxChars budget — the cap governs content size, not
          // wrapper overhead. The `if (textParts)` guard preserves the empty-
          // content fallback "Tool returned no text content" path below.
          if (textParts) {
            textParts = wrapExternalContent(textParts, {
              source: "mcp_tool",
              onSuspiciousContent,
            });
          }

          const successResult = {
            content: [{ type: "text" as const, text: textParts || "Tool returned no text content" }],
            details: { success: true },
          };
```

### Cap-then-wrap source-textual order (load-bearing acceptance criterion)

Per Plan 03 Task 2 acceptance criterion enforcing `WRAP_LINE > CAP_LINE`:

```
CAP_LINE  (textParts.length > profile.maxChars)   = 271
WRAP_LINE (wrapExternalContent — non-import)      = 283
WRAP_LINE > CAP_LINE = TRUE  → cap-then-wrap order verified
```

### Verbatim diff — daemon hop #1 (setup-tools.ts:296-307 → 296-308)

**Before:**
```typescript
  function getMcpTools(toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>): ReturnType<PlatformToolProvider> {
    const mcpTools = mcpClientManager.getTools();
    if (mcpTools.length === 0) return [];
    const agentMcpTools = mcpToolsToAgentTools(
      mcpTools,
      mcpClientManager.callTool.bind(mcpClientManager),
      toolSourceProfiles,
      skillsLogger,
    );
    return agentMcpTools;
  }
```

**After:**
```typescript
  function getMcpTools(toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>): ReturnType<PlatformToolProvider> {
    const mcpTools = mcpClientManager.getTools();
    if (mcpTools.length === 0) return [];
    const agentMcpTools = mcpToolsToAgentTools(
      mcpTools,
      mcpClientManager.callTool.bind(mcpClientManager),
      toolSourceProfiles,
      skillsLogger,
      onSuspiciousContent,
    );
    return agentMcpTools;
  }
```

### Verbatim diff — daemon hop #2 (setup-tools.ts ctx literal, L400-446 region)

**Before (excerpt):**
```typescript
      const ctx: PlatformToolBuildContext = {
        agentId,
        rpcCall: agentRpc,
        skillsLogger,
        approvalGate,
        eventBus,
        imageGenProvider: deps.imageGenProvider,
        backgroundTaskManager: deps.backgroundTaskManager,
```

**After (excerpt):**
```typescript
      const ctx: PlatformToolBuildContext = {
        agentId,
        rpcCall: agentRpc,
        skillsLogger,
        approvalGate,
        eventBus,
        onSuspiciousContent,
        imageGenProvider: deps.imageGenProvider,
        backgroundTaskManager: deps.backgroundTaskManager,
```

Note: the **media-side daemon hops** (`setup-channels-media.ts`, `setup-channels/setup-channels-registry.ts`, `stages/channels-helpers.ts`) are **owned by Plan 02** (which runs in parallel as the WAVE-A media branch). Plan 03's daemon scope is strictly the MCP-bridge / tools track via `setup-tools.ts` + `platform-tools/registry.ts`. The two daemon-plumbing tracks are independent — both consume the same upstream `AgentsHandle.onSuspiciousContent` callback via separate destructure paths.

## Decisions Made

(Captured in frontmatter `key-decisions`. Repeated here for fast prose-context.)

- **Cap-then-wrap order** is the load-bearing decision. RESEARCH.md's §"Code Examples / CRIT-01 — MCP bridge wrap" snippet showed wrap-then-cap, but §"Open Questions" resolved it the other way; the planner's explicit acceptance criterion at Task 2 (textual line-number comparison) and the inline source comment make cap-then-wrap the canonical pattern in the file. Future maintainers reading mcp-tool-bridge.ts see the rationale immediately.
- **5th-positional optional** (no options-object refactor): preserves the single known existing caller at setup-tools.ts:300 with zero TS-error noise.
- **`if (textParts)` guard**: preserves the empty-content fallback ('Tool returned no text content') already in the codebase. The guard fires when an MCP server returns no text parts (e.g., image-only response — see existing `execute() returns fallback text when no text content` test).
- **Error paths intentionally not wrapped**: error content is operator diagnostic; the existing `MCP tool error:` / `crashed unexpectedly` prefixes already mark it as control-plane.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated 7 pre-existing tests broken by wrap addition**
- **Found during:** Task 2 (GREEN source edit)
- **Issue:** 7 tests in `mcp-tool-bridge.test.ts` asserted exact-equality on the unwrapped success-path text (`expect(text).toBe(content)`, `expect(text.length).toBe(50_000)`, `JSON.parse(text)`). After Task 2's wrap addition, the success-path text now contains content embedded inside `<<<UNTRUSTED_xxx>>>…<<<END_UNTRUSTED_xxx>>>` markers + SECURITY NOTICE boilerplate (~700 fixed bytes).
- **Fix:** Updated assertions to envelope-aware shapes: `toBe(content)` → `toContain(content)`, exact-length checks relaxed to `toBeLessThanOrEqual(cap + wrapper-bytes)`, JSON-aware tests extract inner content via `<<<UNTRUSTED_[a-f0-9]+>>>\n([\s\S]+?)\n<<<END_UNTRUSTED_[a-f0-9]+>>>` regex + `\n---\n` metadata strip before `JSON.parse`. Added a local `extractWrappedContent(wrapped)` helper at the top of the JSON-aware describe block.
- **Files modified:** `packages/skills/src/skills/bridge/mcp-tool-bridge.test.ts`
- **Verification:** Full skills suite 4086/5 skip — no regression. The 4 new CRIT-01 tests + the 7 updated tests + 40 untouched tests all pass.
- **Committed in:** `bf540367` (Task 2 commit — same diff as the source change that caused the break)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 — direct consequence of the wrap addition)
**Impact on plan:** The wrap edit unavoidably changes the success-path output shape. The pre-existing tests were asserting against the pre-wrap shape; updating them to envelope-aware assertions is the minimum-viable change to keep the suite green. No scope creep: the updated assertions still verify the cap + content-preservation invariants that were originally being tested, just expressed in terms of the new envelope.

## Issues Encountered

- **Worktree had no `node_modules/`.** First `pnpm build` failed with `Cannot find module '@comis/shared'`. Resolved by running `pnpm install --frozen-lockfile` (7s) and then `pnpm --filter @comis/shared --filter @comis/core build` to seed project references before downstream tsc.
- **Daemon build initially failed** with `Cannot find module '@comis/observability'` and other workspace-package imports because transitive packages weren't pre-built. Resolved by running `pnpm --filter @comis/infra --filter @comis/observability --filter @comis/memory --filter @comis/agent --filter @comis/channels --filter @comis/orchestrator --filter @comis/scheduler --filter @comis/gateway build` once.

Both are normal worktree-setup costs, not plan deviations. They match the same costs documented in 49-01-SUMMARY.md (Issues Encountered).

## User Setup Required

None — pure source-tree change with no external service configuration, environment variables, or secrets.

## Next Phase Readiness

- **Plan 49-02 is the parallel WAVE-A track** (media-side daemon plumbing + media-handler wraps). Plan 03 does not touch any file in Plan 02's surface (`setup-channels-media.ts`, `setup-channels-registry.ts`, `channels-helpers.ts`, `media-handler-{audio,image,video}.ts`, `media-preprocessor.ts`). The two tracks merge cleanly.
- **Phase 49 gate (`pnpm validate`)** is the post-WAVE step the orchestrator runs after Plans 01 + 02 + 03 + 04 all land. CRIT-01 is closed end-to-end once Plan 02 lands (the 4 media bypass sites); Plan 03 closes the 5th (MCP).
- **Phase 50 merge order:** Plan 03 edits in setup-tools.ts at L305 + L407 are non-adjacent to Phase 50's L704 deletion; 3-way merge resolves cleanly in either order. No coordination needed.
- **No blockers** for the WAVE-A merge.

## Self-Check: PASSED

- `packages/skills/src/skills/bridge/mcp-tool-bridge.ts` exists; `grep -c 'wrapExternalContent' = 2` (import + 1 call site); `grep -c 'source: "mcp_tool"' = 1`; `grep -c 'onSuspiciousContent' = 2`; signature has 5 positional parameters; CRIT-01 inline comment present; WRAP_LINE=283 > CAP_LINE=271 (cap-then-wrap source-textual order). ✓
- `packages/skills/src/skills/bridge/mcp-tool-bridge.test.ts` exists; 4 new test cases land in `describe("mcpToolsToAgentTools - wrapExternalContent integration (CRIT-01)", ...)`; `grep -c "UNTRUSTED_" = 6` (≥4); `grep -c 'source: "mcp_tool"' = 1`; `grep -c "Source: MCP tool result" = 1`. ✓
- `packages/skills/src/platform-tools/registry.ts` exists; `grep -c 'WrapExternalContentOptions' = 2` (import + field); `grep -c 'onSuspiciousContent' = 1`; field is optional (`readonly onSuspiciousContent?:`). ✓
- `packages/daemon/src/wiring/setup-tools.ts` exists; `getMcpTools` block contains `onSuspiciousContent`; ctx literal contains `onSuspiciousContent,` shorthand directly after `eventBus,`. ✓
- Commit `4d384644` (test, Task 1) reachable from HEAD. ✓
- Commit `bf540367` (feat, Task 2) reachable from HEAD. ✓
- Commit `c810a537` (feat, Task 3) reachable from HEAD. ✓
- Commit `408591fb` (feat, Task 4) reachable from HEAD (= HEAD itself). ✓
- `cd packages/skills && pnpm vitest run` — 4086 pass / 5 pre-existing skips. ✓
- `cd packages/daemon && pnpm vitest run` — 2595 pass. ✓
- `pnpm build` (root) exits 0 across all 16 packages. ✓
- `pnpm lint:security` exits 0 (0 errors, 1663 pre-existing warnings — matches Plan 49-01 baseline). ✓
- `pnpm cycles` exits 0 (no circular dependencies). ✓

---
*Phase: 49-skills-critical-fixes*
*Plan: 03*
*Completed: 2026-05-21*
