// SPDX-License-Identifier: Apache-2.0
/** Amazon Bedrock authentication and live-probe helpers for the init wizard. */

import { complete, getModels } from "@earendil-works/pi-ai/compat";
import { systemGetEnv, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import type { ProviderConfig, WizardState } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { info } from "../theme.js";

type BedrockAuthMethod = "bearer" | "profile" | "chain";

function requiredValue(value: string): string | undefined {
  return value.trim().length === 0 ? "A value is required" : undefined;
}

function resolveProbeModel(state: WizardState) {
  const models = getModels("amazon-bedrock");
  if (state.model && state.model !== "default") {
    return models.find((model) => model.id === state.model) ?? models[0];
  }
  return models[0];
}

async function probeBedrock(
  state: WizardState,
  provider: ProviderConfig,
): Promise<Result<void, Error>> {
  const model = resolveProbeModel(state);
  if (!model) return err(new Error("No Amazon Bedrock model is available in the pi catalog"));

  const response = await fromPromise(complete(
    model,
    {
      messages: [{ role: "user", content: "Reply with OK.", timestamp: systemNowMs() }],
    },
    {
      ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
      ...(provider.credentialValues !== undefined ? { env: provider.credentialValues } : {}),
      maxTokens: 1,
    },
  ));
  if (!response.ok) return response;
  if (response.value.stopReason === "error") {
    return err(new Error(response.value.errorMessage ?? "Amazon Bedrock returned an error"));
  }
  return ok(undefined);
}

function bedrockFailureHint(error: Error, region: string, modelId: string): string {
  const message = error.message;
  if (/UnrecognizedClientException|InvalidSignatureException/i.test(message)) {
    return "Set AWS_BEARER_TOKEN_BEDROCK to a valid Bedrock API key, or verify the configured AWS access keys.";
  }
  if (/ExpiredTokenException/i.test(message)) {
    return "Run `aws sso login` again or refresh the configured AWS access keys.";
  }
  if (/AccessDeniedException/i.test(message)) {
    return `Verify Bedrock model access in region ${region} for model id ${modelId}.`;
  }
  if (/ResourceNotFoundException|model identifier is invalid/i.test(message)) {
    return `Verify resolved region ${region} and model id ${modelId}; the model may be unavailable or not granted in that region.`;
  }
  return `Verify AWS credentials, resolved region ${region}, and model id ${modelId}.`;
}

/** Collect Bedrock auth, pin the region, and optionally run a one-token probe. */
export async function handleBedrockAuth(
  state: WizardState,
  prompter: WizardPrompter,
): Promise<WizardState> {
  prompter.note(
    info("Choose a Bedrock API key, an AWS profile, or the ambient AWS credential chain."),
    "Amazon Bedrock credentials",
  );

  const method = await prompter.select<BedrockAuthMethod>({
    message: "Amazon Bedrock authentication method",
    options: [
      { value: "bearer", label: "Bedrock API key (bearer)", hint: "Managed by Comis" },
      { value: "profile", label: "AWS profile", hint: "Uses a named local AWS profile" },
      { value: "chain", label: "Ambient AWS credential chain", hint: "Environment, SSO, IMDS, ECS, or web identity" },
    ],
    initialValue: "bearer",
  });

  let apiKey: string | undefined;
  const credentialValues: { AWS_REGION?: string; AWS_PROFILE?: string } = {};
  if (method === "bearer") {
    apiKey = await prompter.password({
      message: "Amazon Bedrock API key",
      validate: requiredValue,
    });
  } else if (method === "profile") {
    const profileDefault = systemGetEnv("AWS_PROFILE");
    const profile = await prompter.text({
      message: "AWS profile",
      ...(profileDefault !== undefined ? { defaultValue: profileDefault } : {}),
      validate: requiredValue,
      required: true,
    });
    credentialValues.AWS_PROFILE = profile.trim();
  } else {
    prompter.note(
      info("Comis will use the ambient AWS credential chain (environment, SSO, IMDS, ECS, or web identity)."),
      "Amazon Bedrock credential chain",
    );
  }

  const regionInput = await prompter.text({
    message: "AWS region",
    defaultValue: systemGetEnv("AWS_REGION") ?? "us-east-1",
    validate: requiredValue,
    required: true,
  });
  const region = regionInput.trim();
  credentialValues.AWS_REGION = region;

  const provider: ProviderConfig = {
    id: "amazon-bedrock",
    ...(apiKey !== undefined ? { apiKey } : {}),
    credentialValues,
    validated: false,
  };

  const shouldProbe = await prompter.confirm({
    message: "Test the Amazon Bedrock connection now?",
    initialValue: true,
  });
  if (!shouldProbe) {
    prompter.log.info(
      "Amazon Bedrock credentials saved without live validation; they will be checked on the first model request.",
    );
    return updateState(state, { provider });
  }

  const model = resolveProbeModel(state);
  const modelId = model?.id ?? state.model ?? "the configured model";
  for (;;) {
    const spinner = prompter.spinner();
    spinner.start("Testing Amazon Bedrock connection...");
    const probe = await probeBedrock(state, provider);
    if (probe.ok) {
      spinner.stop("Amazon Bedrock connection validated");
      return updateState(state, { provider: { ...provider, validated: true } });
    }

    spinner.stop("Amazon Bedrock connection check failed");
    prompter.log.error("Amazon Bedrock could not complete the validation request.");
    prompter.log.info(bedrockFailureHint(probe.error, region, modelId));
    const choice = await prompter.select<"retry" | "continue">({
      message: "What would you like to do?",
      options: [
        { value: "retry", label: "Retry connection check" },
        { value: "continue", label: "Continue without validation", hint: "Checked on first model request" },
      ],
    });
    if (choice === "continue") return updateState(state, { provider });
  }
}
