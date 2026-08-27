// Parsing @mentions out of a message body.
//
// Only the agent handle matters for dispatch. Human mentions are a display
// concern and deliberately are not resolved here, because resolving a name to a
// user id needs the database and this module stays pure so tests can import it.
//
// NOTE ON THE PATTERN BELOW. It is built with String.raw, not an ordinary
// template literal. In a normal template literal `\w` collapses to `w` and
// `\b` becomes a backspace character, which silently produced the pattern
// `(^|[^w@])@claude` here: a regex that matched nothing at all. The negative
// tests still passed, because a function that never matches also never matches
// the things it should refuse. If you edit this, keep String.raw.

/** The handle that dispatches a session. */
export const AGENT_HANDLE = "claude";

/**
 * Anchored to a word boundary so `@claudette` does not dispatch, and preceded
 * by a non-word, non-`@` character so an email address like
 * `me@claude.example` does not either. Case-insensitive, because people
 * capitalise mid-sentence.
 */
const AGENT_PATTERN = new RegExp(
  String.raw`(^|[^\w@])@${AGENT_HANDLE}\b`,
  "i"
);

/** True when the body addresses the agent. */
export function mentionsAgent(body: string): boolean {
  return AGENT_PATTERN.test(body);
}

/**
 * The request, with the leading handle removed.
 *
 * Only the FIRST mention goes. A later `@claude` inside the sentence is part of
 * what the person wrote and stays, because editing someone's words before
 * showing them to the agent would make the room and the brief disagree about
 * what was actually said.
 */
export function extractAsk(body: string): string {
  return body.replace(AGENT_PATTERN, "$1").trim();
}
