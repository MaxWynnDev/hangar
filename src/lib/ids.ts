// Identifiers.
//
// Random, not sequential. A room or post id appears in URLs and in the agent's
// working notes, and a sequential id leaks how much traffic the install has
// seen and lets someone walk the range.

import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
