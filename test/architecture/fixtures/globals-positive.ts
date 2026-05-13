// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: POSITIVE — globals rule should flag every callable below.
 *
 * Walker assertion: ≥ 7 violations (one per pattern).
 */

// VIOLATION: Date.now() direct call
const ts1 = Date.now();

// VIOLATION: new Date() constructor call
const d1 = new Date();

// VIOLATION: new Date with arg
const d2 = new Date(0);

// VIOLATION: process.env element access (read)
const v1 = process.env.NODE_ENV;

// VIOLATION: process.env element access (computed key)
const v2 = process.env["HOME"];

// VIOLATION: setTimeout direct call
const h1 = setTimeout(() => {}, 100);

// VIOLATION: setInterval direct call
const h2 = setInterval(() => {}, 100);

// VIOLATION: clearTimeout direct call
clearTimeout(h1);

// VIOLATION: clearInterval direct call
clearInterval(h2);

// VIOLATION: Date.now inside template-literal substitution
const filename = `export-${Date.now()}.jsonl`;

// VIOLATION: process.env mutation (write — also flagged per researcher note)
process.env.MY_VAR = "x";
