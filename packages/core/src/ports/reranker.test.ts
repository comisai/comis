// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { ok, type Result } from "@comis/shared";
// Side-effecting (value) import of the module so the RED state is reproducible
// from this test commit alone: vitest must RESOLVE `./reranker.js` at runtime,
// which throws "Cannot find module" against pre-patch source (a bare
// `import type` would be stripped by the transform and never resolve, hiding
// RED). `reranker.ts` is a type-only module so this resolves to an empty
// namespace at runtime — the type is pulled via the `import type` below.
import "./reranker.js";
import type { RerankerPort } from "./reranker.js";

describe("RerankerPort interface contract", () => {
  it("accepts a structurally-valid reranker implementation and exercises it", async () => {
    const stub: RerankerPort = {
      rank: async (_q: string, docs: string[]): Promise<Result<number[], Error>> =>
        ok(docs.map(() => 0.5)),
      isAvailable: () => true,
    };

    expect(stub.isAvailable()).toBe(true);

    const scored = await stub.rank("query", ["a", "b", "c"]);
    expect(scored.ok).toBe(true);
    if (scored.ok) {
      // Scores returned in INPUT ORDER (documents[i] -> scores[i]).
      expect(scored.value).toEqual([0.5, 0.5, 0.5]);
    }
  });

  it("types rank() as Promise<Result<number[], Error>> and isAvailable() as boolean", () => {
    const stub: RerankerPort = {
      rank: async (): Promise<Result<number[], Error>> => ok([]),
      isAvailable: () => false,
    };
    expectTypeOf(stub.rank).returns.toEqualTypeOf<Promise<Result<number[], Error>>>();
    expectTypeOf(stub.isAvailable).returns.toEqualTypeOf<boolean>();
  });

  it("permits an optional dispose() returning Promise<void> when present", async () => {
    let disposed = false;
    const stub: RerankerPort = {
      rank: async (): Promise<Result<number[], Error>> => ok([]),
      isAvailable: () => true,
      dispose: async () => {
        disposed = true;
      },
    };
    expectTypeOf(stub.dispose).toEqualTypeOf<(() => Promise<void>) | undefined>();
    await stub.dispose?.();
    expect(disposed).toBe(true);
  });
});
