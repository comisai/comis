// SPDX-License-Identifier: Apache-2.0
import { ok, type Result } from "@comis/shared";

export type ProviderDispatchGuard = () => Result<void, Error>;

export const allowProviderDispatch: ProviderDispatchGuard = () => ok(undefined);

export function resolveProviderDispatchGuard(
  guard: ProviderDispatchGuard | undefined,
): ProviderDispatchGuard {
  return guard ?? allowProviderDispatch;
}

export function dispatchProviderPrompt<T>(
  guard: ProviderDispatchGuard,
  prompt: () => Promise<T>,
): Promise<T> {
  const admitted = guard();
  return admitted.ok ? prompt() : Promise.reject(admitted.error);
}
