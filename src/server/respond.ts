// Request and response helpers.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Bodies are small by design. A chat message is not an upload. */
const MAX_BODY_BYTES = 64 * 1024;

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // The API returns JSON only. Telling the browser not to guess otherwise
    // closes the content-sniffing path to XSS on an error page.
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

export function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    // The UI is served inline from this process and loads nothing remote, so a
    // strict policy costs nothing and removes the whole injected-script class.
    "content-security-policy":
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

export function noContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, headers);
  res.end();
}

/**
 * Read a JSON body, refusing anything oversized.
 *
 * The length check happens as chunks arrive, not just on content-length: a
 * client can lie in the header, and trusting it is how a "small" endpoint ends
 * up buffering a gigabyte.
 */
export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(buf);
  }

  if (size === 0) return {} as T;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A string field that must be present and within a sane length. */
export function requireString(
  value: unknown,
  field: string,
  { max = 4000, min = 1 }: { max?: number; min?: number } = {}
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new HttpError(400, `${field} is required`);
  }
  if (trimmed.length > max) {
    throw new HttpError(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

/** Slugs appear in URLs, so keep them boring. */
export function requireSlug(value: unknown, field: string): string {
  const s = requireString(value, field, { max: 64 });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) {
    throw new HttpError(400, `${field} may contain only lowercase letters, numbers and hyphens`);
  }
  return s;
}

/**
 * A bounded integer from a query string.
 *
 * Number("abc") is NaN, and NaN reaching a SQL parameter is a 500 rather than a
 * 400. Anything unparseable falls back to the default.
 */
export function boundedInt(
  raw: string | null,
  { fallback, min, max }: { fallback: number; min: number; max: number }
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
