// SPDX-License-Identifier: Apache-2.0
/**
 * concurrency-oracle.mjs — the PURE attribution + overlap oracle for parallel,
 * steering and burst drives. No I/O, no rig, no daemon: every function takes
 * already-read text and returns a verdict, so the whole thing is unit-testable
 * and its negative controls are provable without a live box.
 *
 * WHY THIS EXISTS. `drive.mjs` is a SEQUENTIAL instrument by design: it holds
 * `/tmp/comis-drive-<conversation>.lock` and refuses to run two drives in one
 * conversation, because a Telegram DM outbound payload carries only
 * `{chat_id, parse_mode, text}` — no correlation field — so two concurrent
 * drivers both accept the first non-progress message and both report it. Firing
 * five `drive.mjs` at one chat therefore SERIALIZES them and reports
 * "no interleaving" as a pass on a test that never ran concurrently. That false
 * pass is the failure mode this module exists to make impossible:
 *
 *   - `burst-inject.mjs` injects without the lock and records each inject's
 *     normalized inbound identity;
 *   - this oracle binds each reply to its own inbound from the session
 *     transcript, and REFUSES to guess when the transcript cannot say which;
 *   - `overlapReport` proves from the trajectory that turns actually overlapped,
 *     so a silently serialized run cannot be scored as a concurrency pass.
 *
 * THE THREE HONEST OUTCOMES per inbound: `answered` (bound, with evidence),
 * `ambiguous` (a substantive reply landed while two or more inbounds were
 * outstanding — the transcript cannot attribute it, so this oracle does not),
 * and `unanswered` (no reply at all — a lost turn). `ambiguous` is not a pass;
 * it is the signal to reach for a stronger key (a group/forum thread id, or a
 * correlated delivery row) or to record a documented finding.
 *
 * @module
 */
import {
  isDriveProgressText,
  normalizeWireText,
  outboundVisibleText,
  transcriptMessageText,
} from "./drive-session-oracle.mjs";

/** Longest reply prose echoed into a verdict, so a report stays reviewable. */
const REPLY_PREVIEW_CHARS = 160;

/** Parse a JSONL blob, skipping blank and mid-write-truncated lines. */
export function parseJsonlRecords(source) {
  const records = [];
  for (const line of String(source ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a mid-write tail line is expected while a session is live */
    }
  }
  return records;
}

/** Trim reply prose for a verdict without losing its identity. */
export function replyPreview(text) {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > REPLY_PREVIEW_CHARS
    ? `${collapsed.slice(0, REPLY_PREVIEW_CHARS)}…`
    : collapsed;
}

/**
 * Milliseconds for one trajectory record's `ts`.
 *
 * The runtime writes an ISO-8601 string; accept an epoch number too rather than
 * silently returning NaN and collapsing every window to a point.
 */
export function recordTimeMs(record) {
  const ts = record?.ts;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Keep only the records inside one burst window.
 *
 * Without this, every earlier turn in the same conversation contributes its own
 * trace to `overlapReport` and inflates `maxConcurrent` — a sequential rig then
 * "proves" concurrency it never had. Records with no usable `ts` are dropped:
 * an untimed record cannot be placed in or out of the window.
 */
export function filterRecordsWindow(records, { fromMs, toMs } = {}) {
  return records.filter((record) => {
    const atMs = recordTimeMs(record);
    if (atMs === null) return false;
    if (fromMs !== undefined && atMs < fromMs) return false;
    if (toMs !== undefined && atMs > toMs) return false;
    return true;
  });
}

/**
 * Bind each injected inbound to its own reply, using the session transcript.
 *
 * The transcript's user record carries the normalized inbound id, which is the
 * only per-inbound key available on a DM. Assistant records carry no inbound
 * key, so attribution is sound ONLY while at most one inbound is outstanding.
 * When two or more are outstanding, this returns `ambiguous` for each of them
 * instead of binding by position — binding by position is exactly how a
 * cross-turn answer bleed gets reported as a pass.
 *
 * @param {{ injects: Array<{index:number, inboundGuid:string, text?:string}>,
 *           transcriptSource: string }} params
 */
export function attributeBurst({ injects, transcriptSource }) {
  const states = new Map(
    injects.map((inject) => [
      inject.index,
      {
        index: inject.index,
        inboundGuid: inject.inboundGuid,
        status: "unanswered",
        inboundSeen: false,
        answer: null,
        // The FULL normalized answer, for wire reconciliation. `answer` is a
        // truncated preview for reading; comparing a preview against the wire
        // would mis-count every answer longer than the preview cap.
        answerKey: null,
        progressReplies: 0,
        ambiguousWith: [],
      },
    ]),
  );
  const violations = [];
  const ambiguousAnswers = [];
  /** Inbound indices whose substantive answer has not been seen yet, in arrival order. */
  const pending = [];
  let interleavedObserved = false;
  let serializedObserved = false;
  let inboundRecordsSeen = 0;

  // A continuing relationship's transcript carries every prior turn. Attribution starts at the
  // FIRST record belonging to this burst — otherwise every historical reply is reported as
  // `unattributed-reply` (a live two-message control burst produced 25 of them, drowning the
  // verdict it was run to establish).
  let burstStarted = false;

  for (const record of parseJsonlRecords(transcriptSource)) {
    if (record?.type !== "message") continue;
    const role = record.message?.role;
    if (!burstStarted && role !== "user") continue;
    if (role === "user") {
      const text = transcriptMessageText(record.message);
      const matched = injects.filter((inject) => text.includes(inject.inboundGuid));
      if (matched.length === 0) continue;
      burstStarted = true;
      inboundRecordsSeen += 1;
      if (matched.length > 1) {
        violations.push({
          kind: "multi-inbound-user-record",
          severity: "soft",
          indices: matched.map((inject) => inject.index),
          detail:
            "one transcript user record carries more than one injected inbound id; "
            + "the injects were coalesced and cannot be attributed separately",
        });
      }
      for (const inject of matched) {
        const state = states.get(inject.index);
        if (state.inboundSeen) {
          violations.push({
            kind: "duplicate-inbound-record",
            severity: "soft",
            index: inject.index,
            detail: "the same inbound id appears in more than one transcript user record",
          });
          continue;
        }
        state.inboundSeen = true;
        pending.push(inject.index);
      }
      if (pending.length > 1) interleavedObserved = true;
      continue;
    }
    if (role !== "assistant") continue;
    const text = transcriptMessageText(record.message).trim();
    if (!text) continue;
    const substantive = !isDriveProgressText(text);

    if (pending.length === 0) {
      violations.push({
        kind: "unattributed-reply",
        severity: "soft",
        detail:
          "an assistant reply landed with no outstanding inbound (proactive, background, "
          + "or a reply to a turn outside this burst window)",
        preview: replyPreview(text),
      });
      continue;
    }

    if (pending.length === 1) {
      const state = states.get(pending[0]);
      if (!substantive) {
        state.progressReplies += 1;
        continue;
      }
      state.answer = replyPreview(text);
      state.answerKey = normalizeWireText(text);
      state.status = "answered";
      pending.shift();
      serializedObserved = true;
      continue;
    }

    // Two or more inbounds outstanding: the transcript cannot say whose reply this is.
    for (const index of pending) {
      const state = states.get(index);
      state.ambiguousWith = [...pending];
      if (state.status === "unanswered") state.status = "ambiguous";
    }
    if (!substantive) continue;
    ambiguousAnswers.push({ candidates: [...pending], preview: replyPreview(text) });
    // Retire ONE pending slot per substantive answer so the arithmetic
    // (inbounds vs answers) stays honest. This is bookkeeping only — no reply is
    // attributed to any inbound here, and every affected inbound stays
    // `ambiguous`.
    pending.shift();
  }

  for (const state of states.values()) {
    if (state.status !== "unanswered") continue;
    violations.push({
      kind: state.inboundSeen ? "lost-reply" : "inbound-never-ingested",
      severity: "hard",
      index: state.index,
      detail: state.inboundSeen
        ? "the inbound reached the transcript and never received a reply"
        : "the inbound never appeared in the transcript at all",
    });
  }

  if (inboundRecordsSeen === 0 && injects.length > 0) {
    violations.push({
      kind: "no-inbound-records",
      severity: "hard",
      detail:
        "not one injected inbound id appears in this transcript — the wrong session file was "
        + "read, or ingress rejected every inject; the run proves nothing about concurrency",
    });
  }

  const bindings = injects.map((inject) => states.get(inject.index));
  return {
    shape: inboundRecordsSeen === 0
      ? "empty"
      : interleavedObserved && serializedObserved
        ? "mixed"
        : interleavedObserved
          ? "interleaved"
          : "serialized",
    bindings,
    ambiguousAnswers,
    violations,
    counts: {
      injected: injects.length,
      answered: bindings.filter((state) => state.status === "answered").length,
      ambiguous: bindings.filter((state) => state.status === "ambiguous").length,
      unanswered: bindings.filter((state) => state.status === "unanswered").length,
    },
  };
}

/**
 * Reconcile the recorded wire against the bound answers.
 *
 * The wire proves COUNTS and ORDER and duplicate delivery. It cannot prove
 * attribution on a DM, so it is deliberately not consulted for binding.
 */
export function wireReconciliation({ wire = [], bindings = [] }) {
  const substantive = [];
  let progress = 0;
  for (const item of wire) {
    const visible = outboundVisibleText(item);
    if (!visible) continue;
    if (isDriveProgressText(visible)) {
      progress += 1;
      continue;
    }
    substantive.push(normalizeWireText(visible));
  }
  const occurrences = new Map();
  for (const text of substantive) {
    occurrences.set(text, (occurrences.get(text) ?? 0) + 1);
  }
  // Two turns may legitimately produce the SAME answer ("pong" twice for two pings), so identical
  // text is not by itself a duplicate. A duplicate is a delivery COUNT that exceeds the number of
  // bound answers carrying that text.
  const boundAnswers = new Map();
  for (const state of bindings) {
    if (state?.status !== "answered" || typeof state.answerKey !== "string") continue;
    boundAnswers.set(state.answerKey, (boundAnswers.get(state.answerKey) ?? 0) + 1);
  }
  const violations = [];
  for (const [text, count] of occurrences) {
    const allowed = Math.max(1, boundAnswers.get(text) ?? 0);
    if (count <= allowed) continue;
    violations.push({
      kind: "duplicate-delivery",
      severity: "hard",
      count,
      allowed,
      detail:
        `a substantive reply reached the wire ${count} times but only ${allowed} turn(s) `
        + "produced it",
      preview: replyPreview(text),
    });
  }
  const answered = bindings.filter((state) => state.status === "answered").length;
  if (substantive.length < answered) {
    violations.push({
      kind: "answer-not-delivered",
      severity: "hard",
      detail:
        `the transcript bound ${answered} answers but only ${substantive.length} substantive `
        + "outbound records reached the wire",
    });
  }
  return {
    substantiveOutbound: substantive.length,
    progressOutbound: progress,
    violations,
  };
}

/**
 * Prove overlap from the trajectory, per trace.
 *
 * Each turn runs under its own `traceId`, so two turns overlapped only when
 * their record windows intersect. A concurrency row whose windows do NOT
 * intersect was serialized — by the drive lock, by a session lock, or by the
 * queue — and must never be scored as a concurrency pass on the strength of its
 * reply count alone.
 */
export function overlapReport(trajectoryRecords) {
  const byTrace = new Map();
  for (const record of trajectoryRecords) {
    const traceId = record?.traceId;
    if (typeof traceId !== "string" || traceId === "") continue;
    const atMs = recordTimeMs(record);
    if (atMs === null) continue;
    const entry = byTrace.get(traceId) ?? {
      traceId,
      startMs: atMs,
      endMs: atMs,
      records: 0,
      modelCalls: 0,
    };
    entry.startMs = Math.min(entry.startMs, atMs);
    entry.endMs = Math.max(entry.endMs, atMs);
    entry.records += 1;
    if (record.type === "model.completed") entry.modelCalls += 1;
    byTrace.set(traceId, entry);
  }
  const traces = [...byTrace.values()].sort((left, right) => left.startMs - right.startMs);
  const overlappingPairs = [];
  for (let outer = 0; outer < traces.length; outer += 1) {
    for (let inner = outer + 1; inner < traces.length; inner += 1) {
      const left = traces[outer];
      const right = traces[inner];
      if (left.startMs < right.endMs && right.startMs < left.endMs) {
        overlappingPairs.push([left.traceId, right.traceId]);
      }
    }
  }
  const edges = [];
  for (const trace of traces) {
    edges.push({ atMs: trace.startMs, delta: 1 });
    edges.push({ atMs: trace.endMs, delta: -1 });
  }
  edges.sort((left, right) => left.atMs - right.atMs || left.delta - right.delta);
  let live = 0;
  let maxConcurrent = 0;
  for (const edge of edges) {
    live += edge.delta;
    maxConcurrent = Math.max(maxConcurrent, live);
  }
  return {
    traces,
    overlappingPairs,
    maxConcurrent,
    overlapped: overlappingPairs.length > 0,
  };
}

/**
 * Fold attribution, wire and overlap into one verdict.
 *
 * `expectOverlap` defaults to true because that is what a concurrency row
 * claims. Set it false for a steering or sequential row, where one trace is the
 * correct shape.
 */
export function burstVerdict({
  attribution,
  wire = { violations: [] },
  overlap = { overlapped: false, maxConcurrent: 0 },
  expectOverlap = true,
}) {
  const violations = [
    ...attribution.violations,
    ...wire.violations,
  ];
  if (expectOverlap && !overlap.overlapped) {
    violations.push({
      kind: "no-overlap-observed",
      severity: "hard",
      detail:
        "no two turn windows intersected, so this run was serialized and cannot be scored as a "
        + `concurrency pass (traces=${overlap.traces?.length ?? 0}, maxConcurrent=`
        + `${overlap.maxConcurrent}); check the drive lock, the session lock and the queue mode`,
    });
  }
  const hard = violations.filter((violation) => violation.severity === "hard");
  const soft = violations.filter((violation) => violation.severity !== "hard");
  const verdict = hard.length > 0
    ? "fail"
    : attribution.counts.ambiguous > 0
      ? "ambiguous"
      : "ok";
  return {
    verdict,
    shape: attribution.shape,
    counts: attribution.counts,
    overlap: {
      overlapped: overlap.overlapped,
      maxConcurrent: overlap.maxConcurrent,
      traces: overlap.traces?.length ?? 0,
    },
    hard,
    soft,
  };
}
