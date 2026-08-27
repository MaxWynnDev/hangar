// The reaction menu.
//
// An allowlist, not a free text field. The column is bounded to 32 characters
// by a CHECK, but the real reason to enumerate is that an open field turns a
// reaction into a second, unmoderated message body with no length limit worth
// the name.
//
// Widening this is a copy change, not a migration.

export const REACTIONS = ["👍", "👀", "🎉", "😄", "🤔", "❤️", "🚀", "👎"] as const;

export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: string): value is Reaction {
  return (REACTIONS as readonly string[]).includes(value);
}
