// SPDX-License-Identifier: Apache-2.0
/**
 * Single source of truth for classifying a TYPED RPC refusal.
 *
 * ## Why this lives in `@comis/core`
 * An RPC error is classified + logged at **two** layers: the daemon's
 * `classifyRpcError` (`packages/daemon/src/api/rpc-dispatch.ts`) AND the
 * `@comis/gateway` method-router trace wrapper (`classifyRpcMethodError`). The
 * gateway is a lower-level library and **cannot `instanceof`** the daemon
 * (`PreconditionError`/`ValidationError`/`AuthorizationError`), `@comis/agent`
 * (`SandboxDowngradeError`), or local (`RequiredToolsUnreachableError`) error classes —
 * the dependency direction forbids it.
 *
 * If each layer hard-coded its own typed→kind mapping they would drift: one
 * layer logging an intentional policy/security refusal as `internal`/ERROR(50)
 * while the other logs `precondition`/warn means a `logscan --level 50,60`
 * operator health sweep flags a fail-closed
 * refusal as an ERROR. Both layers therefore
 * delegate here, keyed off the stable {@link Error.name} — the lowest-common-denominator
 * signal available WITHOUT a cross-package import. **Add a new typed refusal in ONE
 * place: {@link TYPED_RPC_ERROR_BY_NAME}.**
 *
 * ## Scope
 * This recognizes the TYPED refusals only. Each caller keeps its OWN fallback for an
 * UNRECOGNIZED error (the daemon defaults to `internal`/`error`; the gateway applies its
 * message-substring heuristics then `internal`/`error`) — those fallbacks legitimately
 * differ per layer and are deliberately NOT unified here.
 *
 * A typed refusal is an EXPECTED caller-side / policy / security outcome, never an
 * internal handler fault, so its `level` is always `"warn"` and its `errorKind` is
 * never `"internal"`.
 *
 * @module
 */

/** The non-internal error kinds a typed RPC refusal classifies as. */
export type TypedRpcErrorKind = "precondition" | "validation" | "auth";

/** Classification of a recognized typed RPC refusal. `level` is always `"warn"`. */
export interface TypedRpcErrorClassification {
  readonly errorKind: TypedRpcErrorKind;
  readonly hint: string;
  readonly level: "warn";
}

// Keyed by `Error.name` (a `Map` — not object indexing — to keep the key set closed and
// avoid the `detect-object-injection` sink on the `.get(name)` lookup). The name strings
// are the CONTRACT with the error classes (each sets `this.name`); keep this map in sync
// when a class is renamed or a new typed refusal is introduced. The hints here are the
// single per-class hint text — the daemon and gateway layers both delegate here, so the
// same refusal produces byte-identical hints (including the knob-naming hints) at both layers.
const TYPED_RPC_ERROR_BY_NAME: ReadonlyMap<string, TypedRpcErrorClassification> = new Map([
  // Caller precondition failures (incl. gated-off policy refusals).
  ["PreconditionError", { errorKind: "precondition", hint: "Caller precondition not met; check resource state before retry", level: "warn" } as const],
  // Fail-closed SECURITY refusal (the sub-agent sandbox no-downgrade gate).
  ["SandboxDowngradeError", { errorKind: "precondition", hint: "Child sandbox posture is less confined than its spawner; align the child's skills sandbox config or set security.agentToAgent.sandboxNoDowngrade:false to allow", level: "warn" } as const],
  // Caller-side validation failures.
  ["ValidationError", { errorKind: "validation", hint: "Check parameter types and values against the schema", level: "warn" } as const],
  ["RequiredToolsUnreachableError", { errorKind: "validation", hint: "Adjust required_tools and/or tool_groups per the per-tool hints in the error message", level: "warn" } as const],
  // Expected authorization refusal (wrong-trust control-plane call).
  ["AuthorizationError", { errorKind: "auth", hint: "Caller lacks admin trust for this control-plane method; use an admin-scoped token or the documented operator route (e.g. `comis explain` assembles obs reports offline)", level: "warn" } as const],
]);

/**
 * Classify a TYPED RPC refusal by its {@link Error.name}, or return `null` when the
 * error is NOT a recognized typed refusal (the caller then applies its own fallback).
 *
 * Pure + dependency-free: no I/O, no error-class imports (keyed off the `.name` string),
 * deterministic for a given input.
 */
export function classifyTypedRpcError(err: unknown): TypedRpcErrorClassification | null {
  const name = err instanceof Error ? err.name : "";
  return TYPED_RPC_ERROR_BY_NAME.get(name) ?? null;
}
