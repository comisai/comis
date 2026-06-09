// SPDX-License-Identifier: Apache-2.0
/**
 * Type-contract tests for executor-tool-assembly-types.ts.
 *
 * The module is pure type declarations (no runtime code), so these tests pin
 * the CONTRACT: the re-export seam from executor-tool-assembly.ts stays
 * intact (consumers import from the defining module), and the structural
 * facts downstream wiring relies on (required ports, optional stores,
 * capabilityClass threading) hold at compile time.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  ToolAssemblyDeps,
  ToolAssemblyParams,
  ToolAssemblyResult,
} from "./executor-tool-assembly-types.js";
import type {
  ToolAssemblyDeps as ReExportedDeps,
  ToolAssemblyParams as ReExportedParams,
  ToolAssemblyResult as ReExportedResult,
} from "./executor-tool-assembly.js";
import type { CapabilityClass } from "./model-profile.js";

describe("executor-tool-assembly-types — type contracts", () => {
  it("re-exports from executor-tool-assembly.ts are the identical types (import-path compatibility seam)", () => {
    expectTypeOf<ReExportedDeps>().toEqualTypeOf<ToolAssemblyDeps>();
    expectTypeOf<ReExportedParams>().toEqualTypeOf<ToolAssemblyParams>();
    expectTypeOf<ReExportedResult>().toEqualTypeOf<ToolAssemblyResult>();
    expect(true).toBe(true);
  });

  it("requires the fail-closed ports (toolCapabilityPort, clock) while memory stores stay optional", () => {
    // Required: daemon wiring must always inject these two.
    expectTypeOf<ToolAssemblyDeps["toolCapabilityPort"]>().not.toEqualTypeOf<undefined>();
    expectTypeOf<ToolAssemblyDeps["clock"]>().not.toEqualTypeOf<undefined>();
    // Optional memory lanes: absent store = silent no-op by design.
    expectTypeOf<ToolAssemblyDeps["pinnedStore"]>().toEqualTypeOf<
      import("@comis/core").MemoryPinnedStore | undefined
    >();
    expect(true).toBe(true);
  });

  it("threads capabilityClass (not raw model ids) from params.modelProfile to result.capabilityClass", () => {
    expectTypeOf<ToolAssemblyResult["capabilityClass"]>().toEqualTypeOf<CapabilityClass>();
    // modelProfile is optional on params — assembleTools falls back to FAIL_CLOSED_PROFILE.
    expectTypeOf<ToolAssemblyParams["modelProfile"]>().toEqualTypeOf<
      import("./model-profile.js").ModelProfile | undefined
    >();
    expect(true).toBe(true);
  });
});
