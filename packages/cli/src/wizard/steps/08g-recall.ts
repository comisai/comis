// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic-memory-recall (embedding) step — step 08g of the init wizard.
 *
 * The default on-device embedder (`nomic-embed-text-v1.5`) is English-centric,
 * so on a non-Latin deployment (Hebrew, Arabic, CJK, Cyrillic) semantic recall
 * degrades to the lexical FTS floor — silently, because the embedder is the one
 * recall knob the wizard never surfaced. This step surfaces it as an informed
 * install-time choice (the cheapest moment: no memories to re-embed yet).
 *
 * Progressive disclosure — English is the no-friction default:
 *   1. "Mostly non-English?" — No (default) keeps nomic and writes nothing (the
 *      daemon default applies); the multilingual reranker (`bge-reranker-v2-m3`)
 *      is multilingual regardless.
 *   2. Yes → pick the multilingual embedder:
 *      - `local`  — on-device `bge-m3` (1024-d): private, $0, ~635MB download,
 *                   slower on CPU. Always offered (the safe default).
 *      - `openai` — `text-embedding-3-small` (1536-d): hosted, no download, but
 *                   sends memory text to OpenAI and costs per embed. Offered
 *                   ONLY when the main provider is OpenAI, so its key is already
 *                   collected (no new secret path here).
 *
 * Writes the AUTHORITATIVE `embedding.*` surface (provider + local.modelUri /
 * openai.model+dimensions + the advisory `multilingual` flag) in step 10 — NOT
 * the legacy `memory.recall.embeddingModel` field.
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import { EMBED_BGE_M3_MODEL_URI } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";

/** True when the main LLM provider is OpenAI with a collected key — so an
 *  OpenAI embedder reuses it (mirrors the 08e transcription key-reuse rule). */
function openAiKeyAvailable(state: WizardState): boolean {
  return state.provider?.id === "openai" && state.provider.apiKey !== undefined;
}

export const recallStep: WizardStep = {
  id: "recall",
  label: "Memory Recall",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Semantic Memory Recall"));

    const multilingual = await prompter.confirm({
      message:
        "Will this assistant mostly handle non-English messages (Hebrew, Arabic, CJK, Cyrillic, …)?",
      initialValue: state.recallProvider?.multilingual ?? false,
    });

    // English (default): keep the small/fast on-device nomic embedder. Write
    // nothing — the daemon default applies. The reranker stays multilingual.
    if (!multilingual) {
      prompter.log.info(
        "Keeping the default on-device English embedder (nomic-embed-text-v1.5) — small and fast.",
      );
      return updateState(state, { recallProvider: { multilingual: false, provider: "local" } });
    }

    // Multilingual: on-device bge-m3 is always available; OpenAI only when the
    // main provider already supplies the key.
    const options = [
      {
        value: "local",
        label: "On-device — bge-m3 (recommended)",
        hint: "private, $0, multilingual · ~635MB download, slower on CPU",
      },
    ];
    if (openAiKeyAvailable(state)) {
      options.push({
        value: "openai",
        label: "OpenAI — text-embedding-3-small",
        hint: "multilingual, no download · sends memory text to OpenAI, per-embed cost",
      });
    }

    const provider =
      options.length === 1
        ? "local"
        : await prompter.select<string>({
            message: "Embedding provider for multilingual semantic recall:",
            options,
            initialValue: state.recallProvider?.provider ?? "local",
          });

    if (provider === "openai") {
      prompter.log.info(
        "Reusing your OpenAI API key for embeddings (text-embedding-3-small, 1536-d, multilingual).",
      );
      return updateState(state, {
        recallProvider: {
          multilingual: true,
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
        },
      });
    }

    prompter.log.info(
      "On-device multilingual embedder (bge-m3, 1024-d) — downloads ~635MB on first boot; recall stays $0 and private. " +
        "Existing memories re-embed automatically on the model change.",
    );
    return updateState(state, {
      recallProvider: { multilingual: true, provider: "local", modelUri: EMBED_BGE_M3_MODEL_URI },
    });
  },
};
