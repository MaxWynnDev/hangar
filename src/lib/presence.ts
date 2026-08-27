// Presence and typing windows.
//
// Both signals are stored as timestamps, never booleans, and the reader decides
// what counts as current. A boolean has to be turned off by somebody, and the
// client that would do it is exactly the one that closed its laptop or lost its
// network. Every chat product that stores `is_typing boolean` eventually shows
// somebody typing forever.

/** How long after a heartbeat someone still counts as present. */
export const PRESENT_WINDOW_MS = 45_000;

/** How long a typing signal stays live. Shorter: typing stops abruptly. */
export const TYPING_WINDOW_MS = 6_000;

/** Heartbeat interval the client should use. Comfortably inside the window. */
export const HEARTBEAT_MS = 15_000;

export function isPresent(lastSeenAt: Date | string | null, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const t = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  return Number.isFinite(t) && now.getTime() - t < PRESENT_WINDOW_MS;
}

export function isTyping(typingAt: Date | string | null, now: Date = new Date()): boolean {
  if (!typingAt) return false;
  const t = typeof typingAt === "string" ? Date.parse(typingAt) : typingAt.getTime();
  return Number.isFinite(t) && now.getTime() - t < TYPING_WINDOW_MS;
}
