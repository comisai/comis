// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 — the zod-validated `UserStory` schema + journey types.
 *
 * The schema IS the platform's living, machine-checked acceptance spec: a story
 * is DATA, validated at registration (registry.ts), interpreted by ONE generic
 * runner (journey-runner.ts) through a shared step vocabulary (steps.ts). Adding
 * a journey = one declarative spec file + one import line — zero harness change
 * (open/closed).
 *
 * The `UserStory` interface:
 *   { id, story, tags: CategoryTag[], dimensions: ConfigDimValue[],
 *     requires: { providers?, capabilities?, platform?, channelAccounts?, components?, seed? },
 *     profile?, costTier, determinism: { runs, passRateThreshold, models? },
 *     steps: JourneyStep[], acceptance: AcceptanceSpec, status }
 *
 * `CategoryTag` = the component-catalog rows A..V (the subsystems a journey
 * composes → feeds the story-coverage view). `components` (in requires) is the
 * Stage-C-cert gate (e.g. "MEM-StageC"): a journey's real-LLM execution is gated
 * behind the relevant component certs — unmet ⇒ skip-with-reason.
 *
 * @module
 */
import { z } from "zod";
import type { BillingSnapshot } from "../assert/observe.js";
import type { Capability } from "../credentials.js";

// ---------------------------------------------------------------------------
// CategoryTag — the component-catalog rows A..V.
// A journey tags the subsystems it composes; tags feed storyCoverageContributions().
// ---------------------------------------------------------------------------

export const CategoryTagSchema = z.enum([
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K",
  "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V",
]);
export type CategoryTag = z.infer<typeof CategoryTagSchema>;

// ---------------------------------------------------------------------------
// ConfigDimValue — a config mode-value string a journey exercises
// (e.g. "security.storage=encrypted"). The coverage dimensions themselves are owned
// + settled by the depth suites; a journey just NAMES which it touches,
// so this stays a free string (no enum coupling to the matrix).
// ---------------------------------------------------------------------------

export const ConfigDimValueSchema = z.string();
export type ConfigDimValue = z.infer<typeof ConfigDimValueSchema>;

// ---------------------------------------------------------------------------
// Capability — re-stated as a zod enum matching the rig `Capability` union
// (test/live/credentials.ts). types.test.ts asserts the two cannot drift.
// ---------------------------------------------------------------------------

export const CapabilitySchema = z.enum([
  "vision",
  "tools",
  "structured-output",
  "thinking",
]);
// Compile-time coherence guard: the schema's inferred type must be assignable
// to/from the rig Capability union. If credentials.ts adds a capability, this
// line (and the schema) must be updated together.
type _CapabilityCoherence = Capability extends z.infer<typeof CapabilitySchema>
  ? z.infer<typeof CapabilitySchema> extends Capability
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _capabilityCoherenceCheck: _CapabilityCoherence = true;

// ---------------------------------------------------------------------------
// JourneyStep — the shared, channel-agnostic step vocabulary.
// A discriminated union over `verb` so an unknown verb rejects at parse and the
// interpreter switch is exhaustive (steps.ts uses a `never` default).
// ---------------------------------------------------------------------------

export const JOURNEY_VERBS = [
  "send_text",
  "send_voice",
  "send_image",
  "upload_doc",
  "new_session",
  "wait_reply",
  "expect_event",
  "expect_delivered",
  "expect_memory_recalled",
  "expect_file",
  "expect_image",
  "judge",
] as const;

export const JourneyStepSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("send_text"), text: z.string() }),
  z.object({
    verb: z.literal("send_voice"),
    audioBase64: z.string(),
    mimeType: z.string().optional(),
  }),
  z.object({
    verb: z.literal("send_image"),
    imageBase64: z.string(),
    mimeType: z.string().optional(),
  }),
  z.object({
    verb: z.literal("upload_doc"),
    docBase64: z.string(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
  }),
  z.object({ verb: z.literal("new_session") }),
  z.object({ verb: z.literal("wait_reply"), containsAny: z.array(z.string()).optional() }),
  z.object({
    verb: z.literal("expect_event"),
    name: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ verb: z.literal("expect_delivered"), containsAny: z.array(z.string()).optional() }),
  z.object({
    verb: z.literal("expect_memory_recalled"),
    query: z.string(),
    mustRecall: z.array(z.string()).optional(),
  }),
  z.object({ verb: z.literal("expect_file"), path: z.string().optional() }),
  z.object({ verb: z.literal("expect_image") }),
  z.object({ verb: z.literal("judge"), rubric: z.string(), question: z.string().optional() }),
]);
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

// ---------------------------------------------------------------------------
// Requires — gating → skip-with-reason, never fail.
// ---------------------------------------------------------------------------

export const RequiresSchema = z.object({
  /** Provider keys the journey's real-LLM execution needs (e.g. "anthropic"). */
  providers: z.array(z.string()).optional(),
  /** Per-model capabilities the journey needs (vision/tools/structured-output/thinking). */
  capabilities: z.array(CapabilitySchema).optional(),
  /** OS gate — "linux" (e.g. J7 terminal+bwrap), "macos", or "any". */
  platform: z.enum(["linux", "macos", "any"]).optional(),
  /** Real channel accounts the journey binds (else it runs on echo). */
  channelAccounts: z.array(z.string()).optional(),
  /** Component Stage-C certs the journey is gated behind (e.g. "MEM-StageC"). */
  components: z.array(z.string()).optional(),
  /** Pre-store a memory / workspace file (a Stage-D seed spec; shape left open). */
  seed: z.unknown().optional(),
});
export type Requires = z.infer<typeof RequiresSchema>;

// ---------------------------------------------------------------------------
// Determinism — N-run pass-rate + (scenario×model) grid.
// `runs`/`passRateThreshold` feed test/live/stats.ts computePassRate at Stage-D.
// ---------------------------------------------------------------------------

export const DeterminismSchema = z.object({
  runs: z.number().int().positive(),
  passRateThreshold: z.number().min(0).max(1),
  models: z.array(z.string()).optional(),
});
export type Determinism = z.infer<typeof DeterminismSchema>;

// ---------------------------------------------------------------------------
// AcceptanceSpec — the "Then": outcome/world-state assertions + judge rubric.
// expectStitchedTraceId / minBillingTokens drive the Stage-D obs-as-oracle
// assertions (E2E-05: one stitched traceId + journey-level obs.billing).
// ---------------------------------------------------------------------------

export const AcceptanceSpecSchema = z.object({
  /** Human-readable world-state outcomes the journey must achieve. */
  outcomes: z.array(z.string()),
  /** The judge rubric (yes/no criteria) for task-success at Stage-D. */
  rubric: z.string(),
  /** When true, Stage-D asserts one traceId stitches the whole journey. */
  expectStitchedTraceId: z.boolean().optional(),
  /** When set, Stage-D asserts journey-level obs.billing totalTokens >= this. */
  minBillingTokens: z.number().optional(),
});
export type AcceptanceSpec = z.infer<typeof AcceptanceSpecSchema>;

// ---------------------------------------------------------------------------
// UserStory — the declarative spec.
// ---------------------------------------------------------------------------

export const UserStorySchema = z.object({
  /** Stable id, e.g. "US-RESEARCH-RECALL". */
  id: z.string().min(1),
  /** "As a <role>, I want <goal>, so that <benefit>". */
  story: z.string().min(1),
  /** Subsystems composed (Cat A–V) → feeds the story-coverage view. */
  tags: z.array(CategoryTagSchema).nonempty(),
  /** Config mode-values exercised → named (the matrix cells are owned by the depth suites). */
  dimensions: z.array(ConfigDimValueSchema),
  /** Gating → skip-with-reason, never fail. */
  requires: RequiresSchema,
  /** Which config profile to boot under (optional). */
  profile: z.string().optional(),
  costTier: z.enum(["$0", "¢", "$", "$$"]),
  determinism: DeterminismSchema,
  /** Multi-turn / multi-session interaction script. */
  steps: z.array(JourneyStepSchema).nonempty(),
  acceptance: AcceptanceSpecSchema,
  /** Flake hygiene: active runs + blocks; quarantined is measured-non-blocking; deprecated excluded. */
  status: z.enum(["active", "quarantined", "deprecated"]),
});
export type UserStory = z.infer<typeof UserStorySchema>;

// ---------------------------------------------------------------------------
// JourneyResult — the runner's per-story output (NOT zod; a plain TS type).
// ---------------------------------------------------------------------------

export interface JourneyResult {
  storyId: string;
  status: "passed" | "skipped" | "failed";
  /** Skip/failure reason (skip ≠ fail; never a secret). */
  reason?: string;
  /** When quarantined, the caller treats a failure as measured-non-blocking. */
  quarantined?: boolean;
  /** One stitched traceId across the journey (Stage-D). */
  traceId?: string;
  /** Journey-level obs.billing (Stage-D). */
  billing?: BillingSnapshot;
  /** Per-model (scenario×model) grid cell results (Stage-D). */
  perModel?: Record<string, { passRate: number; passed: boolean }>;
  /** Per-step outcomes for diagnosability. */
  steps?: Array<{ verb: string; status: "ok" | "skipped" | "failed"; note?: string }>;
}
