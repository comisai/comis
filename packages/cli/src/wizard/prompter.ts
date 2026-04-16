/**
 * WizardPrompter interface -- the testable abstraction for all wizard prompts.
 *
 * This interface decouples wizard step logic from the underlying prompt
 * library (@clack/prompts). Steps accept a WizardPrompter and call its
 * methods, enabling unit tests with a mock prompter that returns
 * scripted values without user interaction.
 *
 * @module
 */

// ---------- Option Types ----------

/** Options for a single-select prompt. */
export type SelectOpts<T> = {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
};

/** Options for a multi-select prompt. */
export type MultiselectOpts<T> = {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  required?: boolean;
  initialValues?: T[];
};

/** Options for a text input prompt. */
export type TextOpts = {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
  /** When true, wrapWithSkip will not add "leave empty to skip" behavior. */
  required?: boolean;
};

/** Options for a password input prompt. */
export type PasswordOpts = {
  message: string;
  validate?: (value: string) => string | undefined;
};

/** Options for a yes/no confirmation prompt. */
export type ConfirmOpts = {
  message: string;
  initialValue?: boolean;
};

/** Spinner handle for async operations with progress feedback. */
export type Spinner = {
  start(msg: string): void;
  update(msg: string): void;
  stop(msg: string): void;
};

// ---------- Prompter Interface ----------

/**
 * Testable prompt abstraction for the wizard.
 *
 * All wizard steps interact with the user exclusively through this
 * interface. The production implementation delegates to @clack/prompts;
 * test implementations return scripted values.
 */
export interface WizardPrompter {
  /** Display a branded intro banner. */
  intro(title: string): void;

  /** Display a closing message. */
  outro(message: string): void;

  /** Display an informational note (synchronous). */
  note(message: string, title?: string): void;

  /** Prompt the user to select one option. */
  select<T>(opts: SelectOpts<T>): Promise<T>;

  /** Prompt the user to select multiple options. */
  multiselect<T>(opts: MultiselectOpts<T>): Promise<T[]>;

  /** Prompt the user for text input. */
  text(opts: TextOpts): Promise<string>;

  /** Prompt the user for a password (masked input). */
  password(opts: PasswordOpts): Promise<string>;

  /** Prompt the user for a yes/no confirmation. */
  confirm(opts: ConfirmOpts): Promise<boolean>;

  /** Create a spinner for async operation feedback. */
  spinner(): Spinner;

  /**
   * Execute a group of prompts in sequence, collecting results.
   *
   * If any prompt in the group is cancelled, a CancelError is thrown.
   */
  group<T extends Record<string, unknown>>(
    steps: { [K in keyof T]: () => Promise<T[K]> },
  ): Promise<T>;

  /** Structured logging methods for wizard output. */
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    success(msg: string): void;
  };
}

// ---------- CancelError ----------

/**
 * Thrown when the user cancels a prompt (Ctrl+C or Esc).
 *
 * Steps should let this propagate up to the wizard runner,
 * which handles graceful cleanup and exit.
 */
export class CancelError extends Error {
  /**
   * When true, the user explicitly selected a "Cancel" option
   * (as opposed to pressing Escape). Explicit cancels always
   * exit the wizard immediately.
   */
  readonly explicit: boolean;

  constructor(explicit = false) {
    super("User cancelled");
    this.name = "CancelError";
    this.explicit = explicit;
  }
}

// ---------- SkipError ----------

/**
 * Thrown when the user chooses to skip a wizard step.
 *
 * Propagates to the wizard runner which marks the step complete
 * without modifying state, preserving any existing values.
 */
export class SkipError extends Error {
  constructor() {
    super("User skipped step");
    this.name = "SkipError";
  }
}
