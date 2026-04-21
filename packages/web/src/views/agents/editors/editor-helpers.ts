// SPDX-License-Identifier: Apache-2.0
/**
 * Shared render helper functions for agent editor sub-components.
 *
 * Each function renders a form field using the same CSS class names as
 * the original agent-editor.ts so existing styles apply unchanged.
 * Instead of referencing `this._getField`/`this._updateField`, each
 * receives `form`, `key`, and an `onChange` callback.
 */
import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import type { EditorForm } from "./editor-types.js";

/** Get a form field value with a default fallback. */
export function getField<T>(form: EditorForm, key: string, defaultValue: T): T {
  const val = form[key];
  return (val !== undefined && val !== null ? val : defaultValue) as T;
}

/** Render a numeric input field. */
export function renderNumberField(
  form: EditorForm,
  key: string,
  label: string,
  onChange: (key: string, value: unknown) => void,
  opts?: { id?: string; step?: string; min?: string; max?: string; placeholder?: string },
): TemplateResult {
  const val = getField<string | number | undefined>(form, key, undefined);
  const step = opts?.step ?? "1";
  const decimals = step.includes(".") ? step.split(".")[1].length : 0;
  const displayVal = val !== undefined ? (decimals > 0 ? Number(Number(val).toFixed(decimals)) : val).toString() : "";
  const id = opts?.id ?? `field-${key.replace(/\./g, "-")}`;
  return html`
    <div class="field">
      <label for=${id}>${label}</label>
      <input
        id=${id}
        type="number"
        .value=${displayVal}
        step=${step}
        min=${opts?.min ?? ""}
        max=${opts?.max ?? ""}
        placeholder=${opts?.placeholder ?? ""}
        @input=${(e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          onChange(key, v === "" ? undefined : Number(v));
        }}
      />
    </div>
  `;
}

/** Render a text input field. */
export function renderTextField(
  form: EditorForm,
  key: string,
  label: string,
  onChange: (key: string, value: unknown) => void,
  opts?: { id?: string; readonly?: boolean; placeholder?: string },
): TemplateResult {
  const id = opts?.id ?? `field-${key.replace(/\./g, "-")}`;
  return html`
    <div class="field">
      <label for=${id}>${label}</label>
      <input
        id=${id}
        type="text"
        .value=${getField(form, key, "")}
        ?readonly=${opts?.readonly}
        placeholder=${opts?.placeholder ?? ""}
        @input=${(e: Event) => onChange(key, (e.target as HTMLInputElement).value)}
      />
    </div>
  `;
}

/** Render a textarea field. */
export function renderTextarea(
  form: EditorForm,
  key: string,
  label: string,
  onChange: (key: string, value: unknown) => void,
  opts?: { id?: string; placeholder?: string },
): TemplateResult {
  const id = opts?.id ?? `field-${key.replace(/\./g, "-")}`;
  return html`
    <div class="field">
      <label for=${id}>${label}</label>
      <textarea
        id=${id}
        .value=${getField(form, key, "")}
        placeholder=${opts?.placeholder ?? ""}
        @input=${(e: Event) => onChange(key, (e.target as HTMLTextAreaElement).value)}
      ></textarea>
    </div>
  `;
}

/** Render a select dropdown field. */
export function renderSelectField(
  form: EditorForm,
  key: string,
  label: string,
  options: Array<{ value: string; label: string }>,
  onChange: (key: string, value: unknown) => void,
  opts?: { id?: string },
): TemplateResult {
  const current = getField(form, key, options[0]?.value ?? "");
  const id = opts?.id ?? `field-${key.replace(/\./g, "-")}`;
  return html`
    <div class="field">
      <label for=${id}>${label}</label>
      <select
        id=${id}
        @change=${(e: Event) => onChange(key, (e.target as HTMLSelectElement).value)}
      >
        ${options.map(
          (opt) => html`<option value=${opt.value} ?selected=${current === opt.value}>${opt.label}</option>`,
        )}
      </select>
    </div>
  `;
}

/** Render a checkbox field. */
export function renderCheckbox(
  form: EditorForm,
  key: string,
  label: string,
  onChange: (key: string, value: unknown) => void,
  opts?: { id?: string },
): TemplateResult {
  const id = opts?.id ?? `field-${key.replace(/\./g, "-")}`;
  return html`
    <div class="checkbox-field">
      <input
        id=${id}
        type="checkbox"
        .checked=${Boolean(getField(form, key, false))}
        @change=${(e: Event) => onChange(key, (e.target as HTMLInputElement).checked)}
      />
      <label for=${id}>${label}</label>
    </div>
  `;
}

// Re-export nothing from lit for sub-editors that need it
export { nothing };
