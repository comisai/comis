// SPDX-License-Identifier: Apache-2.0
import type { ErrorKind } from "../logging/log-fields.js";

export class SessionStoreError extends Error {
  constructor(
    message: string,
    readonly errorKind: ErrorKind,
  ) {
    super(message);
  }
}
