// SPDX-License-Identifier: Apache-2.0
/**
 * Secret-value heuristic negative + positive control.
 *
 * Table-driven invariant: representative NON-SECRET strings (Notion/Linear
 * UUIDs, Stripe customer IDs, OpenAI org IDs, file paths, env-ref
 * placeholders, connection strings, URLs, comma-lists, sentence config)
 * are NOT flagged. Representative real-token shapes (ghp_, sk-, sk-ant-,
 * xoxb-, xoxp-, AKIA, secret_, ntn_, glpat-, sk_live_, sk_test_,
 * github_pat_) ARE flagged.
 *
 * Heuristic:
 *   (strip surrounding quotes + leading Bearer/Basic/Token/Digest scheme), then
 *   matchesPrefix(remainder, PLAINTEXT_SECRET_PREFIXES)
 *     OR (shannonEntropy(remainder) > 3.5 AND remainder.length >= 44 AND no delimiter chars).
 * Length-floor 44 (NOT 40) eliminates the OpenAI 40-char org-ID FP without
 * losing real-token rejection (all real tokens are >= 41 chars).
 *
 * The test value-imports `looksLikeSecretValue` from the colocated keystone
 * module — it runs as a core unit test, NOT an architecture-tier test.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { looksLikeSecretValue } from "./secret-detection.js";

const NEGATIVE_CASES: ReadonlyArray<{ label: string; sample: string }> = [
  { label: "Notion DB UUID dashed", sample: "8f3b2c1a-9d4e-7f60-b5e2-c8d1a4f7b9c3" },
  { label: "Linear team UUID", sample: "abcdef12-3456-7890-abcd-ef1234567890" },
  { label: "Stripe cus_ ID short", sample: "cus_NffrFeUfNV2Hib" },
  { label: "OpenAI org ID 28-char", sample: "org-ScmHEqZDkG8eYLJBVxpOTEh1" },
  { label: "Filesystem PATH value", sample: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
  { label: "Unresolved env-ref placeholder", sample: "${GITHUB_TOKEN}" },
  { label: "Short random under length floor", sample: "aB3xK9zL2pQ7m" },
  { label: "32-char hex database ID", sample: "a1b2c3d4e5f6789012345678901234ab" },
  { label: "Notion DB ID undashed 32-hex", sample: "8f3b2c1a9d4e7f60b5e2c8d1a4f7b9c3" },
  { label: "PostgreSQL connection string", sample: "postgres://user:password@localhost:5432/database_production" },
  { label: "MongoDB SRV connection string", sample: "mongodb+srv://cluster0.abcdef.mongodb.net/test?retryWrites=true&w=majority" },
  { label: "S3 bucket URL", sample: "https://my-bucket.s3.us-east-1.amazonaws.com/path/to/file.json" },
  { label: "Long filesystem path", sample: "/home/runner/.cache/some-tool/wheels/long/path/with/some.whl" },
  { label: "Comma-separated region list", sample: "us-east-1,us-east-2,us-west-1,us-west-2,eu-central-1,ap-southeast-1" },
  { label: "Plain API base URL 44 char", sample: "http://api.example.com/v1/services/something" },
  { label: "Sentence-like operator config", sample: "this is a 50 character meaningful test sentence ok" },
  { label: "Webhook endpoint URL", sample: "https://hooks.slack.com/services/T01XX/B02YY/AbCdEf12345" },
  { label: "Redis connection URI", sample: "redis://default:abcde@redis-12345.c267.us-east-1-4.ec2.cloud.redislabs.com:12345" },
  // Scheme-strip negative: remainder after stripping "Bearer " is an env-ref placeholder.
  { label: "Bearer-wrapped env-ref placeholder", sample: "Bearer ${GITHUB_TOKEN}" },
];

const POSITIVE_CASES: ReadonlyArray<{ label: string; sample: string }> = [
  { label: "GitHub ghp_ token", sample: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  { label: "GitHub github_pat_ token", sample: "github_pat_11AAAAAAA0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
  { label: "OpenAI sk- token", sample: "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
  { label: "Anthropic sk-ant- token", sample: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  { label: "Slack xoxb- bot token", sample: "xoxb-abcdef1234567890abcdef1234567890abcdef" },
  { label: "Slack xoxp- user token", sample: "xoxp-abcdef1234567890abcdef1234567890abcdef" },
  { label: "AWS AKIA access key", sample: "AKIAIOSFODNN7EXAMPLE" },
  { label: "Notion secret_ legacy", sample: "secret_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ" },
  { label: "Notion ntn_ v2 token", sample: "ntn_v2_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
  { label: "GitLab glpat- token", sample: "glpat-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345" },
  { label: "Stripe sk_live_ secret", sample: "sk_live_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  { label: "Stripe sk_test_ secret", sample: "sk_test_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  // Scheme-strip positives — the load-bearing scheme-strip closure.
  { label: "Bearer hf_ token (scheme-strip)", sample: "Bearer hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEf" },
  { label: "Basic creds (scheme-strip)", sample: "Basic dXNlcjpsb25ncGFzc3dvcmR3aXRoaGlnaGVudHJvcHkxMjM0NTY3OA" },
  { label: "Quoted ghp_ token (quote-strip)", sample: '"ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"' },
];

describe("secret-value heuristic — false-positive negative control", () => {
  for (const { label, sample } of NEGATIVE_CASES) {
    it(`${label} (${sample.length} chars) is NOT flagged`, () => {
      expect(looksLikeSecretValue(sample)).toBe(false);
    });
  }
});

describe("secret-value heuristic — positive-control real-token shapes", () => {
  for (const { label, sample } of POSITIVE_CASES) {
    it(`${label} (${sample.length} chars) IS flagged`, () => {
      expect(looksLikeSecretValue(sample)).toBe(true);
    });
  }
});
