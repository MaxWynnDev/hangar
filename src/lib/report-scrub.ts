// Scrubbing what the agent says before it becomes a room message.
//
// The session reads a real repository and a real environment. Its reply lands
// in a room that more people can read than could read that environment, and it
// is stored, so anything that slips through is durable.
//
// This is defence in depth, not the primary control. The primary control is not
// giving the session credentials it does not need. Treat a hit here as a signal
// that something upstream is wrong, not as the system working normally.

/** Replaced in place so the shape of the reply survives. */
const REDACTED = "[redacted]";

interface Pattern {
  id: string;
  re: RegExp;
  why: string;
}

const PATTERNS: Pattern[] = [
  {
    id: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    why: "an Anthropic API key",
  },
  {
    id: "github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    why: "a GitHub token",
  },
  {
    id: "aws-key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    why: "an AWS access key id",
  },
  {
    id: "private-key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    why: "a private key block",
  },
  {
    id: "bearer",
    re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    why: "a bearer token",
  },
  {
    // Any URL carrying inline credentials, e.g. postgres://user:pass@host.
    id: "url-credentials",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
    why: "credentials embedded in a connection string",
  },
  {
    id: "env-assignment",
    re: /\b([A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_DSN))\s*=\s*\S+/g,
    why: "an environment variable that names itself a secret",
  },
];

export interface ScrubResult {
  text: string;
  /** Which patterns fired. Empty is the expected case; anything else is worth a look. */
  hits: { id: string; why: string; count: number }[];
}

export function scrubReport(input: string): ScrubResult {
  let text = input;
  const hits: ScrubResult["hits"] = [];

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const matches = text.match(p.re);
    if (!matches || matches.length === 0) continue;

    hits.push({ id: p.id, why: p.why, count: matches.length });
    text = text.replace(p.re, (m) => {
      // Keep the assignment's left-hand side so a reader can see WHICH variable
      // was involved. Redacting the name too turns a useful signal into noise.
      const named = /^([A-Z][A-Z0-9_]*)\s*=/.exec(m);
      return named ? `${named[1]}=${REDACTED}` : REDACTED;
    });
  }

  return { text, hits };
}
