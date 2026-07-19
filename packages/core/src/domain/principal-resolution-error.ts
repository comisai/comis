// SPDX-License-Identifier: Apache-2.0
/** Typed failure returned when platform identity cannot resolve to a principal. */
export class PrincipalResolutionError extends Error {
  readonly errorKind = "validation" as const;
}
