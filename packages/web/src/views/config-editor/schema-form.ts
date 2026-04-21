// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

// Side-effect imports for sub-components used in template
import "../../components/form/ic-toggle.js";
import "../../components/form/ic-select.js";
import "../../components/form/ic-array-editor.js";
import "../../components/feedback/ic-empty-state.js";

/** JSON Schema type definition for rendering. */
export interface SchemaProperty {
  type?: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  required?: string[];
  default?: unknown;
  anyOf?: SchemaProperty[];
  oneOf?: SchemaProperty[];
  allOf?: SchemaProperty[];
  additionalProperties?: boolean | SchemaProperty;
}

/** Known gateway token scopes shown as toggleable chips. */
const KNOWN_SCOPES = ["rpc", "ws", "admin", "api", "*"] as const;

/** Convert camelCase to Title Case. */
function toTitleCase(str: string): string {
  return str
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** Get a nested value from an object by dot-path. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a nested value in an object by dot-path. Returns a new object (shallow clones). */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".");
  if (parts.length === 1) {
    return { ...obj, [parts[0]]: value };
  }
  const [head, ...rest] = parts;
  const child = (obj[head] ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: setNestedValue(child, rest.join("."), value) };
}

/**
 * Schema-driven form rendering sub-component.
 * Renders form fields based on JSON Schema and config data.
 *
 * @fires field-change - Dispatched with { path, value } when a field is changed
 */
@customElement("ic-schema-form")
export class IcSchemaForm extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-sm);
      }

      .form-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .form-description {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .form-input {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .form-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .form-textarea {
        width: 100%;
        min-height: 100px;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        resize: vertical;
      }

      .form-textarea:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .form-error {
        font-size: var(--ic-text-xs);
        color: var(--ic-error);
      }

      .form-fieldset {
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        margin-bottom: var(--ic-space-sm);
      }

      .form-fieldset-legend {
        cursor: pointer;
        user-select: none;
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .form-fieldset-content {
        padding-top: var(--ic-space-sm);
      }

      .arrow {
        font-size: var(--ic-text-xs);
        transition: transform 0.15s;
        display: inline-block;
      }

      .arrow[data-expanded] {
        transform: rotate(90deg);
      }

      .array-cards {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .array-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
      }

      .array-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-xs);
      }

      .array-card-index {
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-muted);
      }

      .array-card-remove {
        background: none;
        border: none;
        cursor: pointer;
        font-size: var(--ic-text-base);
        color: var(--ic-text-dim);
        padding: 0;
        line-height: 1;
      }

      .array-card-remove:hover {
        color: var(--ic-error);
      }

      .array-card-fields {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .array-add-btn {
        align-self: flex-start;
        padding: 0.4rem 1rem;
        background: var(--ic-surface-2);
        border: 1px dashed var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        margin-top: var(--ic-space-xs);
      }

      .array-add-btn:hover {
        border-color: var(--ic-accent);
        color: var(--ic-accent);
      }

      .scope-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }

      .scope-chip {
        padding: 0.25rem 0.75rem;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--ic-transition);
        border: 1px solid var(--ic-border);
        background: var(--ic-surface-2);
        color: var(--ic-text-dim);
      }

      .scope-chip:hover {
        border-color: var(--ic-accent);
      }

      .scope-chip[data-active] {
        background: var(--ic-accent);
        border-color: var(--ic-accent);
        color: #fff;
      }

      .json-fallback-textarea {
        width: 100%;
        min-height: 60px;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs);
        resize: vertical;
        tab-size: 2;
      }

      .json-fallback-textarea:focus {
        outline: none;
        border-color: var(--ic-accent);
      }
    `,
  ];

  @property({ attribute: false }) schema: Record<string, SchemaProperty> = {};
  @property({ attribute: false }) config: Record<string, unknown> = {};
  @property({ type: String }) sectionKey = "";

  @state() private _formState: Record<string, unknown> = {};
  @state() private _formErrors: Record<string, string> = {};
  @state() private _expandedFormPaths = new Set<string>();

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("config")) {
      this._formState = structuredClone(this.config) as Record<string, unknown>;
      this._formErrors = {};
    }
  }

  private _onFormFieldChange(path: string, value: unknown): void {
    this._formState = setNestedValue(this._formState, path, value);
    const newErrors = { ...this._formErrors };
    delete newErrors[path];
    this._formErrors = newErrors;
    this.dispatchEvent(new CustomEvent("field-change", {
      detail: { path, value, formState: this._formState },
      bubbles: true,
      composed: true,
    }));
  }

  private _validateField(path: string, value: unknown, schema: SchemaProperty): void {
    const errors = { ...this._formErrors };
    if (schema.type === "string" && typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors[path] = `Minimum length is ${schema.minLength}`;
      } else if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors[path] = `Maximum length is ${schema.maxLength}`;
      } else if (schema.pattern) {
        try {
          if (!new RegExp(schema.pattern).test(value)) {
            errors[path] = `Must match pattern: ${schema.pattern}`;
          }
        } catch { /* Invalid regex in schema, skip */ }
      } else {
        delete errors[path];
      }
    } else if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors[path] = `Minimum value is ${schema.minimum}`;
      } else if (schema.maximum !== undefined && value > schema.maximum) {
        errors[path] = `Maximum value is ${schema.maximum}`;
      } else {
        delete errors[path];
      }
    } else {
      delete errors[path];
    }
    this._formErrors = errors;
  }

  private _toggleFormFieldset(path: string): void {
    const newExpanded = new Set(this._expandedFormPaths);
    if (newExpanded.has(path)) { newExpanded.delete(path); } else { newExpanded.add(path); }
    this._expandedFormPaths = newExpanded;
  }

  private _onArrayItemFieldChange(arrayPath: string, index: number, key: string, value: unknown): void {
    const current = (getNestedValue(this._formState, arrayPath) ?? []) as Array<Record<string, unknown>>;
    const updated = current.map((item, i) => i !== index ? item : { ...item, [key]: value });
    this._onFormFieldChange(arrayPath, updated);
  }

  // --- Field renderers ---

  private _renderStringField(path: string, label: string, value: string, schema: SchemaProperty) {
    const useTextarea = (schema.maxLength !== undefined && schema.maxLength > 200) ||
      path.includes("prompt") || path.includes("template");
    return html`
      <div class="form-field">
        <label class="form-label">${label}</label>
        ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
        ${useTextarea
          ? html`<textarea class="form-textarea" .value=${value}
              @input=${(e: Event) => this._onFormFieldChange(path, (e.target as HTMLTextAreaElement).value)}
              @blur=${() => this._validateField(path, value, schema)}
            ></textarea>`
          : html`<input class="form-input" type="text" .value=${value}
              @input=${(e: Event) => this._onFormFieldChange(path, (e.target as HTMLInputElement).value)}
              @blur=${() => this._validateField(path, value, schema)}
            />`}
        ${this._formErrors[path] ? html`<span class="form-error">${this._formErrors[path]}</span>` : nothing}
      </div>
    `;
  }

  private _renderNumberField(path: string, label: string, value: number, schema: SchemaProperty) {
    return html`
      <div class="form-field">
        <label class="form-label">${label}</label>
        ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
        <input class="form-input" type="number" .value=${String(value)}
          min=${schema.minimum ?? nothing} max=${schema.maximum ?? nothing}
          @input=${(e: Event) => { const val = parseFloat((e.target as HTMLInputElement).value); if (!isNaN(val)) this._onFormFieldChange(path, val); }}
          @blur=${() => this._validateField(path, value, schema)}
        />
        ${this._formErrors[path] ? html`<span class="form-error">${this._formErrors[path]}</span>` : nothing}
      </div>
    `;
  }

  private _renderBooleanField(path: string, label: string, value: boolean, schema: SchemaProperty) {
    return html`
      <div class="form-field">
        ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
        <ic-toggle label=${label} .checked=${value}
          @change=${(e: CustomEvent<boolean>) => this._onFormFieldChange(path, e.detail)}
        ></ic-toggle>
      </div>
    `;
  }

  private _renderEnumField(path: string, label: string, value: unknown, schema: SchemaProperty) {
    const options = (schema.enum ?? []).map((v) => ({ value: String(v), label: String(v) }));
    return html`
      <div class="form-field">
        ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
        <ic-select label=${label} .value=${String(value ?? "")} .options=${options}
          @change=${(e: CustomEvent<string>) => this._onFormFieldChange(path, e.detail)}
        ></ic-select>
      </div>
    `;
  }

  private _renderArrayField(path: string, label: string, value: unknown[], schema: SchemaProperty) {
    if (schema.items?.type === "string") {
      return html`
        <div class="form-field">
          ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
          <ic-array-editor label=${label} .items=${(value ?? []).map(String)} placeholder="Add item..."
            @change=${(e: CustomEvent<string[]>) => { this._onFormFieldChange(path, e.detail); }}
          ></ic-array-editor>
        </div>
      `;
    }
    if (schema.items?.type === "object" && schema.items.properties) {
      return this._renderArrayOfObjectsField(path, label, value, schema);
    }
    return this._renderJsonFallback(path, label, value, schema);
  }

  private _renderArrayOfObjectsField(path: string, label: string, value: unknown[], schema: SchemaProperty) {
    const items = (value ?? []) as Array<Record<string, unknown>>;
    const itemSchema = schema.items!;
    const properties = itemSchema.properties ?? {};
    const requiredFields = itemSchema.required ?? [];

    const buildDefaultItem = (): Record<string, unknown> => {
      const item: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        if (propSchema.default !== undefined) {
          item[key] = JSON.parse(JSON.stringify(propSchema.default));
        } else if (propSchema.type === "string") { item[key] = "";
        } else if (propSchema.type === "number" || propSchema.type === "integer") { item[key] = 0;
        } else if (propSchema.type === "boolean") { item[key] = false;
        } else if (propSchema.type === "array") { item[key] = [];
        } else if (propSchema.type === "object") { item[key] = {}; }
      }
      return item;
    };

    return html`
      <div class="form-field">
        <label class="form-label">${label}</label>
        ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
        <div class="array-cards">
          ${items.map((item, idx) => this._renderArrayObjectCard(path, idx, item, properties, requiredFields))}
        </div>
        <button class="array-add-btn"
          @click=${() => { this._onFormFieldChange(path, [...items, buildDefaultItem()]); }}
        >+ Add</button>
      </div>
    `;
  }

  private _renderArrayObjectCard(
    arrayPath: string, index: number, item: Record<string, unknown>,
    properties: Record<string, SchemaProperty>, requiredFields: string[],
  ) {
    return html`
      <div class="array-card">
        <div class="array-card-header">
          <span class="array-card-index">#${index + 1}</span>
          <button class="array-card-remove" title="Remove"
            @click=${() => {
              const current = (getNestedValue(this._formState, arrayPath) ?? []) as unknown[];
              this._onFormFieldChange(arrayPath, current.filter((_, i) => i !== index));
            }}
          >\u00d7</button>
        </div>
        <div class="array-card-fields">
          ${Object.entries(properties).map(([key, propSchema]) => {
            const fieldLabel = `${toTitleCase(key)}${requiredFields.includes(key) ? " *" : ""}`;
            const fieldValue = item[key];

            if (key === "secret") {
              return html`
                <div class="form-field">
                  <label class="form-label">${fieldLabel}</label>
                  <input type="password" class="form-input"
                    .value=${typeof fieldValue === "string" ? fieldValue : ""}
                    placeholder="env:VAR_NAME or min 32 chars"
                    @input=${(e: Event) => { this._onArrayItemFieldChange(arrayPath, index, key, (e.target as HTMLInputElement).value); }}
                  />
                </div>
              `;
            }

            if (propSchema.type === "array" && propSchema.items?.type === "string") {
              if (key === "scopes") {
                const active = new Set(((fieldValue ?? []) as unknown[]).map(String));
                return html`
                  <div class="form-field">
                    <label class="form-label">${fieldLabel}</label>
                    <div class="scope-chips">
                      ${KNOWN_SCOPES.map((scope) => html`
                        <button class="scope-chip" ?data-active=${active.has(scope)}
                          @click=${() => {
                            const next = new Set(active);
                            if (next.has(scope)) next.delete(scope); else next.add(scope);
                            this._onArrayItemFieldChange(arrayPath, index, key, [...next]);
                          }}
                        >${scope}</button>
                      `)}
                    </div>
                  </div>
                `;
              }
              return html`
                <div class="form-field">
                  <ic-array-editor label=${fieldLabel} .items=${((fieldValue ?? []) as unknown[]).map(String)} placeholder="Add..."
                    @change=${(e: CustomEvent<string[]>) => { this._onArrayItemFieldChange(arrayPath, index, key, e.detail); }}
                  ></ic-array-editor>
                </div>
              `;
            }

            if (propSchema.type === "string") {
              return html`
                <div class="form-field">
                  <label class="form-label">${fieldLabel}</label>
                  <input type="text" class="form-input" .value=${String(fieldValue ?? "")}
                    @input=${(e: Event) => { this._onArrayItemFieldChange(arrayPath, index, key, (e.target as HTMLInputElement).value); }}
                  />
                </div>
              `;
            }

            if (propSchema.type === "number" || propSchema.type === "integer") {
              return html`
                <div class="form-field">
                  <label class="form-label">${fieldLabel}</label>
                  <input type="number" class="form-input" .value=${String(fieldValue ?? 0)}
                    @input=${(e: Event) => { this._onArrayItemFieldChange(arrayPath, index, key, Number((e.target as HTMLInputElement).value)); }}
                  />
                </div>
              `;
            }

            if (propSchema.type === "boolean") {
              return html`
                <div class="form-field">
                  <label class="form-label">${fieldLabel}</label>
                  <ic-toggle ?checked=${Boolean(fieldValue)}
                    @change=${(e: CustomEvent<boolean>) => { this._onArrayItemFieldChange(arrayPath, index, key, e.detail); }}
                  ></ic-toggle>
                </div>
              `;
            }

            return html`
              <div class="form-field">
                <label class="form-label">${fieldLabel}</label>
                <input type="text" class="form-input" .value=${JSON.stringify(fieldValue ?? "")}
                  @input=${(e: Event) => {
                    try { this._onArrayItemFieldChange(arrayPath, index, key, JSON.parse((e.target as HTMLInputElement).value)); } catch { /* ignore parse errors */ }
                  }}
                />
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  private _renderObjectField(path: string, label: string, value: Record<string, unknown>, schema: SchemaProperty) {
    const isExpanded = this._expandedFormPaths.has(path);
    const properties = schema.properties ?? {};
    const requiredFields = schema.required ?? [];
    return html`
      <fieldset class="form-fieldset">
        <legend class="form-fieldset-legend" @click=${() => this._toggleFormFieldset(path)}>
          <span class="arrow" ?data-expanded=${isExpanded}>\u25B6</span>
          ${label}
        </legend>
        ${isExpanded
          ? html`
              <div class="form-fieldset-content">
                ${Object.entries(properties).map(([key, propSchema]) =>
                  this._renderSchemaField(
                    `${path}.${key}`,
                    `${toTitleCase(key)}${requiredFields.includes(key) ? " *" : ""}`,
                    getNestedValue(value ?? {}, key),
                    propSchema,
                  ),
                )}
              </div>
            `
          : nothing}
      </fieldset>
    `;
  }

  private _renderJsonFallback(path: string, label: string, value: unknown, schema: SchemaProperty) {
    const jsonStr = JSON.stringify(value ?? null, null, 2);
    return html`
      <div class="form-field">
        <label class="form-label">${label}</label>
        ${schema.description ? html`<span class="form-description">${schema.description}</span>` : nothing}
        <textarea class="json-fallback-textarea" .value=${jsonStr}
          @input=${(e: Event) => {
            const text = (e.target as HTMLTextAreaElement).value;
            try {
              const parsed = JSON.parse(text);
              this._onFormFieldChange(path, parsed);
              const newErrors = { ...this._formErrors }; delete newErrors[path]; this._formErrors = newErrors;
            } catch { this._formErrors = { ...this._formErrors, [path]: "Invalid JSON" }; }
          }}
        ></textarea>
        ${this._formErrors[path] ? html`<span class="form-error">${this._formErrors[path]}</span>` : nothing}
      </div>
    `;
  }

  /** Dispatch to the appropriate field renderer based on schema type. */
  private _renderSchemaField(path: string, label: string, value: unknown, schema: SchemaProperty): unknown {
    if (schema.enum && schema.enum.length > 0) {
      return this._renderEnumField(path, label, value, schema);
    }

    const union = schema.anyOf ?? schema.oneOf;
    if (union && union.length >= 2) {
      const nonNull = union.filter((s) => s.type !== "null");
      if (nonNull.length === 1) {
        return this._renderSchemaField(path, label, value, nonNull[0]);
      }
      if (value === null || value === undefined || typeof value === "string") {
        const strVariant = nonNull.find((s) => s.type === "string");
        if (strVariant) {
          return this._renderStringField(path, label, String(value ?? ""), strVariant);
        }
      }
    }

    if (schema.anyOf || schema.oneOf || schema.allOf) {
      return this._renderJsonFallback(path, label, value, schema);
    }

    switch (schema.type) {
      case "string":
        return this._renderStringField(path, label, String(value ?? ""), schema);
      case "number":
      case "integer":
        return this._renderNumberField(path, label, Number(value ?? 0), schema);
      case "boolean":
        return this._renderBooleanField(path, label, Boolean(value), schema);
      case "array":
        return this._renderArrayField(path, label, (value ?? []) as unknown[], schema);
      case "object":
        return this._renderObjectField(path, label, (value ?? {}) as Record<string, unknown>, schema);
      default:
        return this._renderJsonFallback(path, label, value, schema);
    }
  }

  override render() {
    const sectionSchema = this.schema;

    // Handle record/map types (e.g., agents) that use additionalProperties
    if (sectionSchema && !sectionSchema.properties && (sectionSchema as SchemaProperty).additionalProperties &&
        typeof (sectionSchema as SchemaProperty).additionalProperties === "object") {
      const entrySchema = (sectionSchema as SchemaProperty).additionalProperties as SchemaProperty;
      const entries = Object.keys(this._formState);
      if (entries.length === 0) {
        return html`<ic-empty-state icon="config" message="No entries" description="This section has no configured entries."></ic-empty-state>`;
      }
      return html`
        ${entries.map((key) => {
          const entryValue = (this._formState[key] ?? {}) as Record<string, unknown>;
          return this._renderObjectField(key, toTitleCase(key), entryValue, entrySchema);
        })}
      `;
    }

    // Standard schema with properties
    if (!sectionSchema || !sectionSchema.properties) {
      // No schema -- render form state keys as simple fields
      return html`
        ${Object.entries(this._formState).map(([key, val]) =>
          this._renderSchemaField(key, toTitleCase(key), val, { type: typeof val === "boolean" ? "boolean" : typeof val === "number" ? "number" : "string" }),
        )}
      `;
    }

    const properties = sectionSchema.properties;
    const requiredFields = (sectionSchema as SchemaProperty).required ?? [];

    return html`
      ${Object.entries(properties).map(([key, propSchema]) =>
        this._renderSchemaField(
          key,
          `${toTitleCase(key)}${requiredFields.includes(key) ? " *" : ""}`,
          getNestedValue(this._formState, key),
          propSchema,
        ),
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-schema-form": IcSchemaForm;
  }
}
