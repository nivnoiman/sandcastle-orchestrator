const WRITE_HEADER = { "content-type": "application/json", "x-sandcastle": "1" } as const;

type Payload = { error?: string } & Record<string, unknown>;

async function readPayload(response: Response, path: string): Promise<Payload> {
  const payload = (await response.json().catch(() => ({ error: "unreadable response" }))) as Payload;
  if (!response.ok) throw new Error(payload.error ?? `${path} failed (${response.status})`);
  return payload;
}

/** Fetch wrapper for one Project Server; `base` is "" on the Project Server itself. */
export interface ProjectApi {
  base: string;
  get(path: string): Promise<Payload>;
  send(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Payload>;
  eventsUrl(): string;
}

export function projectApi(base: string): ProjectApi {
  return {
    base,
    async get(path) {
      return readPayload(await fetch(`${base}${path}`), path);
    },
    async send(method, path, body) {
      const response = await fetch(`${base}${path}`, { method, headers: WRITE_HEADER, body: JSON.stringify(body ?? {}) });
      return readPayload(response, path);
    },
    eventsUrl: () => `${base}/api/events`,
  };
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
