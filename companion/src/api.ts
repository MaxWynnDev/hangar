// Talking to the Hangar server.
//
// The companion holds a bearer token and nothing else. No database URL, no
// session secret. If this machine is compromised the attacker gets the ability
// to claim dispatches and post as the agent, which is bad, but they do not get
// the database.

export interface CompanionConfig {
  /** Base URL of the Hangar server, e.g. https://hangar.example.com */
  baseUrl: string;
  token: string;
  /** Repository the agent works in. */
  repoPath: string;
  /** Seconds between polls when the queue is empty. */
  pollSeconds: number;
}

export interface Claimed {
  id: string;
  roomId: string;
  ask: string;
}

export interface EventInput {
  commandId: string;
  roomId: string;
  seq: number;
  kind: string;
  label?: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export class HangarClient {
  constructor(private readonly cfg: CompanionConfig) {}

  private async call(path: string, body?: unknown): Promise<Response> {
    const res = await fetch(new URL(path, this.cfg.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401) {
      // Not retryable and not a transient failure. Exiting beats looping
      // forever against a server that will never accept this token.
      throw new Error("Hangar rejected the companion token. Check HANGAR_COMPANION_TOKEN.");
    }
    return res;
  }

  /** Null when there is nothing queued, which is most of the time. */
  async claim(): Promise<Claimed | null> {
    const res = await this.call("/api/companion/claim");
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as Claimed;
  }

  async start(id: string): Promise<void> {
    await this.call("/api/companion/start", { id });
  }

  /**
   * Post console rows.
   *
   * Failures here are swallowed by the caller on purpose: the console is a live
   * convenience, and losing a batch of it must never abort a session that is
   * doing real work in a real repository.
   */
  async events(events: EventInput[]): Promise<void> {
    if (events.length === 0) return;
    const res = await this.call("/api/companion/events", { events });
    if (!res.ok) throw new Error(`events failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Report completion.
   *
   * No room id: the server looks it up from the dispatch. Sending one would
   * mean a bug here could deliver a reply into a room that never asked.
   */
  async finish(
    id: string,
    status: "done" | "failed",
    reply: string
  ): Promise<{ ok: boolean; scrubbed: number }> {
    const res = await this.call("/api/companion/finish", { id, status, reply });
    if (!res.ok) throw new Error(`finish failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { ok: boolean; scrubbed: number };
  }
}

export function loadConfig(): CompanionConfig {
  const baseUrl = process.env.HANGAR_URL;
  const token = process.env.HANGAR_COMPANION_TOKEN;
  const repoPath = process.env.HANGAR_REPO ?? process.cwd();
  const pollSeconds = Number(process.env.HANGAR_POLL_SECONDS ?? 5);

  const missing: string[] = [];
  if (!baseUrl) missing.push("HANGAR_URL");
  if (!token) missing.push("HANGAR_COMPANION_TOKEN");
  if (missing.length) {
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  }

  return {
    baseUrl: baseUrl as string,
    token: token as string,
    repoPath,
    pollSeconds: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : 5,
  };
}
