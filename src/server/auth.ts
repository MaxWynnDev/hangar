// Sessions.
//
// Hangar deliberately does not ship an identity provider. It signs a cookie
// naming a user id that already exists in the `users` table, and leaves account
// creation to whoever runs it. Wiring this to OIDC, or to an existing session,
// means replacing `readSession` and nothing else.
//
// The cookie is signed, not encrypted. It carries no secret, only a user id
// that is already visible in the UI. What matters is that it cannot be forged,
// which a MAC gives us; hiding it would add nothing.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE = "hangar_session";

/** Sessions last a working week, then you sign in again. */
const MAX_AGE_S = 7 * 24 * 60 * 60;

function secret(): string {
  const s = process.env.HANGAR_SESSION_SECRET;
  if (!s || s.length < 32) {
    // Refusing to start beats defaulting to a known key. A development
    // fallback here is how a public deployment ends up with a forgeable
    // cookie, because nobody removes it later.
    throw new Error(
      "HANGAR_SESSION_SECRET must be set to at least 32 characters. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Constant-time compare. A MAC checked with === leaks its prefix by timing. */
function macMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface Session {
  userId: string;
  issuedAt: number;
}

export function issueCookie(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${encodeURIComponent(userId)}.${issuedAt}`;
  const value = `${payload}.${sign(payload)}`;
  return [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_S}`,
    // Secure is conditional: a self-hosted install on a laptop is plain http,
    // and an always-on Secure flag would silently drop the cookie there and
    // present as "login does nothing".
    process.env.HANGAR_INSECURE_COOKIES === "true" ? "" : "Secure",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSession(cookieHeader: string | undefined): Session | null {
  if (!cookieHeader) return null;

  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

  if (!raw) return null;

  // rsplit on the last dot: a user id may itself contain dots.
  const lastDot = raw.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = raw.slice(0, lastDot);
  const mac = raw.slice(lastDot + 1);

  if (!macMatches(mac, sign(payload))) return null;

  const sep = payload.lastIndexOf(".");
  if (sep <= 0) return null;
  const userId = decodeURIComponent(payload.slice(0, sep));
  const issuedAt = Number(payload.slice(sep + 1));

  if (!userId || !Number.isFinite(issuedAt)) return null;
  if (Math.floor(Date.now() / 1000) - issuedAt > MAX_AGE_S) return null;

  return { userId, issuedAt };
}

/** For operators bootstrapping an install. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}
