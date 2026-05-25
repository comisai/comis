// SPDX-License-Identifier: Apache-2.0
/**
 * Plaintext-secret heuristic negative + positive control.
 *
 * Table-driven invariant: representative NON-SECRET strings (Notion DB
 * UUIDs, Linear team IDs, Stripe customer IDs, OpenAI org IDs, file
 * paths, env-ref placeholders) PASS without false-positive. Representative
 * real-token shapes (ghp_, sk-, sk-ant-, xoxb-, xoxp-, AKIA, secret_,
 * ntn_, glpat-, sk_live_, sk_test_, github_pat_) REJECT.
 *
 * Heuristic:
 *   matchesPrefix(value, PLAINTEXT_SECRET_PREFIXES)
 *     OR (shannonEntropy(value) > 3.5 AND value.length >= 44).
 * Length-floor 44 (NOT 40) eliminates the OpenAI 40-char org-ID FP
 * without losing real-token rejection (all real tokens are ≥ 41 chars).
 *
 * The test value-imports the compiled `looksLikePlaintextSecret` from
 * `@comis/daemon` via the architecture vitest alias map
 * (test/architecture/vitest.config.ts).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { looksLikePlaintextSecret } from "@comis/daemon";

const NEGATIVE_CASES: ReadonlyArray<{ label: string; sample: string }> = [
  // Notion DB UUIDs — 36 chars hex with dashes, no prefix, entropy ~3.99
  { label: "Notion DB UUID dashed",            sample: "8f3b2c1a-9d4e-7f60-b5e2-c8d1a4f7b9c3" },
  // Linear team UUID — similar shape
  { label: "Linear team UUID",                 sample: "abcdef12-3456-7890-abcd-ef1234567890" },
  // Stripe customer ID — short, no prefix matches (`cus_` is NOT in
  // PLAINTEXT_SECRET_PREFIXES; only `sk_live_`/`sk_test_` are)
  { label: "Stripe cus_ ID short",             sample: "cus_NffrFeUfNV2Hib" },
  // OpenAI org ID — `org-` prefix is NOT in the secret prefix list; 28 chars
  { label: "OpenAI org ID 28-char",            sample: "org-ScmHEqZDkG8eYLJBVxpOTEh1" },
  // PATH-like value — 44 chars but entropy ~3.31 (below entropy floor)
  { label: "Filesystem PATH value",            sample: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
  // Unresolved env-ref placeholder — not a secret (handled separately by
  // findUnresolvedEnvRefs at the same RPC handler boundary)
  { label: "Unresolved env-ref placeholder",   sample: "${GITHUB_TOKEN}" },
  // Short random string — under length floor (no prefix match)
  { label: "Short random under length floor",  sample: "aB3xK9zL2pQ7m" },
  // 32-char hex (database ID style) — at 32 chars, under 44 floor
  { label: "32-char hex database ID",          sample: "a1b2c3d4e5f6789012345678901234ab" },
  // Notion DB ID undashed (32 hex)
  { label: "Notion DB ID undashed 32-hex",     sample: "8f3b2c1a9d4e7f60b5e2c8d1a4f7b9c3" },
  // -----------------------------------------------------------------------
  // Regressions — common operator-config values that the entropy
  // backstop must NOT reject. Each value is a realistic non-secret an
  // operator might place in `integrations.mcp.servers[*].env`. The
  // pre-fix heuristic (length >= 44 AND entropy > 3.5) rejected all of
  // these.
  // -----------------------------------------------------------------------
  { label: "PostgreSQL connection string",     sample: "postgres://user:password@localhost:5432/database_production" },
  { label: "MongoDB SRV connection string",    sample: "mongodb+srv://cluster0.abcdef.mongodb.net/test?retryWrites=true&w=majority" },
  { label: "S3 bucket URL",                    sample: "https://my-bucket.s3.us-east-1.amazonaws.com/path/to/file.json" },
  { label: "Long filesystem path",             sample: "/home/runner/.cache/some-tool/wheels/long/path/with/some.whl" },
  { label: "Comma-separated region list",      sample: "us-east-1,us-east-2,us-west-1,us-west-2,eu-central-1,ap-southeast-1" },
  { label: "Plain API base URL 44 char",       sample: "http://api.example.com/v1/services/something" },
  { label: "Sentence-like operator config",    sample: "this is a 50 character meaningful test sentence ok" },
  { label: "Webhook endpoint URL",             sample: "https://hooks.slack.com/services/T01XX/B02YY/AbCdEf12345" },
  { label: "Redis connection URI",             sample: "redis://default:abcde@redis-12345.c267.us-east-1-4.ec2.cloud.redislabs.com:12345" },
];

const POSITIVE_CASES: ReadonlyArray<{ label: string; sample: string }> = [
  // GitHub personal access token (40+ chars, prefix match)
  { label: "GitHub ghp_ token",                sample: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  // GitHub fine-grained PAT (long; prefix match)
  { label: "GitHub github_pat_ token",         sample: "github_pat_11AAAAAAA0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
  // OpenAI sk- token (45 chars, prefix + entropy)
  { label: "OpenAI sk- token",                 sample: "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
  // Anthropic sk-ant- (prefix match — handled BEFORE sk- in the prefix list)
  { label: "Anthropic sk-ant- token",          sample: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  // Slack bot token (xoxb- prefix)
  { label: "Slack xoxb- bot token",            sample: "xoxb-abcdef1234567890abcdef1234567890abcdef" },
  // Slack user token (xoxp- prefix)
  { label: "Slack xoxp- user token",           sample: "xoxp-abcdef1234567890abcdef1234567890abcdef" },
  // AWS access key (AKIA prefix; 20 chars but prefix triggers regardless)
  { label: "AWS AKIA access key",              sample: "AKIAIOSFODNN7EXAMPLE" },
  // Notion legacy internal (secret_ prefix)
  { label: "Notion secret_ legacy",            sample: "secret_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ" },
  // Notion v2 (ntn_ prefix)
  { label: "Notion ntn_ v2 token",             sample: "ntn_v2_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
  // GitLab PAT (glpat- prefix)
  { label: "GitLab glpat- token",              sample: "glpat-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345" },
  // Stripe live secret (sk_live_ prefix)
  { label: "Stripe sk_live_ secret",           sample: "sk_live_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  // Stripe test secret (sk_test_ prefix)
  { label: "Stripe sk_test_ secret",           sample: "sk_test_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
];

describe("plaintext-secret heuristic — false-positive negative control", () => {
  for (const { label, sample } of NEGATIVE_CASES) {
    it(`${label} (${sample.length} chars) passes the plaintext-secret heuristic without false-positive`, () => {
      expect(looksLikePlaintextSecret(sample)).toBe(false);
    });
  }
});

describe("plaintext-secret heuristic — positive-control real-token shapes", () => {
  for (const { label, sample } of POSITIVE_CASES) {
    it(`${label} (${sample.length} chars) is rejected by the plaintext-secret heuristic`, () => {
      expect(looksLikePlaintextSecret(sample)).toBe(true);
    });
  }
});
