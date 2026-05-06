// SPDX-License-Identifier: Apache-2.0
//
// Test-only helpers for substituting the provider's stream/fetch function
// (B45 + CONTEXT D-T5). Mirrors the substitution-discipline pattern at
// packages/agent/src/executor/fault-injector.ts:48-103.
//
// NOT a production code path. Lives in __test-helpers/ to be visible to
// co-located *.test.ts only (the directory name is a TypeScript convention
// to communicate intent to humans + future tooling).
//
// All exported functions intentionally throw on invocation. Plan 15-02
// (cherry-pick) wires their real implementations against pi-ai's provider
// seam. Until then, calls produce assertion-grade failures (not module
// resolution errors) so the owning test (`details-prompt-isolation.test.ts`)
// reaches its assertions and turns RED in the planner-mandated way.
//
// @module

export interface CapturingProviderStub {
  /** Marker shape so consumers can pattern-match on it; intentionally minimal. */
  readonly _kind: "capturingProviderStub";
}

export interface CapturingProviderStubOpts {
  onSend: (body: unknown) => void;
  respondWith: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "stop";
  };
}

export function createCapturingProviderStub(_opts: CapturingProviderStubOpts): CapturingProviderStub {
  throw new Error(
    "createCapturingProviderStub: not implemented — Phase 5 (15-02) wires this against pi-ai's provider seam (B45)",
  );
}

export interface RunOneTurnWithProviderOpts {
  sessionPath: string;
  provider: CapturingProviderStub;
}

export function runOneTurnWithProvider(_opts: RunOneTurnWithProviderOpts): Promise<void> {
  return Promise.reject(
    new Error(
      "runOneTurnWithProvider: not implemented — Phase 5 (15-02) wires this against pi-ai's provider seam (B45)",
    ),
  );
}

export interface BuildFixtureSessionOpts {
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export function buildFixtureSessionWithToolResult(_opts: BuildFixtureSessionOpts): Promise<string> {
  return Promise.reject(
    new Error(
      "buildFixtureSessionWithToolResult: not implemented — Phase 5 (15-02) wires this against the JSONL session adapter (B45)",
    ),
  );
}

export function loadSession(_path: string): unknown {
  throw new Error(
    "loadSession: not implemented — Phase 5 (15-02) wires this against the JSONL session adapter (B45)",
  );
}

export function getVisibleAssistantText(_session: unknown): string {
  throw new Error(
    "getVisibleAssistantText: not implemented — Phase 5 (15-02) wires this against the prompt-assembly read path (B45)",
  );
}
