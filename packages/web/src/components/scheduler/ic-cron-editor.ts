// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import { systemDateFrom, systemNowDate } from "@comis/core";
import type { WebRpcMethodMap } from "../../api/contracts.generated.js";
import {
  createIcCronEditorController,
  type IcCronEditorController,
} from "./ic-cron-editor-controller.js";

/* ------------------------------------------------------------------ */
/*  Generated RPC projections keep web independent of scheduler code. */
/* ------------------------------------------------------------------ */

type CronAddParams = WebRpcMethodMap["cron.add"]["params"];
type CronUpdateParams = WebRpcMethodMap["cron.update"]["params"];

export type CronScheduleInput = Exclude<CronAddParams["schedule"], { kind: "in" }>;

interface CronJobInputBase {
  id: string;
  name: string;
  agentId: string;
  schedule: CronScheduleInput;
  paused: boolean;
}

export type CronJobInput = CronJobInputBase & (
  | {
      payload: Extract<CronAddParams["payload"], { kind: "agent_turn" }>;
      sessionPolicy: NonNullable<CronAddParams["sessionPolicy"]>;
      continuationMode: NonNullable<CronAddParams["continuationMode"]>;
      deliveryTarget?: CronUpdateParams["deliveryTarget"];
      wakeGate?: CronUpdateParams["wakeGate"];
    }
  | {
      payload: Extract<CronAddParams["payload"], { kind: "heartbeat_event" }>;
    }
  | {
      payload: Extract<CronAddParams["payload"], { kind: "delivery" }>;
      deliveryTarget: NonNullable<CronAddParams["deliveryTarget"]>;
    }
);

/* ------------------------------------------------------------------ */
/*  Next-runs calculators (exported for testing)                      */
/* ------------------------------------------------------------------ */

/** Parse a single cron field (minute, hour, dom, month, dow) into the set of matching values. */
function parseCronField(field: string, min: number, max: number): number[] | null {
  const results = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();
    // step pattern: */N or range/N
    const stepMatch = trimmed.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const stepVal = parseInt(stepMatch[4], 10);
      if (stepVal <= 0) return null;
      let start = min;
      let end = max;
      if (stepMatch[2] !== undefined && stepMatch[3] !== undefined) {
        start = parseInt(stepMatch[2], 10);
        end = parseInt(stepMatch[3], 10);
      }
      if (start < min || end > max || start > end) return null;
      for (let i = start; i <= end; i += stepVal) {
        results.add(i);
      }
      continue;
    }

    // wildcard
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) results.add(i);
      continue;
    }

    // range: N-M
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const s = parseInt(rangeMatch[1], 10);
      const e = parseInt(rangeMatch[2], 10);
      if (s < min || e > max || s > e) return null;
      for (let i = s; i <= e; i++) results.add(i);
      continue;
    }

    // single number
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n < min || n > max) return null;
      results.add(n);
      continue;
    }

    // unrecognized token
    return null;
  }

  return results.size > 0 ? Array.from(results).sort((a, b) => a - b) : null;
}

/**
 * Compute the next N fire times for a 5-field cron expression.
 * Fields: minute hour dom month dow
 *
 * Iterates minute-by-minute from `from` up to 366 days ahead.
 */
export function computeNextCronRuns(
  expr: string,
  tz: string | undefined,
  count: number,
  from: Date,
): Date[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6);

  if (!minutes || !hours || !doms || !months || !dows) return [];

  const minuteSet = new Set(minutes);
  const hourSet = new Set(hours);
  const domSet = new Set(doms);
  const monthSet = new Set(months);
  const dowSet = new Set(dows);

  const results: Date[] = [];
  const maxMs = 366 * 24 * 60 * 60 * 1000;
  const endTime = from.getTime() + maxMs;

  // Cron fields are matched against the wall-clock time **in `tz`** (not the
  // host's local time) so the preview agrees with the daemon, which fires jobs
  // in the job's configured timezone (schedule.tz). The formatter is built once
  // for the whole scan. When `tz` is absent or unknown we fall back to local
  // time rather than throwing inside a preview.
  let tzFmt: Intl.DateTimeFormat | null = null;
  if (tz) {
    try {
      tzFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        weekday: "short",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      tzFmt = null;
    }
  }
  const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // Start one minute past `from`
  const cursor = systemDateFrom(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + 60_000);

  while (cursor.getTime() <= endTime && results.length < count) {
    let m: number, h: number, dom: number, mon: number, dow: number;
    if (tzFmt) {
      const parts = tzFmt.formatToParts(cursor);
      const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
      m = parseInt(get("minute"), 10);
      h = parseInt(get("hour"), 10) % 24; // hour12:false can emit "24" at midnight
      dom = parseInt(get("day"), 10);
      mon = parseInt(get("month"), 10);
      dow = DOW_MAP[get("weekday")] ?? 0;
    } else {
      m = cursor.getMinutes();
      h = cursor.getHours();
      dom = cursor.getDate();
      mon = cursor.getMonth() + 1;
      dow = cursor.getDay();
    }

    if (minuteSet.has(m) && hourSet.has(h) && domSet.has(dom) && monthSet.has(mon) && dowSet.has(dow)) {
      results.push(systemDateFrom(cursor.getTime()));
    }

    cursor.setTime(cursor.getTime() + 60_000);
  }

  return results;
}

/**
 * Compute the next N fire times for an interval-based schedule.
 */
export function computeNextEveryRuns(everyMs: number, count: number, from: Date): Date[] {
  if (everyMs <= 0 || !Number.isFinite(everyMs)) return [];
  const results: Date[] = [];
  let t = from.getTime();
  for (let i = 0; i < count; i++) {
    t += everyMs;
    results.push(systemDateFrom(t));
  }
  return results;
}

/**
 * Compute fire times for a one-shot schedule.
 * Returns a single-element array if the datetime is in the future, empty otherwise.
 */
export function computeNextAtRun(at: string, from?: Date): Date[] {
  const d = systemDateFrom(at);
  if (isNaN(d.getTime())) return [];
  const ref = from ?? systemNowDate();
  return d.getTime() > ref.getTime() ? [d] : [];
}

/**
 * Format a Date for display in the next-runs list.
 * Example: "Mon 2026-03-02 09:00 EST"
 */
function formatRunDate(d: Date, tz?: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || undefined,
      timeZoneName: "short",
      hour12: false,
    });
    return fmt.format(d);
  } catch {
    return d.toISOString();
  }
}

/* ------------------------------------------------------------------ */
/*  Common timezone list                                              */
/* ------------------------------------------------------------------ */

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
] as const;

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

/**
 * Cron job editor form.
 *
 * Reusable form component for creating and editing cron jobs.
 * Includes schedule kind switching, next-5-runs preview, and
 * fires `save` / `cancel` CustomEvents.
 *
 * @fires save - CustomEvent<CronJobInput> when save button is clicked
 * @fires cancel - CustomEvent (no detail) when cancel button is clicked
 *
 * @example
 * ```html
 * <ic-cron-editor
 *   .agents=${["default", "assistant"]}
 *   @save=${this._onSave}
 *   @cancel=${this._onCancel}
 * ></ic-cron-editor>
 * ```
 */
@customElement("ic-cron-editor")
export class IcCronEditor extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .editor-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      h2 {
        margin: 0 0 var(--ic-space-lg);
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
      }

      .form-grid {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        font-weight: 500;
      }

      input,
      select,
      textarea {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        transition: border-color var(--ic-transition);
        width: 100%;
      }

      input::placeholder,
      textarea::placeholder {
        color: var(--ic-text-dim);
      }

      input:focus,
      select:focus,
      textarea:focus {
        border-color: var(--ic-accent);
        outline: none;
      }

      input:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      select {
        appearance: auto;
        cursor: pointer;
      }

      textarea {
        resize: vertical;
        min-height: 4rem;
      }

      .checkbox-field {
        flex-direction: row;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .checkbox-field input[type="checkbox"] {
        width: auto;
        accent-color: var(--ic-accent);
      }

      .kind-group {
        display: flex;
        gap: var(--ic-space-md);
      }

      .kind-option {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        cursor: pointer;
      }

      .kind-option input[type="radio"] {
        width: auto;
        accent-color: var(--ic-accent);
      }

      .kind-option label {
        cursor: pointer;
      }

      .next-runs {
        margin-top: var(--ic-space-sm);
      }

      .next-runs h3 {
        margin: 0 0 var(--ic-space-xs);
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .next-runs ul {
        list-style: disc;
        margin: 0;
        padding-left: var(--ic-space-lg);
      }

      .next-runs li {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        line-height: 1.6;
      }

      .next-runs .empty-msg {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      .button-row {
        display: flex;
        justify-content: flex-end;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-lg);
      }

      .btn {
        padding: var(--ic-space-sm) var(--ic-space-lg);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        transition:
          background var(--ic-transition),
          border-color var(--ic-transition);
      }

      .btn-cancel {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .btn-cancel:hover {
        border-color: var(--ic-text-muted);
        color: var(--ic-text);
      }

      .btn-save {
        background: var(--ic-accent);
        border: 1px solid var(--ic-accent);
        color: #fff;
      }

      .btn-save:hover {
        filter: brightness(1.1);
      }
    `,
  ];

  /* ---- Public properties ---- */

  /** Pre-fill form when editing an existing job. */
  @property({ type: Object }) job: CronJobInput | null = null;

  /** Controls title and ID field editability. */
  @property() mode: "create" | "edit" = "create";

  /** Available agent IDs for the agent dropdown. */
  @property({ type: Array }) agents: string[] = [];

  /* ---- Internal state ---- */

  @state() private _id = "";
  @state() private _name = "";
  @state() private _scheduleKind: "cron" | "every" | "at" = "cron";
  @state() private _cronExpr = "";
  @state() private _timezone = "UTC";
  @state() private _everyMs = 60_000;
  @state() private _atDateTime = "";
  @state() private _paused = false;
  @state() private _agentId = "";
  @state() private _payloadKind: "agent_turn" | "heartbeat_event" | "delivery" = "agent_turn";
  @state() private _payloadText = "";
  @state() private _agentModel = "";
  @state() private _agentTimeoutSeconds: number | null = null;
  @state() private _heartbeatWakeMode: "now" | "next-heartbeat" = "now";
  @state() private _sessionStrategy: "fresh" | "rolling" = "fresh";
  @state() private _maxHistoryTurns = 3;
  @state() private _continuationMode: "none" | "heartbeat_excerpt" | "origin_history" = "none";
  @state() private _deliveryMode: "none" | "existing" = "none";
  @state() private _wakeGateScript = "";
  @state() private _wakeGateLanguage: "js" | "ts" = "js";
  @state() private _wakeGateTimeoutSeconds = 30;
  /** True when the edited job arrived with a gate, so clearing the script sends
   *  an explicit null removal rather than leaving the persisted gate unchanged. */
  @state() private _hadWakeGate = false;
  @state() private _nextRuns: string[] = [];

  /** Controller owns preview-debounce orchestration + next-runs dispatch. */
  private _controller: IcCronEditorController | null = null;

  /** Lazily instantiate controller; matches the Wave-4/5 view pattern. */
  private _ensureController(): IcCronEditorController {
    if (!this._controller) {
      this._controller = createIcCronEditorController(this);
    }
    return this._controller;
  }

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    this._ensureController();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("job") && this.job) {
      this._populateFromJob(this.job);
    }
    // Default agentId to first available agent in create mode
    if (changed.has("agents") && this.agents.length > 0 && !this._agentId) {
      this._agentId = this.agents[0];
    }
  }

  override updated(changed: Map<string, unknown>): void {
    const scheduleFields: Array<keyof this> = [
      "_scheduleKind" as keyof this,
      "_cronExpr" as keyof this,
      "_timezone" as keyof this,
      "_everyMs" as keyof this,
      "_atDateTime" as keyof this,
    ];
    const needsPreview = scheduleFields.some((f) => changed.has(f as string));
    if (needsPreview) {
      this._schedulePreviewDebounced();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Controller's hostDisconnected handles preview-timer teardown
    // (Lit auto-fires it when the host disconnects). No manual call
    // here — the addController() registration drives the cycle.
  }

  /* ---- Populate from job ---- */

  private _populateFromJob(job: CronJobInput): void {
    this._id = job.id;
    this._name = job.name;
    this._agentId = job.agentId;
    this._paused = job.paused;
    this._payloadKind = job.payload.kind;
    this._payloadText = job.payload.kind === "agent_turn" ? job.payload.message : job.payload.text;
    this._agentModel = job.payload.kind === "agent_turn" ? job.payload.model ?? "" : "";
    this._agentTimeoutSeconds = job.payload.kind === "agent_turn"
      ? job.payload.timeoutSeconds ?? null
      : null;
    this._heartbeatWakeMode = job.payload.kind === "heartbeat_event" ? job.payload.wakeMode : "now";
    this._sessionStrategy = job.payload.kind === "agent_turn"
      ? job.sessionPolicy.strategy
      : "fresh";
    this._maxHistoryTurns = job.payload.kind === "agent_turn"
      && job.sessionPolicy.strategy === "rolling"
      ? job.sessionPolicy.maxHistoryTurns
      : 3;
    this._continuationMode = job.payload.kind === "agent_turn" ? job.continuationMode : "none";
    this._scheduleKind = job.schedule.kind;
    this._cronExpr = job.schedule.kind === "cron" ? job.schedule.expr : "";
    this._timezone = "tz" in job.schedule ? job.schedule.tz ?? "UTC" : "UTC";
    this._everyMs = job.schedule.kind === "every" ? job.schedule.everyMs : 60_000;
    this._atDateTime = job.schedule.kind === "at" ? job.schedule.at : "";
    if ("deliveryTarget" in job && job.deliveryTarget) {
      this._deliveryMode = "existing";
    } else {
      this._deliveryMode = "none";
    }
    const wakeGate = job.payload.kind === "agent_turn" ? job.wakeGate : undefined;
    this._wakeGateScript = wakeGate?.script ?? "";
    this._wakeGateLanguage = wakeGate?.language ?? "js";
    this._wakeGateTimeoutSeconds = wakeGate?.timeoutSeconds ?? 30;
    this._hadWakeGate = wakeGate != null;
  }

  /* ---- Preview ---- */

  private _schedulePreviewDebounced(): void {
    const controller = this._ensureController();
    controller.schedulePreview(() => this._computePreview());
  }

  private _computePreview(): void {
    const controller = this._ensureController();
    const runs = controller.computeNextRuns({
      scheduleKind: this._scheduleKind,
      cronExpr: this._cronExpr,
      timezone: this._timezone,
      everyMs: this._everyMs,
      atDateTime: this._atDateTime,
    });
    this._nextRuns = runs.map((d) =>
      formatRunDate(d, this._scheduleKind === "cron" ? this._timezone : undefined),
    );
  }

  /* ---- Assemble output ---- */

  private _assembleJob(): CronJobInput | null {
    let schedule: CronScheduleInput;
    switch (this._scheduleKind) {
      case "cron":
        schedule = { kind: "cron", expr: this._cronExpr, tz: this._timezone };
        break;
      case "every":
        schedule = { kind: "every", everyMs: this._everyMs };
        break;
      case "at":
        schedule = /(?:Z|[+-]\d{2}:\d{2})$/u.test(this._atDateTime)
          ? { kind: "at", at: this._atDateTime }
          : { kind: "at", at: this._atDateTime, tz: this._timezone };
        break;
    }

    const common = {
      id: this._id,
      name: this._name,
      agentId: this._agentId,
      schedule,
      paused: this._paused,
    };
    if (this._payloadKind === "heartbeat_event") {
      return {
        ...common,
        payload: { kind: "heartbeat_event", text: this._payloadText, wakeMode: this._heartbeatWakeMode },
      };
    }
    if (this._payloadKind === "delivery") {
      if (!this.job || !("deliveryTarget" in this.job) || !this.job.deliveryTarget) {
        return null;
      }
      return {
        ...common,
        payload: { kind: "delivery", text: this._payloadText },
        deliveryTarget: this.job.deliveryTarget,
      };
    }
    const sessionPolicy: NonNullable<CronAddParams["sessionPolicy"]> = this._sessionStrategy === "rolling"
      ? { strategy: "rolling", maxHistoryTurns: this._maxHistoryTurns }
      : { strategy: "fresh" };
    return {
      ...common,
      payload: {
        kind: "agent_turn",
        message: this._payloadText,
        ...(this._agentModel.trim() ? { model: this._agentModel.trim() } : {}),
        ...(this._agentTimeoutSeconds === null
          ? {}
          : { timeoutSeconds: this._agentTimeoutSeconds }),
      },
      sessionPolicy,
      continuationMode: this._continuationMode,
      ...(this._deliveryMode === "existing" && this.job
          && "deliveryTarget" in this.job && this.job.deliveryTarget
        ? { deliveryTarget: this.job.deliveryTarget }
        : this.job && "deliveryTarget" in this.job && this.job.deliveryTarget
          ? { deliveryTarget: null }
          : {}),
      ...(this._wakeGateScript.trim()
        ? {
            wakeGate: {
              script: this._wakeGateScript,
              language: this._wakeGateLanguage,
              timeoutSeconds: this._wakeGateTimeoutSeconds,
            },
          }
        : this._hadWakeGate
          ? { wakeGate: null }
          : {}),
    };
  }

  /* ---- Event handlers ---- */

  private _onSave(): void {
    const job = this._assembleJob();
    if (!job) return;
    this.dispatchEvent(
      new CustomEvent("save", { detail: job }),
    );
  }

  private _onCancel(): void {
    this.dispatchEvent(new CustomEvent("cancel"));
  }

  /* ---- Render ---- */

  override render() {
    const title = this.mode === "edit" ? "Edit Cron Job" : "New Cron Job";
    const deliveryTarget = this.job && "deliveryTarget" in this.job
      ? this.job.deliveryTarget
      : undefined;

    return html`
      <div class="editor-card">
        <h2>${title}</h2>

        <div class="form-grid">
          <!-- ID -->
          <div class="field">
            <label for="cron-id">ID</label>
            <input
              id="cron-id"
              type="text"
              .value=${this._id}
              ?disabled=${this.mode === "edit"}
              placeholder="e.g. daily-report"
              @input=${(e: InputEvent) => { this._id = (e.target as HTMLInputElement).value; }}
            />
          </div>

          <!-- Name -->
          <div class="field">
            <label for="cron-name">Name</label>
            <input
              id="cron-name"
              type="text"
              .value=${this._name}
              placeholder="Human-readable name"
              @input=${(e: InputEvent) => { this._name = (e.target as HTMLInputElement).value; }}
            />
          </div>

          <!-- Schedule Kind -->
          <div class="field">
            <label>Schedule Kind</label>
            <div class="kind-group">
              <label class="kind-option">
                <input
                  type="radio"
                  name="schedule-kind"
                  value="cron"
                  .checked=${this._scheduleKind === "cron"}
                  @change=${() => { this._scheduleKind = "cron"; }}
                />
                <span>Cron</span>
              </label>
              <label class="kind-option">
                <input
                  type="radio"
                  name="schedule-kind"
                  value="every"
                  .checked=${this._scheduleKind === "every"}
                  @change=${() => { this._scheduleKind = "every"; }}
                />
                <span>Interval</span>
              </label>
              <label class="kind-option">
                <input
                  type="radio"
                  name="schedule-kind"
                  value="at"
                  .checked=${this._scheduleKind === "at"}
                  @change=${() => { this._scheduleKind = "at"; }}
                />
                <span>One-shot</span>
              </label>
            </div>
          </div>

          <!-- Cron fields -->
          ${this._scheduleKind === "cron" ? html`
            <div class="field">
              <label for="cron-expr">Schedule Expression</label>
              <input
                id="cron-expr"
                type="text"
                .value=${this._cronExpr}
                placeholder="0 9 * * *"
                @input=${(e: InputEvent) => { this._cronExpr = (e.target as HTMLInputElement).value; }}
              />
            </div>
            <div class="field">
              <label for="cron-tz">Timezone</label>
              <select
                id="cron-tz"
                .value=${this._timezone}
                @change=${(e: Event) => { this._timezone = (e.target as HTMLSelectElement).value; }}
              >
                ${TIMEZONES.map(
                  (tz) => html`<option value=${tz} ?selected=${tz === this._timezone}>${tz}</option>`,
                )}
              </select>
            </div>
          ` : nothing}

          <!-- Interval field -->
          ${this._scheduleKind === "every" ? html`
            <div class="field">
              <label for="cron-interval">Interval (minutes)</label>
              <input
                id="cron-interval"
                type="number"
                min="1"
                .value=${String(Math.round(this._everyMs / 60_000))}
                @input=${(e: InputEvent) => {
                  const mins = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!isNaN(mins) && mins > 0) this._everyMs = mins * 60_000;
                }}
              />
            </div>
          ` : nothing}

          <!-- One-shot field -->
          ${this._scheduleKind === "at" ? html`
            <div class="field">
              <label for="cron-at">Run At</label>
              <input
                id="cron-at"
                type="datetime-local"
                .value=${this._atDateTime}
                @input=${(e: InputEvent) => { this._atDateTime = (e.target as HTMLInputElement).value; }}
              />
            </div>
          ` : nothing}

          ${this.mode === "edit" ? html`
            <div class="field checkbox-field">
              <input
                id="cron-paused"
                type="checkbox"
                .checked=${this._paused}
                @change=${(e: Event) => { this._paused = (e.target as HTMLInputElement).checked; }}
              />
              <label for="cron-paused">Paused</label>
            </div>
          ` : nothing}

          <!-- Agent -->
          <div class="field">
            <label for="cron-agent">Agent</label>
            <select
              id="cron-agent"
              .value=${this._agentId}
              @change=${(e: Event) => { this._agentId = (e.target as HTMLSelectElement).value; }}
            >
              ${this.agents.length === 0
                ? html`<option value="">No agents available</option>`
                : this.agents.map(
                    (a) => html`<option value=${a} ?selected=${a === this._agentId}>${a}</option>`,
                  )}
            </select>
          </div>

          <div class="field">
            <label for="cron-payload-kind">Action</label>
            <select
              id="cron-payload-kind"
              .value=${this._payloadKind}
              @change=${(e: Event) => {
                this._payloadKind = (e.target as HTMLSelectElement).value as typeof this._payloadKind;
              }}
            >
              <option value="agent_turn">Agent turn</option>
              <option value="heartbeat_event">Heartbeat event</option>
              ${this.job?.payload.kind === "delivery" && "deliveryTarget" in this.job
                ? html`<option value="delivery">Direct delivery</option>`
                : nothing}
            </select>
          </div>

          <div class="field">
            <label for="cron-message">Message</label>
            <textarea
              id="cron-message"
              rows="3"
              .value=${this._payloadText}
              placeholder="Scheduled text..."
              @input=${(e: InputEvent) => { this._payloadText = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
          </div>

          ${this._payloadKind === "agent_turn" ? html`
            <div class="field">
              <label for="cron-session">Session policy</label>
              <select
                id="cron-session"
                .value=${this._sessionStrategy}
                @change=${(e: Event) => {
                  this._sessionStrategy = (e.target as HTMLSelectElement).value as typeof this._sessionStrategy;
                }}
              >
                <option value="fresh">Fresh</option>
                <option value="rolling">Rolling</option>
              </select>
            </div>
            ${this._sessionStrategy === "rolling" ? html`
              <div class="field">
                <label for="cron-history-turns">History turns</label>
                <input
                  id="cron-history-turns"
                  type="number"
                  min="1"
                  max="20"
                  .value=${String(this._maxHistoryTurns)}
                  @input=${(e: InputEvent) => {
                    const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                    if (Number.isSafeInteger(value) && value >= 1 && value <= 20) this._maxHistoryTurns = value;
                  }}
                />
              </div>
            ` : nothing}
            <div class="field">
              <label for="cron-continuation">Continuation</label>
              <select
                id="cron-continuation"
                .value=${this._continuationMode}
                @change=${(e: Event) => {
                  this._continuationMode = (e.target as HTMLSelectElement).value as typeof this._continuationMode;
                }}
              >
                <option value="none">None</option>
                <option value="heartbeat_excerpt">Heartbeat excerpt</option>
                <option value="origin_history">Origin history</option>
              </select>
            </div>
            <div class="field">
              <label for="cron-model">Model override (optional)</label>
              <input
                id="cron-model"
                type="text"
                .value=${this._agentModel}
                @input=${(e: InputEvent) => { this._agentModel = (e.target as HTMLInputElement).value; }}
              />
            </div>
            <div class="field">
              <label for="cron-timeout">Timeout seconds (optional)</label>
              <input
                id="cron-timeout"
                type="number"
                min="1"
                max="86400"
                .value=${this._agentTimeoutSeconds === null ? "" : String(this._agentTimeoutSeconds)}
                @input=${(e: InputEvent) => {
                  const raw = (e.target as HTMLInputElement).value;
                  const value = Number.parseInt(raw, 10);
                  this._agentTimeoutSeconds = raw === "" || !Number.isSafeInteger(value) ? null : value;
                }}
              />
            </div>
          ` : nothing}

          ${this._payloadKind === "heartbeat_event" ? html`
            <div class="field">
              <label for="cron-wake-mode">Wake mode</label>
              <select
                id="cron-wake-mode"
                .value=${this._heartbeatWakeMode}
                @change=${(e: Event) => {
                  this._heartbeatWakeMode = (e.target as HTMLSelectElement).value as typeof this._heartbeatWakeMode;
                }}
              >
                <option value="now">Now</option>
                <option value="next-heartbeat">Next heartbeat</option>
              </select>
            </div>
          ` : nothing}

          <!-- Delivery Target -->
          <div class="field">
            <label for="cron-delivery">Delivery</label>
            <select
              id="cron-delivery"
              .value=${this._deliveryMode}
              @change=${(e: Event) => { this._deliveryMode = (e.target as HTMLSelectElement).value as typeof this._deliveryMode; }}
            >
              ${this._payloadKind === "delivery"
                ? nothing
                : html`<option value="none" ?selected=${this._deliveryMode === "none"}>None (local only)</option>`}
              ${deliveryTarget
                ? html`<option value="existing" ?selected=${this._deliveryMode === "existing"}>Keep exact target</option>`
                : nothing}
            </select>
          </div>
          ${this._deliveryMode === "existing" && deliveryTarget ? html`
            <div class="field">
              <label>Current target</label>
              <span style="font-size:var(--ic-text-sm);color:var(--ic-text-dim)">${deliveryTarget.destinationEndpoint.channelType}:${deliveryTarget.destinationEndpoint.conversationId}</span>
            </div>
          ` : nothing}

          <!-- Wake-gate (optional) -->
          ${this._payloadKind === "agent_turn" ? html`<div class="field">
            <label for="cron-wake-gate">Wake-gate script (optional)</label>
            <textarea
              id="cron-wake-gate"
              rows="4"
              .value=${this._wakeGateScript}
              placeholder=${'Runs before the model; print {"wake":false} to skip the turn, or {"wake":true,"context":"…"} with what it found.'}
              @input=${(e: InputEvent) => { this._wakeGateScript = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
          </div>` : nothing}
          ${this._payloadKind === "agent_turn" && this._wakeGateScript.trim() ? html`
            <div class="field">
              <label for="cron-wake-gate-lang">Wake-gate language</label>
              <select
                id="cron-wake-gate-lang"
                .value=${this._wakeGateLanguage}
                @change=${(e: Event) => { this._wakeGateLanguage = (e.target as HTMLSelectElement).value as "js" | "ts"; }}
              >
                <option value="js" ?selected=${this._wakeGateLanguage === "js"}>JavaScript</option>
                <option value="ts" ?selected=${this._wakeGateLanguage === "ts"}>TypeScript</option>
              </select>
            </div>
            <div class="field">
              <label for="cron-wake-gate-timeout">Wake-gate timeout seconds</label>
              <input
                id="cron-wake-gate-timeout"
                type="number"
                min="1"
                max="300"
                .value=${String(this._wakeGateTimeoutSeconds)}
                @input=${(e: InputEvent) => {
                  const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                  if (Number.isSafeInteger(value) && value >= 1 && value <= 300) {
                    this._wakeGateTimeoutSeconds = value;
                  }
                }}
              />
            </div>
          ` : nothing}

          <!-- Next 5 runs preview -->
          <div class="next-runs">
            <h3>Next 5 runs</h3>
            ${this._nextRuns.length > 0
              ? html`
                <ul>
                  ${this._nextRuns.map((r) => html`<li>${r}</li>`)}
                </ul>
              `
              : html`<p class="empty-msg">Enter a valid schedule</p>`}
          </div>
        </div>

        <!-- Buttons -->
        <div class="button-row">
          <button class="btn btn-cancel" @click=${this._onCancel}>Cancel</button>
          <button class="btn btn-save" @click=${this._onSave}>Save</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-cron-editor": IcCronEditor;
  }
}
