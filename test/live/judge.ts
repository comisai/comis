// SPDX-License-Identifier: Apache-2.0
/**
 * Judge wrapper — thin abstraction over the bench-memory QA judge for Phase-139 MEM Stage-C.
 *
 * Reads COMIS_LIVE_JUDGE_PROVIDER, COMIS_LIVE_JUDGE_MODEL, COMIS_LIVE_JUDGE_API_KEY
 * from env (mirroring bench-memory.sh require_answer_judge_env guard).
 * Returns {verdict:"skip"} when env is absent — never throws on missing env.
 * Cross-judge ≥2 required for any published readiness claim (§7.5 discipline).
 *
 * sweepSecrets: replicates bench-memory.sh sweep_dir in TypeScript.
 * Scans all files under dirPath for credential shapes:
 *   sk-[A-Za-z0-9_-]{16,} | Bearer [A-Za-z0-9._-]+ | \bapiKey\b
 * Throws on any match (belt-and-suspenders over in-test omission gates).
 *
 * T-139-01-01: sweep throws with path only — matched content is NEVER included
 * in the error message (Information Disclosure mitigation).
 * T-139-01-02: COMIS_LIVE_JUDGE_API_KEY is read once and never returned or logged.
 *
 * @module
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { computePassRate } from "./stats.js";
import type { PassRateTier } from "./stats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verdict returned by judgeAnswer. */
export interface JudgeResult {
  verdict: "pass" | "fail" | "skip";
  /** Human-readable explanation (never includes secret values). */
  reason: string;
  /** Identifier for the judge model/config used, or "none" on skip. */
  judgeId: string;
}

/** Input to the judge. */
export interface JudgeInput {
  question: string;
  context: string;
  answer: string;
  rubric: string;
}

// ---------------------------------------------------------------------------
// Secret pattern (mirrors bench-memory.sh sweep_dir line 123)
// \bapiKey\b — word-boundary so "apiToken" / "apiKeyValue" do NOT match
// ---------------------------------------------------------------------------
const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+|\bapiKey\b/;

// ---------------------------------------------------------------------------
// judgeAnswer
// ---------------------------------------------------------------------------

/**
 * Evaluate an answer against a rubric using the configured judge model.
 *
 * Gate: returns {verdict:"skip", reason:"no-creds", judgeId:"none"} when
 * COMIS_LIVE_JUDGE_PROVIDER or COMIS_LIVE_JUDGE_API_KEY is absent from env.
 * Never throws on missing credentials — skip ≠ fail.
 *
 * Stage-C wiring note: when env is present, a real cross-judge invocation must
 * be wired (cross-judge ≥2 for any published readiness claim per §7.5).
 * Until Stage-C is wired, returns a skip with reason "pending".
 *
 * T-139-01-02: API key is checked for presence only; its value is never
 * included in the returned JudgeResult or emitted to any log.
 */
export async function judgeAnswer(_input: JudgeInput): Promise<JudgeResult> {
  const provider = process.env["COMIS_LIVE_JUDGE_PROVIDER"];
  const apiKey = process.env["COMIS_LIVE_JUDGE_API_KEY"];

  if (!provider || !apiKey) {
    return {
      verdict: "skip",
      reason: "no-creds: COMIS_LIVE_JUDGE_PROVIDER or COMIS_LIVE_JUDGE_API_KEY unset",
      judgeId: "none",
    };
  }

  // Stage-C live path: invoke real judge model (cross-judge ≥2 per §7.5).
  // TODO(Stage-C): wire the qa-judge-harness function using provider + model.
  const model = process.env["COMIS_LIVE_JUDGE_MODEL"] ?? "unknown";
  return {
    verdict: "skip",
    reason: `Stage-C judge not yet wired (provider=${provider}, model=${model}) — set COMIS_LIVE=1 and complete Stage-C wiring`,
    judgeId: "pending",
  };
}

// ---------------------------------------------------------------------------
// sweepSecrets
// ---------------------------------------------------------------------------

/**
 * Scan all files under dirPath for credential shapes.
 *
 * Credential patterns (mirrors bench-memory.sh sweep_dir):
 *   sk-[A-Za-z0-9_-]{16,}   — Anthropic/OpenAI-style API keys
 *   Bearer [A-Za-z0-9._-]+  — HTTP Bearer tokens
 *   \bapiKey\b               — literal "apiKey" word (NOT "apiToken", "apiKeyValue")
 *
 * T-139-01-01: Throws with the FILE PATH only — matched content is never
 * included in the error message (Information Disclosure mitigation).
 *
 * No-op when dirPath does not exist (mirrors bench-memory.sh guard).
 *
 * @param dirPath - Directory to scan recursively.
 * @throws Error with "SECRET LEAK" in the message when any credential shape found.
 */
export function sweepSecrets(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  _sweepDir(dirPath);
}

function _sweepDir(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      _sweepDir(full);
      continue;
    }
    const text = readFileSync(full, "utf-8");
    if (SECRET_PATTERN.test(text)) {
      // T-139-01-01: include path only — never the matched content
      throw new Error(`SECRET LEAK detected in ${full} — failing the run.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Re-exports from stats.ts (convenience for callers importing from judge.ts)
// ---------------------------------------------------------------------------
export { computePassRate };
export type { PassRateTier };
