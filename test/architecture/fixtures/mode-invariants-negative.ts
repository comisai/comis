// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: NEGATIVE — observability-mode-invariants rule MUST classify
 * every site below as clean. Walker assertion: 0 violations.
 *
 * Each CLEAN case pins one boundary of classifier correctness:
 *   - literal 0o700 / 0o600 mode args ARE accepted
 *   - JSDoc / line-comment / string-literal mentions are NOT calls
 *   - inline `// fs-safe-allowed:` opt-out comment suppresses the next call
 */

import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";

// CLEAN 1: fs.mkdirSync with literal 0o700 mode
fs.mkdirSync("/tmp/test1", { recursive: true, mode: 0o700 });

// CLEAN 2: fs.writeFileSync with literal 0o600 mode
fs.writeFileSync("/tmp/file1", "content", { mode: 0o600 });

// CLEAN 3: fs.promises.mkdir with literal 0o700 mode
void fs.promises.mkdir("/tmp/test2", { recursive: true, mode: 0o700 });

// CLEAN 4: fs.promises.writeFile with literal 0o600 mode
void fs.promises.writeFile("/tmp/file2", "content", { mode: 0o600 });

// CLEAN 5: bare-import mkdirSync with literal mode
mkdirSync("/tmp/test3", { recursive: true, mode: 0o700 });

// CLEAN 6: bare-import writeFileSync with literal mode
writeFileSync("/tmp/file3", "content", { mode: 0o600 });

// CLEAN 7: JSDoc mentioning mkdirSync (comment, not a call)
/** This function uses mkdirSync internally. */
function dummy() {}

// CLEAN 8: line comment mentioning writeFileSync
// Replaced writeFileSync with writeRegularFile.
function dummy2() {}

// CLEAN 9: string literal containing forbidden text
const message = "mkdirSync is forbidden in production code";

// CLEAN 10: inline opt-out comment opts the next call out of the rule
// fs-safe-allowed: legitimate ephemeral test-fixture state outside ~/.comis/
fs.mkdirSync("/tmp/test4", { recursive: true });

// CLEAN 11: object-property `mkdirSync` lookalike (not the fs call)
const stub = { mkdirSync: (p: string) => p };
stub.mkdirSync("/tmp/never");

// CLEAN 12: identifier reference (not a call)
const fn = fs.mkdirSync;
void fn;

// Mark variables as used so @ts-nocheck doesn't trip in stricter futures.
void dummy;
void dummy2;
void message;
