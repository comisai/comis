// SPDX-License-Identifier: Apache-2.0
/**
 * PR description validator runner.
 *
 * Reads PR_BODY from the environment (set by the pr-description-check.yml
 * workflow), checks for required H2 section headings, and exits 1 if any
 * are missing (which fails the workflow step).
 *
 * The `findMissingSections` function below is an INLINE COPY of the
 * canonical implementation in `scripts/contracts/description-parser.ts`.
 * The sparse-checkout in the workflow only checks out `.github/scripts`,
 * so we cannot import from `scripts/contracts/`. Keep both copies in sync.
 *
 * @module
 */

/**
 * Required H2 sections in .github/PULL_REQUEST_TEMPLATE.md.
 * The checker verifies that each heading appears in the PR body.
 * Screenshots and Additional Notes are deliberately absent — optional.
 */
const REQUIRED_SECTIONS = [
  "Description",
  "Related Issue",
  "Type of Change",
  "Checklist",
  "RED Test Proof",
];

// --- inline copy of findMissingSections (sync with scripts/contracts/description-parser.ts) ---
function findMissingSections(body, requiredSections) {
  if (!body || body.trim().length === 0) return [...requiredSections];
  return requiredSections.filter((section) => {
    const pattern = new RegExp(`^##\\s+${escapeRegExp(section)}`, "im");
    return !pattern.test(body);
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// --- end inline copy ---

const body = process.env.PR_BODY ?? "";
const missing = findMissingSections(body, REQUIRED_SECTIONS);

if (missing.length > 0) {
  console.error(`Missing required PR sections: ${missing.join(", ")}`);
  process.exit(1);
}

process.exit(0);
