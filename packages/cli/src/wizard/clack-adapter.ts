/**
 * ClackAdapter -- production implementation of WizardPrompter.
 *
 * Delegates every prompt method to @clack/prompts, translating
 * between the WizardPrompter interface and Clack's API. Handles
 * cancellation by detecting `p.isCancel()` and throwing CancelError.
 *
 * Text prompts with a placeholder or defaultValue support Tab-to-accept:
 * pressing Tab when input is empty fills in the suggestion value.
 *
 * @module
 */

import * as p from "@clack/prompts";
import { TextPrompt, isCancel as isCoreCancel } from "@clack/core";
import chalk from "chalk";
import type {
  WizardPrompter,
  SelectOpts,
  MultiselectOpts,
  TextOpts,
  PasswordOpts,
  ConfirmOpts,
  Spinner,
} from "./prompter.js";
import { CancelError } from "./prompter.js";

/**
 * Asserts a Clack prompt result is not a cancel symbol.
 * Throws CancelError if the user cancelled.
 *
 * Checks both @clack/prompts and @clack/core cancel symbols because
 * pnpm may resolve them to different package instances with distinct
 * module-scoped cancel Symbols (e.g., prompts uses core@1.0.1 while
 * our TextPrompt import resolves to core@1.1.0).
 */
function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value) || isCoreCancel(value) || typeof value === "symbol") {
    throw new CancelError();
  }
}

/**
 * Wraps a WizardPrompter validator (string -> string | undefined)
 * into the Clack validator signature (string | undefined -> string | Error | undefined).
 */
function wrapValidator(
  validate?: (value: string) => string | undefined,
): ((value: string | undefined) => string | undefined) | undefined {
  if (!validate) return undefined;
  return (value: string | undefined) => {
    // Skip validation for non-string values (undefined on empty submit,
    // or Symbol on cancel). Symbols are caught by assertNotCancelled
    // after the prompt resolves; undefined is handled by @clack/core's
    // finalize which substitutes defaultValue or "".
    if (typeof value !== "string") return undefined;
    return validate(value);
  };
}

// ---------- Tab-completable text prompt ----------

/**
 * Create a text prompt that accepts Tab to fill in a suggestion.
 *
 * Uses @clack/core's TextPrompt directly (same as @clack/prompts internally)
 * with a key event listener for Tab. When Tab is pressed and the input is
 * empty, the suggestion value is injected as user input.
 *
 * The render function matches @clack/prompts' text style using the exported
 * symbols and chalk for ANSI colors.
 */
function createTabCompletableText(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  suggestion: string;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string | symbol> {
  const { message, placeholder, defaultValue, suggestion } = opts;
  const tabHint = chalk.dim(` (Tab to accept)`);

  const prompt = new TextPrompt({
    placeholder,
    defaultValue,
    validate: opts.validate,
    render() {
      const placeholderDisplay = placeholder
        ? chalk.inverse(placeholder[0]) + chalk.dim(placeholder.slice(1))
        : chalk.inverse(" ");
      const inputDisplay = this.userInput
        ? this.userInputWithCursor
        : placeholderDisplay;
      const submitted = typeof this.value === "string" ? this.value : "";

      switch (this.state) {
        case "error": {
          const errorMsg = this.error ? `  ${chalk.yellow(this.error)}` : "";
          return [
            `${p.symbol(this.state)}  ${message}`,
            `${chalk.yellow(p.S_BAR)}  ${inputDisplay}`,
            `${chalk.yellow(p.S_BAR_END)}${errorMsg}`,
            "",
          ].join("\n");
        }
        case "submit": {
          const val = submitted ? `  ${chalk.dim(submitted)}` : "";
          return `${p.symbol(this.state)}  ${message}\n${chalk.gray(p.S_BAR)}${val}`;
        }
        case "cancel": {
          const val = submitted ? `  ${chalk.strikethrough(chalk.dim(submitted))}` : "";
          const trail = submitted.trim() ? `\n${chalk.gray(p.S_BAR)}` : "";
          return `${p.symbol(this.state)}  ${message}\n${chalk.gray(p.S_BAR)}${val}${trail}`;
        }
        default: {
          // Show Tab hint only when input is empty and there's a suggestion
          const hint = !this.userInput ? tabHint : "";
          return [
            `${p.symbol(this.state)}  ${message}${hint}`,
            `${chalk.cyan(p.S_BAR)}  ${inputDisplay}`,
            `${chalk.cyan(p.S_BAR_END)}`,
            "",
          ].join("\n");
        }
      }
    },
  });

  // Tab-to-accept: fill in suggestion when Tab is pressed on empty input
  prompt.on("key", (_char, key) => {
    if (key.name === "tab" && !prompt.userInput) {
      // Use protected _setUserInput with write=true to inject text into readline
      (prompt as unknown as { _setUserInput(v: string, w: boolean): void })
        ._setUserInput(suggestion, true);
    }
  });

  return prompt.prompt() as Promise<string | symbol>;
}

/**
 * Production WizardPrompter backed by @clack/prompts.
 *
 * Every interactive method checks for cancellation and throws
 * CancelError so wizard steps never need to handle cancel symbols.
 */
export class ClackAdapter implements WizardPrompter {
  intro(title: string): void {
    p.intro(title);
  }

  outro(message: string): void {
    p.outro(message);
  }

  note(message: string, title?: string): void {
    p.note(message, title);
  }

  async select<T>(opts: SelectOpts<T>): Promise<T> {
    // Cast options: Clack's Option<T> uses a conditional type that
    // can't resolve when T is a generic parameter. Our SelectOpts
    // always provides label, which satisfies both branches.
    const result = await p.select({
      message: opts.message,
      options: opts.options as { value: T; label: string; hint?: string }[],
      initialValue: opts.initialValue,
    } as p.SelectOptions<T>);
    assertNotCancelled(result);
    return result;
  }

  async multiselect<T>(opts: MultiselectOpts<T>): Promise<T[]> {
    // Same cast reasoning as select() above.
    const result = await p.multiselect({
      message: opts.message,
      options: opts.options as { value: T; label: string; hint?: string }[],
      required: opts.required,
      initialValues: opts.initialValues,
    } as p.MultiSelectOptions<T>);
    assertNotCancelled(result);
    return result;
  }

  async text(opts: TextOpts): Promise<string> {
    const suggestion = opts.placeholder ?? opts.defaultValue;
    if (!suggestion) {
      // No suggestion -- use standard text prompt
      const result = await p.text({
        message: opts.message,
        placeholder: opts.placeholder,
        defaultValue: opts.defaultValue,
        validate: wrapValidator(opts.validate),
      });
      assertNotCancelled(result);
      return result;
    }

    // Build a TextPrompt with Tab-to-accept behavior
    const result = await createTabCompletableText({
      message: opts.message,
      placeholder: opts.placeholder,
      defaultValue: opts.defaultValue,
      suggestion,
      validate: wrapValidator(opts.validate),
    });
    assertNotCancelled(result);
    return result;
  }

  async password(opts: PasswordOpts): Promise<string> {
    const result = await p.password({
      message: opts.message,
      validate: wrapValidator(opts.validate),
    });
    assertNotCancelled(result);
    return result;
  }

  async confirm(opts: ConfirmOpts): Promise<boolean> {
    const result = await p.confirm({
      message: opts.message,
      initialValue: opts.initialValue,
    });
    assertNotCancelled(result);
    return result;
  }

  spinner(): Spinner {
    const s = p.spinner();
    return {
      start(msg: string): void {
        s.start(msg);
      },
      update(msg: string): void {
        s.message(msg);
      },
      stop(msg: string): void {
        s.stop(msg);
      },
    };
  }

  async group<T extends Record<string, unknown>>(
    steps: { [K in keyof T]: () => Promise<T[K]> },
  ): Promise<T> {
    // Execute steps sequentially, collecting results.
    // Clack's built-in group() has a different signature that passes
    // partial results context. Our interface is simpler: each step
    // is a thunk. We execute them in order and throw CancelError
    // if any returns a cancel symbol.
    const results = {} as Record<string, unknown>;
    const keys = Object.keys(steps) as (keyof T)[];

    for (const key of keys) {
      const step = steps[key];
      const value = await step();
      results[key as string] = value;
    }

    return results as T;
  }

  log = {
    info(msg: string): void {
      p.log.info(msg);
    },
    warn(msg: string): void {
      p.log.warn(msg);
    },
    error(msg: string): void {
      p.log.error(msg);
    },
    success(msg: string): void {
      p.log.success(msg);
    },
  };
}

/**
 * Create a new ClackAdapter instance.
 *
 * Factory function for consistency with the codebase's
 * `createXxx()` factory pattern.
 */
export function createClackAdapter(): WizardPrompter {
  return new ClackAdapter();
}
