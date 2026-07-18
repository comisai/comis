// SPDX-License-Identifier: Apache-2.0
/** Bounded repair for final responses that drift from the current-turn script. */

import {
  dominantScript,
  type ClockPort,
  type ComisLogger,
  type ScriptClass,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface ResponseLanguageRepairInput {
  requestText: string;
  response: string;
  languageDirectiveActive: boolean;
  continueTurn: (instruction: string) => Promise<Result<unknown, Error>>;
  readLatestResponse: () => string;
  logger: ComisLogger;
  clock: ClockPort;
}

export interface ResponseLanguageRepairOutcome {
  response: string;
  attempted: boolean;
  repaired: boolean;
}

export type ResponseLanguageRepairError =
  | {
      kind: "followup_failed";
      expectedScript: ScriptClass;
      actualScript: ScriptClass;
      cause: Error;
    }
  | {
      kind: "response_read_failed";
      expectedScript: ScriptClass;
      actualScript: ScriptClass;
      cause: Error;
    }
  | {
      kind: "repair_still_mismatched";
      expectedScript: ScriptClass;
      actualScript: ScriptClass;
    };

/** Human-readable script name for the model directive. */
function scriptName(script: ScriptClass): string {
  switch (script) {
    case "latin": return "Latin";
    case "cyrillic": return "Cyrillic";
    case "hebrew": return "Hebrew";
    case "arabic": return "Arabic";
    case "cjk": return "CJK";
    case "thai": return "Thai";
    case "greek": return "Greek";
    case "devanagari": return "Devanagari";
    case "other": return "Other";
    default: {
      const _exhaustive: never = script;
      return _exhaustive;
    }
  }
}

function repairDirective(expectedScript: ScriptClass, responseScript: ScriptClass): string {
  return "Rewrite only your immediately preceding final answer. Preserve its meaning, factual content, "
    + "concrete alternatives, identifiers, and URLs. Use exclusively the language in which the user wrote "
    + "the current request. A requested translation target is not the reply language when the translation "
    + `must be refused. The prior answer used ${scriptName(responseScript)} script; the current request uses `
    + `${scriptName(expectedScript)} script. Do not use ${scriptName(responseScript)} script except for necessary `
    + "identifiers or verbatim proper nouns. Omit profile names from another script. Return only the replacement "
    + "final answer.";
}

/**
 * Make at most one model call when the response's dominant script conflicts
 * with the current-turn language directive.
 */
export async function repairResponseLanguageDrift(
  input: ResponseLanguageRepairInput,
): Promise<Result<ResponseLanguageRepairOutcome, ResponseLanguageRepairError>> {
  if (!input.languageDirectiveActive || input.response.trim().length === 0) {
    return ok({ response: input.response, attempted: false, repaired: false });
  }

  const expectedScript = dominantScript(input.requestText);
  const responseScript = dominantScript(input.response);
  if (expectedScript === responseScript || expectedScript === "other" || responseScript === "other") {
    return ok({ response: input.response, attempted: false, repaired: false });
  }

  const startedAt = input.clock.now();
  input.logger.debug(
    { expectedScript, responseScript, step: "response-language-repair" },
    "Response language drift detected",
  );
  const continuationResult = await input.continueTurn(repairDirective(expectedScript, responseScript));
  if (!continuationResult.ok) {
    return err({
      kind: "followup_failed",
      expectedScript,
      actualScript: responseScript,
      cause: continuationResult.error,
    });
  }

  const latestResult = tryCatch(input.readLatestResponse);
  if (!latestResult.ok) {
    return err({
      kind: "response_read_failed",
      expectedScript,
      actualScript: responseScript,
      cause: latestResult.error,
    });
  }
  const actualScript = dominantScript(latestResult.value);
  if (latestResult.value.trim().length === 0 || actualScript !== expectedScript) {
    return err({ kind: "repair_still_mismatched", expectedScript, actualScript });
  }

  input.logger.info(
    {
      expectedScript,
      responseScript,
      durationMs: input.clock.now() - startedAt,
      step: "response-language-repair",
    },
    "Response language repair complete",
  );
  return ok({ response: latestResult.value, attempted: true, repaired: true });
}
