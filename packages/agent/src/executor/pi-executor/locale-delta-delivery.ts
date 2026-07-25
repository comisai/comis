// SPDX-License-Identifier: Apache-2.0
/** Holds streamed prose until an enforced locale response has passed final validation. */

import type { ResponseLocalePolicy } from "@comis/core";

export interface LocaleDeltaDelivery {
  readonly onDelta: (delta: string, kind: "text" | "thinking") => void;
  readonly flush: (response: string) => void;
}

export interface LocaleDeltaDeliveryState {
  readonly _empty?: never;
}

/**
 * Non-enforced turns retain byte-identical live streaming. Enforced turns
 * withhold draft and repair deltas, then deliver the finalized response once.
 */
export function createLocaleDeltaDelivery(
  state: Readonly<LocaleDeltaDeliveryState>,
  args: {
    readonly policy: ResponseLocalePolicy;
    readonly downstream: ((delta: string, kind: "text" | "thinking") => void) | undefined;
  },
): LocaleDeltaDelivery {
  void state;
  if (!args.policy.enforceLocale) {
    return {
      onDelta: (delta, kind) => args.downstream?.(delta, kind),
      flush: () => undefined,
    };
  }

  let flushed = false;
  return {
    onDelta: () => undefined,
    flush: (response) => {
      if (flushed || response.length === 0) return;
      flushed = true;
      args.downstream?.(response, "text");
    },
  };
}
