// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Provenance trust carried by long-term memory entries. */
export const TrustLevelSchema = z.enum(["system", "learned", "external"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;
