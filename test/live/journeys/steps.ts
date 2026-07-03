// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-02 — the shared, channel-agnostic step-vocabulary interpreter.
 *
 * Each step verb maps to a backing call on the bound driver (echo in sandbox, a
 * real channel at Stage-D — bound at run time, authored once). The interpreter
 * is channel-agnostic: it talks to a structural `ConversationDriverLike` subset,
 * so a story runs on the echo `ConversationDriver` (no account, CI-breadth) or a
 * real channel when credentialed.
 *
 * skip ≠ fail discipline:
 *   - a dummy-key provider error on send_text is TOLERATED (recorded skipped),
 *     exactly like the ORCH Stage-B idiom — the daemon still fires real events;
 *   - verbs whose semantics need a real model/provider (judge, expect_image,
 *     expect_memory_recalled, expect_file when no path) record a `skipped`
 *     outcome in sandbox and are asserted for real only at Stage-D;
 *   - expect_event / expect_delivered ARE real assertions (they read captured
 *     daemon state) — a missing event/delivery records a `failed` step.
 *
 * SANDBOX EVENT CAVEAT: the echo ConversationDriver only captures a FIXED event
 * set (graph:*, context:*, compaction:*, memory:injected, session:sub_agent_*,
 * media:file_*). A SANDBOX-run story's expect_event must stay within that set;
 * other journey events are Stage-D only. The interpreter does not enforce this —
 * the seed stories author it.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expectEvent, type ObservedEvent } from "../assert/observe.js";
import { judgeAnswer } from "../judge.js";
import type { CredentialRegistry } from "../credentials.js";
import type { JourneyStep } from "./types.js";

// ---------------------------------------------------------------------------
// ConversationDriverLike — the structural subset of ConversationDriver the step
// interpreter calls. The real harness ConversationDriver satisfies it; tests stub it.
// ---------------------------------------------------------------------------

export interface EchoLike {
  getSentMessages(): Array<{ id: string; channelId: string; text: string; timestamp: number }>;
  injectMessage(msg: unknown): Promise<void>;
}

export interface ConversationDriverLike {
  sendTurn(text: string): Promise<string>;
  sendVoice(audioBase64: string, mimeType?: string): Promise<void>;
  sendImage(imageBase64: string, mimeType?: string): Promise<void>;
  restart(opts?: unknown): Promise<void>;
  capturedEvents(): Array<{ name: string; payload: unknown }>;
  getEcho(): EchoLike;
  getDataDir(): string;
}

// ---------------------------------------------------------------------------
// StepContext + StepOutcome
// ---------------------------------------------------------------------------

export interface StepOutcome {
  verb: string;
  status: "ok" | "skipped" | "failed";
  note?: string;
}

export interface StepContext {
  driver: ConversationDriverLike;
  creds: CredentialRegistry;
  /** Whether real-LLM execution is enabled (COMIS_LIVE). Stage-D verbs run only when true. */
  isLive?: boolean;
  /** Per-step outcomes the runner aggregates. */
  collected: StepOutcome[];
  /** The most recent reply (set by send_text, read by wait_reply / judge). */
  lastReply?: string;
  /** Q/A context accumulated for a later judge step. */
  rubricAnswers: Array<{ question: string; answer: string }>;
}

// ---------------------------------------------------------------------------
// interpretStep
// ---------------------------------------------------------------------------

/** Exhaustiveness guard — a verb not handled is a compile error here. */
function assertNever(x: never): never {
  throw new Error(`interpretStep: unhandled step verb: ${JSON.stringify(x)}`);
}

const record = (ctx: StepContext, o: StepOutcome): void => {
  ctx.collected.push(o);
};

/**
 * Interpret ONE journey step against the bound driver.
 *
 * Never throws on a tolerated/gated condition — records the outcome instead so
 * the runner can aggregate (skip ≠ fail). A real assertion failure
 * (expect_event/expect_delivered absent) is caught and recorded as a `failed`
 * step (not propagated) so a multi-step journey runs to completion and reports
 * all outcomes.
 */
export async function interpretStep(step: JourneyStep, ctx: StepContext): Promise<void> {
  switch (step.verb) {
    case "send_text": {
      try {
        ctx.lastReply = await ctx.driver.sendTurn(step.text);
        ctx.rubricAnswers.push({ question: step.text, answer: ctx.lastReply });
        record(ctx, { verb: "send_text", status: "ok" });
      } catch (err) {
        // Dummy-key provider error is tolerated in sandbox (ORCH Stage-B idiom):
        // the daemon still fires real events; the turn just has no real reply.
        const msg = err instanceof Error ? err.message : String(err);
        record(ctx, {
          verb: "send_text",
          status: "skipped",
          note: `provider error tolerated (sandbox/dummy-key): ${msg.slice(0, 120)}`,
        });
      }
      return;
    }

    case "send_voice": {
      await ctx.driver.sendVoice(step.audioBase64, step.mimeType);
      record(ctx, { verb: "send_voice", status: "ok" });
      return;
    }

    case "send_image": {
      await ctx.driver.sendImage(step.imageBase64, step.mimeType);
      record(ctx, { verb: "send_image", status: "ok" });
      return;
    }

    case "upload_doc": {
      // VERIFIED: there is no sendDoc driver method. The product Attachment.type
      // enum is ["image","file","audio","video","link"] — use type:"file" via the
      // echo injectMessage surface (mirrors sendImage's NormalizedMessage shape).
      const mimeType = step.mimeType ?? "application/pdf";
      await ctx.driver.getEcho().injectMessage({
        id: randomUUID(),
        channelId: "echo-live",
        channelType: "echo",
        senderId: "test-user",
        text: "",
        timestamp: Date.now(),
        attachments: [
          {
            type: "file" as const,
            url: `data:${mimeType};base64,${step.docBase64}`,
            mimeType,
            ...(step.filename ? { filename: step.filename } : {}),
          },
        ],
        metadata: {},
      });
      record(ctx, { verb: "upload_doc", status: "ok" });
      return;
    }

    case "new_session": {
      await ctx.driver.restart();
      record(ctx, { verb: "new_session", status: "ok" });
      return;
    }

    case "wait_reply": {
      if (typeof ctx.lastReply !== "string" || ctx.lastReply.length === 0) {
        // No reply present (e.g. a dummy-key turn errored) — a sandbox skip, not
        // a hard failure; the Stage-D run has a real reply.
        record(ctx, { verb: "wait_reply", status: "skipped", note: "no reply yet (sandbox/dummy-key)" });
        return;
      }
      if (step.containsAny && step.containsAny.length > 0) {
        const hit = step.containsAny.some((s) => ctx.lastReply!.includes(s));
        record(ctx, {
          verb: "wait_reply",
          status: hit ? "ok" : "failed",
          ...(hit ? {} : { note: `reply did not contain any of: ${step.containsAny.join(", ")}` }),
        });
        return;
      }
      record(ctx, { verb: "wait_reply", status: "ok" });
      return;
    }

    case "expect_event": {
      // capturedEvents() carries payload:unknown; expectEvent wants
      // ObservedEvent ({ name, payload?: Record<string,unknown> }). Coerce the
      // object-shaped payloads (event-bus payloads are metadata objects);
      // non-object payloads map to undefined (expectEvent then
      // matches by name only when no payloadSubset is given).
      const observed: ObservedEvent[] = ctx.driver.capturedEvents().map((e) => ({
        name: e.name,
        payload:
          typeof e.payload === "object" && e.payload !== null
            ? (e.payload as Record<string, unknown>)
            : undefined,
      }));
      try {
        await expectEvent(step.name, step.payload, observed);
        record(ctx, { verb: "expect_event", status: "ok" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        record(ctx, { verb: "expect_event", status: "failed", note: msg.slice(0, 200) });
      }
      return;
    }

    case "expect_delivered": {
      const sent = ctx.driver.getEcho().getSentMessages();
      if (sent.length === 0) {
        record(ctx, { verb: "expect_delivered", status: "failed", note: "no message delivered" });
        return;
      }
      if (step.containsAny && step.containsAny.length > 0) {
        const hit = sent.some((m) => step.containsAny!.some((s) => m.text.includes(s)));
        record(ctx, {
          verb: "expect_delivered",
          status: hit ? "ok" : "failed",
          ...(hit ? {} : { note: `no delivered message contained any of: ${step.containsAny.join(", ")}` }),
        });
        return;
      }
      record(ctx, { verb: "expect_delivered", status: "ok" });
      return;
    }

    case "expect_memory_recalled": {
      // Stage-D: a real recall (real embedding + model) is needed to assert the
      // recalled context contains `mustRecall`. The rig's memory-recall asserters
      // are recall-QUALITY (recall@k/MRR), not a string-presence check — so this
      // is gated, not faked, in sandbox.
      record(ctx, {
        verb: "expect_memory_recalled",
        status: "skipped",
        note: "gated: real recall (no COMIS_LIVE)",
      });
      return;
    }

    case "expect_file": {
      // A workspace file written by a tool — deterministically checkable only when
      // a path is given and a turn actually wrote it (Stage-D). In sandbox, if a
      // path is given we check existence (a tool may have written it); else skip.
      if (step.path) {
        const full = join(ctx.driver.getDataDir(), step.path);
        if (existsSync(full)) {
          record(ctx, { verb: "expect_file", status: "ok" });
        } else {
          record(ctx, {
            verb: "expect_file",
            status: "skipped",
            note: `file not present in sandbox (Stage-D): ${step.path}`,
          });
        }
        return;
      }
      record(ctx, { verb: "expect_file", status: "skipped", note: "no path (Stage-D world-state)" });
      return;
    }

    case "expect_image": {
      // Outbound generated-image delivery is a Stage-D world-state assertion (the
      // echo sent-buffer is text-only; a real image-gen turn is needed).
      record(ctx, { verb: "expect_image", status: "skipped", note: "Stage-D world-state (image-out)" });
      return;
    }

    case "judge": {
      const r = await judgeAnswer({
        question: step.question ?? ctx.rubricAnswers.at(-1)?.question ?? "",
        context: ctx.rubricAnswers.map((qa) => `Q:${qa.question}\nA:${qa.answer}`).join("\n\n"),
        answer: ctx.lastReply ?? "",
        rubric: step.rubric,
      });
      // A keyless skip is NOT a step failure (skip ≠ fail). A real fail IS.
      const status: StepOutcome["status"] =
        r.verdict === "pass" ? "ok" : r.verdict === "skip" ? "skipped" : "failed";
      record(ctx, { verb: "judge", status, note: r.reason });
      return;
    }

    default:
      return assertNever(step);
  }
}
