import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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

  it("routes UUID graph identifiers when terminal graph metadata exists", () => {
    expect(paramsForExplainRef(
      "5ea53a58-f0fc-4683-b6e6-53b1d828e602",
      "full",
      true,
    )).toEqual({
      graphId: "5ea53a58-f0fc-4683-b6e6-53b1d828e602",
      depth: "full",
    });
  });

  it("routes root-prefixed identifiers before checking for colons", () => {
    expect(paramsForExplainRef("root-session-default:user:telegram", "full")).toEqual({
      rootRunId: "root-session-default:user:telegram",
      depth: "full",
    });
  });

  it("prints the routed parameters when invoked as a command", () => {
    const script = resolve("test/live/self-driving/scripts/explain-ref.mjs");
    const stdout = execFileSync(process.execPath, [script, "default:user:telegram:peer", "full"], {
      encoding: "utf8",
    });

    expect(JSON.parse(stdout)).toEqual({
      sessionKey: "default:user:telegram:peer",
      depth: "full",
    });
  });
});
