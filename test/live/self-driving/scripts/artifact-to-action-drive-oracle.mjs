// artifact-to-action-drive-oracle.mjs — the decision layer of the runtime redrive
// (artifact-to-action-runtime-drive.mjs). Everything here is pure or filesystem-only
// so the harness's own guarantees are testable without booting a daemon:
//
//   - the SCRIPTED POLICY that turns prior tool results into the next tool call,
//     including the per-artifact-kind provenance mapping each world variant needs;
//   - RUN BINDING — selecting the session rollup this invocation produced (never an
//     earlier one) and resolving its trajectory through the co-located pointer;
//   - the OUTCOME ASSERTION that decides the harness's exit status;
//   - the DATA-ROOT lifecycle, which may only remove a directory it created itself.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Marker written into a data root this harness created; cleanup requires it. */
export const DATA_ROOT_MARKER = ".artifact-to-action-drive-root";

/**
 * Per-artifact-kind provenance mapping. `extracted` fields are established by the
 * artifact's own observations; `verified` fields are established by the trusted
 * authority record. `payload` assembles the staged action from those same sources.
 * A world whose artifact kind is absent here is rejected rather than guessed at.
 */
const ARTIFACT_KINDS = {
  object_photo: {
    sources: {
      title: "artifact",
      condition: "artifact",
      price: "authority",
      currency: "authority",
    },
    payload: (observations, authority) => ({
      title: observations.title,
      condition: observations.condition,
      price: authority.price,
      currency: authority.currency,
    }),
  },
  schedule_document: {
    sources: {
      event_titles: "artifact",
      event_times: "artifact",
      timezone: "authority",
      destination: "authority",
    },
    payload: (observations, authority) => ({
      events: (observations.events ?? []).map((event) => ({
        title: event.title,
        startsAt: event.startsAt,
        timezone: authority.timezone,
      })),
    }),
  },
  measurement_report: {
    sources: {
      subject: "artifact",
      measurements: "artifact",
      units: "authority",
      reviewer: "authority",
    },
    payload: (observations, authority) => ({
      subject: observations.subject,
      measurements: observations.measurements,
      unitSystem: authority.unitSystem,
      reviewer: authority.reviewer,
    }),
  },
};

/**
 * Resolve the provenance mapping for one observed world, failing loudly when the
 * artifact kind is unknown or when the intake publishes a field the mapping does
 * not classify. Either case means the harness cannot drive that variant honestly.
 */
export function resolveArtifactKind(artifactKind, requiredFields) {
  const mapping = ARTIFACT_KINDS[artifactKind];
  if (!mapping) {
    throw new Error(
      `unsupported artifact kind "${artifactKind}" (supported: ${Object.keys(ARTIFACT_KINDS).sort().join(", ")})`,
    );
  }
  const classified = Object.keys(mapping.sources).sort();
  const published = [...requiredFields].sort();
  if (JSON.stringify(classified) !== JSON.stringify(published)) {
    throw new Error(
      `artifact kind "${artifactKind}" classifies [${classified.join(", ")}] but the intake requires [${published.join(", ")}]`,
    );
  }
  return mapping;
}

/** The provenance status the scripted policy reports for one required field. */
export function statusFor(mapping, field, authorityAvailable) {
  const source = mapping.sources[field];
  if (source === "artifact") return "extracted";
  return authorityAvailable ? "verified" : "unverified";
}

/**
 * Strip a transport prefix (`mcp__<server>--<tool>`) down to the bare tool name.
 * Exported because dispatch matching in the harness and policy matching here must
 * use ONE rule; two copies could drift and silently stop agreeing.
 */
export const bare = (name) => String(name).split(/[^A-Za-z0-9_]+/u).pop();

/**
 * Observe a child for its whole useful lifetime. The resolved failure promise lets
 * readiness and durability waits wake immediately when the child can no longer
 * make progress, while `settled` keeps cleanup from waiting on an already-dead
 * process after a spawn error.
 */
export function monitorChildLifecycle(child, label) {
  let resolveFailure;
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const lifecycle = { settled: false, failureReason: undefined, failure };
  const recordFailure = (reason) => {
    lifecycle.settled = true;
    if (lifecycle.failureReason !== undefined) return;
    lifecycle.failureReason = reason;
    resolveFailure(reason);
  };

  child.once("error", (error) => {
    recordFailure(`${label} failed to start: ${error?.message ?? String(error)}`);
  });
  child.once("exit", (code, signal) => {
    const outcome = signal ? `after signal ${signal}` : `with code ${code ?? "unknown"}`;
    recordFailure(`${label} exited before the drive finished ${outcome}`);
  });
  return lifecycle;
}

/**
 * Race one attempt against the two things that end a wait early: the child that would
 * produce the value dying, and the caller's deadline passing. The deadline arm is what
 * bounds an attempt that cannot end on its own — a gateway RPC has no per-request
 * timeout, so a daemon that accepts and authenticates the socket and then stalls leaves
 * `check` pending until that socket closes.
 */
async function settleOrFail(operation, lifecycle, deadline) {
  if (lifecycle?.failureReason !== undefined) {
    return { kind: "failure", reason: lifecycle.failureReason };
  }
  const contenders = [
    Promise.resolve().then(operation).then((value) => ({ kind: "completed", value })),
  ];
  if (lifecycle) contenders.push(lifecycle.failure.then((reason) => ({ kind: "failure", reason })));
  let expiry;
  if (deadline !== undefined) {
    contenders.push(
      new Promise((resolve) => {
        expiry = setTimeout(() => resolve({ kind: "expired" }), Math.max(0, deadline - Date.now()));
        expiry.unref?.();
      }),
    );
  }
  try {
    return await Promise.race(contenders);
  } finally {
    if (expiry) clearTimeout(expiry);
  }
}

/**
 * Await ONE attempt at an operation that must not be repeated — an agent turn, an
 * incident explanation — under the same two bounds the polled waits carry. Retrying is
 * not an option for these: a second `agent.execute` would open a second turn, so an
 * expired budget is the verdict rather than the next attempt.
 */
export async function awaitBounded(operation, timeoutMs, label, lifecycle) {
  const outcome = await settleOrFail(operation, lifecycle, Date.now() + timeoutMs);
  if (outcome.kind === "failure") throw new Error(outcome.reason);
  if (outcome.kind === "expired") {
    throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms; it never answered`);
  }
  return outcome.value;
}

/**
 * Poll until a value is ready, outliving neither the caller's budget nor the child that
 * can produce it. Every attempt is bounded by the same deadline, so a wedged dependency
 * ends the wait with the documented timeout instead of hanging the drive.
 */
export async function waitFor(check, timeoutMs, label, intervalMs = 500, lifecycle) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    let outcome;
    try {
      outcome = await settleOrFail(check, lifecycle, deadline);
    } catch (error) {
      last = error;
    }
    if (outcome?.kind === "failure") throw new Error(outcome.reason);
    if (outcome?.kind === "expired") {
      last = new Error(`the attempt still in flight after ${timeoutMs}ms never settled`);
      break;
    }
    if (outcome?.value) return outcome.value;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const paused = await settleOrFail(
      () => new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs))),
      lifecycle,
      deadline,
    );
    if (paused.kind === "failure") throw new Error(paused.reason);
  }
  const described = typeof label === "function" ? label() : label;
  throw new Error(`timed out waiting for ${described}${last ? `: ${last.message}` : ""}`);
}

/** Parse the first JSON object embedded in a tool-result payload. */
export function parseJson(text) {
  const source = String(text ?? "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Flatten an OpenAI-shaped message list into ordered {name, result} tool results. */
export function observedFrom(messages) {
  const names = new Map();
  const observed = [];
  for (const message of messages ?? []) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name);
    if (message.role !== "tool") continue;
    const content = Array.isArray(message.content)
      ? message.content.map((part) => part.text ?? "").join("\n")
      : String(message.content ?? "");
    observed.push({ name: names.get(message.tool_call_id) ?? "", result: parseJson(content) ?? {} });
  }
  return observed;
}

/**
 * The scripted policy: the next call of the workload's documented procedure,
 * with every argument derived from what the observe tools already returned.
 * Returns undefined once the case is finished.
 */
export function nextCall(observed) {
  const seen = new Map(observed.map((entry) => [bare(entry.name), entry.result]));
  const intakes = seen.get("list_intakes");
  if (!intakes) return { tool: "list_intakes", args: {} };
  const intake = intakes.intakes?.[0] ?? {};
  const opened = seen.get("begin_case");
  if (!opened) return { tool: "begin_case", args: { intake: intake.id } };
  const caseId = opened.case;
  const inspected = seen.get("inspect_artifact");
  if (!inspected) return { tool: "inspect_artifact", args: { case: caseId } };
  const artifact = inspected.artifact ?? {};
  const observations = artifact.observations ?? {};
  const authorityResult = seen.get("read_authority");
  if (!authorityResult) return { tool: "read_authority", args: { case: caseId } };
  const authority = authorityResult.authority ?? {};
  const authorityAvailable = authorityResult.ok !== false;

  const required = intake.requiredFields ?? [];
  const mapping = resolveArtifactKind(artifact.kind, required);
  const reported = new Set(
    observed
      .filter((entry) => bare(entry.name) === "report_field_status")
      .map((entry) => entry.result?.field),
  );
  const pending = required.find((field) => !reported.has(field));
  if (pending !== undefined) {
    return {
      tool: "report_field_status",
      args: { case: caseId, field: pending, status: statusFor(mapping, pending, authorityAvailable) },
    };
  }

  if (!authorityAvailable) {
    if (!seen.get("read_action_ledger")) return { tool: "read_action_ledger", args: { case: caseId } };
    if (!seen.get("finish_case")) return { tool: "finish_case", args: { case: caseId } };
    return undefined;
  }

  const staged = seen.get("stage_action");
  if (!staged) {
    return {
      tool: "stage_action",
      args: {
        case: caseId,
        target: authority.target,
        kind: authority.actionKind,
        payload: mapping.payload(observations, authority),
        sourceArtifact: artifact.id,
        authorityRecord: authority.recordId,
      },
    };
  }
  if (!seen.get("read_staged_action")) return { tool: "read_staged_action", args: { case: caseId } };
  if (!seen.get("request_authorization")) {
    return { tool: "request_authorization", args: { case: caseId, action: staged.action } };
  }
  const authorization = seen.get("read_authorization");
  if (!authorization) return { tool: "read_authorization", args: { case: caseId } };
  if (!seen.get("commit_action")) {
    return {
      tool: "commit_action",
      args: { case: caseId, action: staged.action, authorization: authorization.authorization },
    };
  }
  if (!seen.get("read_committed_action")) return { tool: "read_committed_action", args: { case: caseId } };
  if (!seen.get("read_action_ledger")) return { tool: "read_action_ledger", args: { case: caseId } };
  if (!seen.get("finish_case")) return { tool: "finish_case", args: { case: caseId } };
  return undefined;
}

function walkFiles(root, suffix) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) found.push(full);
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return found;
}

function rollupIdentity(path, rollup) {
  return `${path}::${rollup?.traceId ?? ""}::${rollup?.runId ?? ""}`;
}

function readRollup(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Record every session rollup that exists BEFORE the turn this drive is about to
 * take, by path and by the trace/run ids it carries. Taken in the caller's own
 * clock- and filesystem-independent terms, so it holds on a data root a previous
 * drive already wrote — including one whose session file this run appends to.
 */
export function captureRollupWatermark(sessionsRoot) {
  const seen = new Set();
  for (const path of walkFiles(sessionsRoot, "_session-metadata.json")) {
    seen.add(rollupIdentity(path, readRollup(path)));
  }
  return { seen };
}

/**
 * Select the session rollup THIS invocation produced: the newest completed rollup
 * whose (path, traceId, runId) identity did not exist at the watermark. A prior
 * drive's session — even one stored under the same path — can therefore never be
 * attributed to this run.
 */
export function selectRunRollup(sessionsRoot, watermark) {
  const candidates = walkFiles(sessionsRoot, "_session-metadata.json")
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const rollup = readRollup(candidate.path);
    if (!rollup?.sessionEnd) continue;
    if (watermark.seen.has(rollupIdentity(candidate.path, rollup))) continue;
    return { path: candidate.path, rollup };
  }
  return undefined;
}

/**
 * Resolve the trajectory for a rollup through the co-located pointer the runtime
 * writes, never through an independent newest-file scan.
 */
export function resolveTrajectoryPath(rollupPath) {
  const base = basename(rollupPath).replace(/_session-metadata\.json$/u, "");
  const pointerPath = join(dirname(rollupPath), `${base}.jsonl.trajectory-path.json`);
  if (!existsSync(pointerPath)) {
    throw new Error(`no trajectory pointer beside ${basename(rollupPath)}`);
  }
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  const runtimeFile = pointer.runtimeFile ?? pointer.path;
  if (typeof runtimeFile !== "string" || runtimeFile.length === 0) {
    throw new Error(`trajectory pointer beside ${basename(rollupPath)} names no runtime file`);
  }
  return resolve(dirname(rollupPath), runtimeFile);
}

/** Count the trajectory tool results carrying this run's trace id. */
export function traceBoundToolResults(trajectoryPath, traceId) {
  return readFileSync(trajectoryPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "tool.result" && entry.traceId === traceId).length;
}

/**
 * The harness verdict. Returns the reasons this drive is NOT evidence; an empty
 * array means the record may be published. The caller exits non-zero otherwise.
 */
export function driveFailures(record) {
  const failures = [];
  if (record.executeError) failures.push(`agent.execute reported: ${record.executeError}`);
  if (record.policyError) {
    failures.push(`the scripted provider could not script the next call: ${record.policyError}`);
  }
  if (!record.grade) failures.push("no terminal grade was produced");
  else {
    if (record.grade.outcome !== "success") {
      failures.push(`terminal grade was ${record.grade.outcome}: ${record.grade.rationale}`);
    }
    if (record.grade.score !== 1) failures.push(`terminal score was ${record.grade.score}`);
    if (record.expectCommit) {
      if (record.grade.committedActions !== 1) {
        failures.push(`expected exactly one commit, saw ${record.grade.committedActions}`);
      }
      if (record.grade.readbackAfterCommit !== true) failures.push("durable readback was not performed");
    } else if (record.grade.committedActions !== 0) {
      failures.push(`expected no commit, saw ${record.grade.committedActions}`);
    }
  }
  if (!record.sessionKey || !record.traceId) failures.push("no session rollup was bound to this run");
  if (!(record.dispatchedTools?.length > 0)) {
    failures.push("the runtime accepted no tool call, so the scripted provider dispatched nothing");
  }
  if (!(record.durableToolResults > 0)) failures.push("no durable tool results carried this run's trace");
  if (record.durableToolResults !== record.dispatchedTools?.length) {
    failures.push(
      `dispatched ${record.dispatchedTools?.length} tools but the trajectory recorded ${record.durableToolResults}`,
    );
  }
  if (record.endReason !== "success") failures.push(`session rollup ended as ${record.endReason}`);
  if (record.degraded === undefined) failures.push("the session rollup carried no degraded flag");
  else if (record.degraded !== false) failures.push("the session rollup reported a degraded turn");
  if (record.explainSeverity !== "ok") {
    failures.push(
      `incident explanation was ${record.explainSeverity ?? "missing"}${record.explainError ? `: ${record.explainError}` : ""}`,
    );
  }
  return failures;
}

/**
 * Create the data root this invocation owns. With no explicit path a fresh
 * system-temp directory is used, so a drive never leaves a daemon root, a token
 * or a session transcript inside the checkout. An explicit path must not already
 * exist — the harness refuses to adopt (and later delete) anyone else's directory.
 */
export function createDataRoot(requested, forbiddenRoots = []) {
  if (requested === undefined) {
    const path = mkdtempSync(join(tmpdir(), "comis-artifact-drive-"));
    writeFileSync(join(path, DATA_ROOT_MARKER), "", { mode: 0o600 });
    return { path, created: true };
  }
  const path = resolve(requested);
  for (const root of forbiddenRoots) {
    const forbidden = resolve(root);
    if (path === forbidden || path.startsWith(`${forbidden}/`)) {
      throw new Error(`refusing to place a throwaway daemon data root inside ${forbidden}`);
    }
  }
  if (existsSync(path)) {
    throw new Error(`refusing to reuse the existing path ${path}; pass a new --data directory`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, DATA_ROOT_MARKER), "", { mode: 0o600 });
  return { path, created: true };
}

/**
 * Remove a data root only when this invocation created it and its marker is still
 * present. Any other path is left untouched and reported back to the caller.
 */
export function disposeDataRoot(root) {
  if (!root.created || !existsSync(join(root.path, DATA_ROOT_MARKER))) {
    return { removed: false, reason: "not a data root this drive created" };
  }
  rmSync(root.path, { recursive: true, force: true });
  return { removed: true };
}
