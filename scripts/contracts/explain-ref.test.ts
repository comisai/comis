import { describe, expect, it } from "vitest";
import { paramsForExplainRef } from "../../test/live/self-driving/scripts/explain-ref.mjs";

describe("explain helper reference routing", () => {
  it("routes colon-bearing session keys to the session parameter", () => {
    expect(paramsForExplainRef("default:user:telegram:peer", "full")).toEqual({
      sessionKey: "default:user:telegram:peer",
      depth: "full",
    });
  });

  it("routes UUID trace identifiers to the trace parameter", () => {
    expect(paramsForExplainRef("c72b41c9-7c9b-4fc6-af54-6a5c4364e26f", "summary")).toEqual({
      traceId: "c72b41c9-7c9b-4fc6-af54-6a5c4364e26f",
      depth: "summary",
    });
  });

  it("routes root-prefixed identifiers before checking for colons", () => {
    expect(paramsForExplainRef("root-session-default:user:telegram", "full")).toEqual({
      rootRunId: "root-session-default:user:telegram",
      depth: "full",
    });
  });
});
