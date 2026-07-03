// SPDX-License-Identifier: Apache-2.0
// @allow-throw: test fixture loader; the thrown "missing fixture" error is the
// RED signal for an un-pinned scenario and is caught by Vitest at the call site.
/**
 * Golden-fixture read helper (read-from-disk + `toEqual`).
 *
 * The single shared piece every channel renderer test reuses (rule-of-three):
 * `readFixture(channel, scenario)` reads
 * `__tests__/__fixtures__/<channel>/<scenario>.expected.json` from disk and
 * returns the parsed object, so tests assert `expect(actual).toEqual(readFixture(...))`.
 *
 * `toEqual` against a read-from-disk object is the deliberate alternative to
 * `toMatchSnapshot` / `toMatchFileSnapshot`, which auto-write and self-heal a
 * wrong fixture. A missing fixture THROWS — that is the RED signal
 * for a scenario the author has not yet pinned; the `check-fixture-diff.sh` CI
 * gate then guards undeclared fixture mutations.
 *
 * Path resolution goes through `safePath` (no `path.join` — AGENTS.md §2.2),
 * with the base directory derived from this file's own location via
 * `import.meta.url` (the `__fixtures__/` dir is a sibling of this file). There
 * is no dynamic/user-controlled path segment at runtime — the inputs are
 * literal channel/scenario names from the test files.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { safePath } from "@comis/core";

/** Absolute directory of this harness file (sibling of `__fixtures__/`). */
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Read and parse the golden fixture for a `(channel, scenario)` pair.
 *
 * @param channel - Channel directory under `__fixtures__/` (e.g. `"echo"`).
 * @param scenario - Scenario id (e.g. `"S2"`); resolves `<scenario>.expected.json`.
 * @returns The parsed fixture object (assert against it with `toEqual`).
 * @throws When the fixture file does not exist — pin it.
 */
export function readFixture(channel: string, scenario: string): unknown {
  const fixturePath = safePath(HARNESS_DIR, "__fixtures__", channel, `${scenario}.expected.json`);
  let raw: string;
  try {
    raw = readFileSync(fixturePath, "utf8");
  } catch {
    throw new Error(
      `Missing golden fixture: ${channel}/${scenario}.expected.json — pin it`,
    );
  }
  return JSON.parse(raw);
}
