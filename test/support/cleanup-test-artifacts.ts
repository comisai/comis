/**
 * Standalone cleanup script for Comis test artifacts.
 *
 * Usage: npx tsx test/support/cleanup-test-artifacts.ts
 *    or: pnpm test:cleanup
 *
 * Reuses the same cleanup logic from global-setup.ts teardown.
 * Use this when tests crash without running teardown, or to manually
 * clean up artifacts between development sessions.
 *
 * @module
 */

import { teardown } from "./global-setup.js";

console.log("Cleaning up Comis test artifacts...");
teardown();
console.log("Done.");
