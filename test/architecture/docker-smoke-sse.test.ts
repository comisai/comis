// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(here, "../../scripts/test-docker-smoke.sh"), "utf8");
const streamingSection = script.slice(
  script.indexOf('hdr "6. SSE streaming: /api/chat/stream"'),
  script.indexOf('hdr "7. Session memory persistence'),
);

describe("Docker smoke streaming request contract", () => {
  it("sends the chat prompt in a POST JSON body instead of the URL", () => {
    expect(streamingSection).toContain('-X POST "$GW/api/chat/stream"');
    expect(streamingSection).toContain('-H "Content-Type: application/json"');
    expect(streamingSection).toContain("--data");
    expect(streamingSection).not.toContain(" -G ");
    expect(streamingSection).not.toContain("--data-urlencode");
  });
});
