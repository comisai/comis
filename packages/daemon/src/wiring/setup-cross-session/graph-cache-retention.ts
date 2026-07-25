// SPDX-License-Identifier: Apache-2.0
/** Resolve graph-node cache retention from whether later nodes can reuse it. */
export function resolveGraphCacheRetention(
  _graphNodeDepth: number | undefined,
  isLeafNode?: boolean,
): "short" | "long" {
  return isLeafNode === true ? "short" : "long";
}
