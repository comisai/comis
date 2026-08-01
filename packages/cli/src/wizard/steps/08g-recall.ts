// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic-memory-recall (embedding) step — step 08g of the init wizard.
 *
 * Fresh deployments use the private multilingual `bge-m3` embedder so semantic
 * recall works across scripts without an external service. This step exposes
 * the download/privacy tradeoff while memories are still cheap to re-embed.
 *
 * Progressive disclosure:
 *   1. Multilingual recall is recommended and selected by default.
 *   2. Yes → pick the multilingual embedder:
 *      - `local`  — on-device `bge-m3` (1024-d): private, $0, ~635MB download,
 *                   slower on CPU. The recommended default.
 *      - `openai` — `text-embedding-3-small` (1536-d): hosted, no download, but
 *                   sends memory text to OpenAI and costs per embed. Reuses the
 *                   main OPENAI_API_KEY when the main provider is OpenAI; else
 *                   prompts for a standalone key.
 *   3. No → select the smaller English-centric on-device nomic embedder.
 *
 * Writes the AUTHORITATIVE `embedding.*` surface (provider + local.modelUri /
 * openai.model+dimensions + the advisory `multilingual` flag) in step 10 — NOT
 * the legacy `memory.recall.embeddingModel` field.
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import { EMBED_BGE_M3_MODEL_URI, EMBED_NOMIC_MODEL_URI } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";

/** True when the main LLM provider is OpenAI with a collected key — so an
 *  OpenAI embedder reuses it silently (mirrors the 08e transcription key-reuse). */
function mainProvidesOpenAiKey(state: WizardState): boolean {
  return state.provider?.id === "openai" && state.provider.apiKey !== undefined;
}

export const recallStep: WizardStep = {
  id: "recall",
  label: "Memory Recall",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Semantic Memory Recall"));

    const multilingual = await prompter.confirm({
      message: "Use multilingual semantic recall (recommended for mixed-language conversations)?",
      initialValue: state.recallProvider?.multilingual ?? true,
    });

    // Explicit English-only choice: keep the smaller on-device nomic embedder.
    if (!multilingual) {
      prompter.log.info(
        "Using the on-device English embedder (nomic-embed-text-v1.5) — smaller and faster.",
      );
      return updateState(state, {
        recallProvider: {
          multilingual: false,
          provider: "local",
          modelUri: EMBED_NOMIC_MODEL_URI,
        },
      });
    }

    // Multilingual: on-device bge-m3 (recommended) or OpenAI-hosted.
    const provider = await prompter.select<string>({
      message: "Embedding provider for multilingual semantic recall:",
      options: [
        {
          value: "local",
          label: "On-device — bge-m3 (recommended)",
          hint: "private, $0, multilingual · ~635MB download, slower on CPU",
        },
        {
          value: "openai",
          label: "OpenAI — text-embedding-3-small",
          hint: "multilingual, no download · sends memory text to OpenAI, per-embed cost",
        },
      ],
      initialValue: state.recallProvider?.provider ?? "local",
    });

    if (provider === "openai") {
      // Reuse the main OPENAI_API_KEY when the main provider is OpenAI; else
      // collect a standalone key (mirrors 08e Deepgram / non-openai-main OpenAI).
      if (mainProvidesOpenAiKey(state)) {
        prompter.log.info(
          "Reusing your OpenAI API key for embeddings (text-embedding-3-small, 1536-d, multilingual).",
        );
        return updateState(state, {
          recallProvider: { multilingual: true, provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
        });
      }
      const apiKey = await prompter.password({
        message: "OpenAI API key for embeddings (OPENAI_API_KEY)",
        validate: (v: string) => {
          if (typeof v !== "string" || v.length === 0) return "API key is required";
          if (v.length < 10) return "API key seems too short (minimum 10 characters)";
          return undefined;
        },
      });
      return updateState(state, {
        recallProvider: { multilingual: true, provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKey },
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
