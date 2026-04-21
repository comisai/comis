// SPDX-License-Identifier: Apache-2.0
/**
 * Budget section sub-editor for agent configuration.
 *
 * Renders: Per Execution, Per Hour, Per Day token budget fields.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField } from "./editor-helpers.js";
import type { EditorForm, FieldChangeDetail } from "./editor-types.js";

@customElement("ic-agent-budget-editor")
export class IcAgentBudgetEditor extends LitElement {
  static override styles = css`
    :host { display: block; }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: var(--ic-space-md);
    }

    .field label {
      font-size: var(--ic-text-xs);
      color: var(--ic-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .field input {
      background: var(--ic-surface-2);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      padding: var(--ic-space-sm) var(--ic-space-md);
      color: var(--ic-text);
      font-family: inherit;
      font-size: var(--ic-text-sm);
      outline: none;
      transition: border-color var(--ic-transition);
    }

    .field input:focus {
      border-color: var(--ic-accent);
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ic-space-md);
    }

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) form: EditorForm = {};

  private _onChange = (key: string, value: unknown): void => {
    this.dispatchEvent(
      new CustomEvent<FieldChangeDetail>("field-change", {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    return html`
      <div class="field-row">
        ${renderNumberField(this.form, "budgets.perExecution", "Per Execution (tokens)", this._onChange, { id: "field-budgets-perExecution", placeholder: "2000000" })}
        ${renderNumberField(this.form, "budgets.perHour", "Per Hour (tokens)", this._onChange, { id: "field-budgets-perHour", placeholder: "10000000" })}
      </div>
      ${renderNumberField(this.form, "budgets.perDay", "Per Day (tokens)", this._onChange, { id: "field-budgets-perDay", placeholder: "100000000" })}
    `;
  }
}
