// SPDX-License-Identifier: Apache-2.0
/**
 * Skills section sub-editor for agent configuration.
 *
 * Renders: Tool policy profile, discovery paths, allow/deny lists,
 * built-in tools checkbox grid.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderTextarea, renderCheckbox, getField } from "./editor-helpers.js";
import { BUILTIN_TOOLS, PROFILE_BUILTIN_TOOLS } from "./editor-types.js";
import type { EditorForm, FieldChangeDetail } from "./editor-types.js";

@customElement("ic-agent-skills-editor")
export class IcAgentSkillsEditor extends LitElement {
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

    .field select,
    .field textarea {
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

    .field select:focus,
    .field textarea:focus {
      border-color: var(--ic-accent);
    }

    .field textarea {
      min-height: 4rem;
      resize: vertical;
    }

    .checkbox-field {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--ic-space-sm);
      margin-bottom: var(--ic-space-md);
    }

    .checkbox-field label {
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
      text-transform: none;
      letter-spacing: normal;
      cursor: pointer;
    }

    .checkbox-field input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      accent-color: var(--ic-accent);
      cursor: pointer;
    }

    .checkbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
      gap: var(--ic-space-sm);
    }

    .section-title {
      font-weight: 600;
      margin-bottom: var(--ic-space-sm);
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
    }
  `;

  @property({ attribute: false }) form: EditorForm = {};

  private _emit(key: string, value: unknown): void {
    this.dispatchEvent(
      new CustomEvent<FieldChangeDetail>("field-change", {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onChange = (key: string, value: unknown): void => {
    this._emit(key, value);
  };

  private _applyProfileToBuiltinTools(profile: string): void {
    const tools = PROFILE_BUILTIN_TOOLS[profile];
    if (!tools) return;
    for (const [tool, enabled] of Object.entries(tools)) {
      this._emit(`skills.builtin.${tool}`, enabled);
    }
  }

  override render() {
    const profileOptions = [
      { value: "minimal", label: "Minimal" },
      { value: "coding", label: "Coding" },
      { value: "messaging", label: "Messaging" },
      { value: "supervisor", label: "Supervisor" },
      { value: "full", label: "Full" },
    ];
    const currentProfile = getField(this.form, "skills.toolPolicyProfile", "full") as string;

    return html`
      <div class="field">
        <label for="field-skills-profile">Tool Policy Profile</label>
        <select
          id="field-skills-profile"
          @change=${(e: Event) => {
            const profile = (e.target as HTMLSelectElement).value;
            this._emit("skills.toolPolicyProfile", profile);
            this._applyProfileToBuiltinTools(profile);
          }}
        >
          ${profileOptions.map(
            (opt) => html`<option value=${opt.value} ?selected=${currentProfile === opt.value}>${opt.label}</option>`,
          )}
        </select>
      </div>
      ${renderTextarea(this.form, "skills.discoveryPaths", "Discovery Paths (one per line)", this._onChange, { id: "field-skills-discovery", placeholder: "/skills\n/custom-skills" })}
      ${renderTextarea(this.form, "skills.allowList", "Allow List (one per line)", this._onChange, { id: "field-skills-allow", placeholder: "bash\nfile_ops" })}
      ${renderTextarea(this.form, "skills.denyList", "Deny List (one per line)", this._onChange, { id: "field-skills-deny" })}

      <div class="section-title">Built-in Tools</div>
      <div class="checkbox-grid">
        ${BUILTIN_TOOLS.map((tool) =>
          renderCheckbox(this.form, `skills.builtin.${tool}`, tool, this._onChange, { id: `field-skills-builtin-${tool}` }),
        )}
      </div>
    `;
  }
}
