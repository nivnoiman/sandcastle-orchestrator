export const TRANSIENT_BACKOFF_MS = [2, 5, 10, 20, 30].map((minutes) => minutes * 60_000);

const TRANSIENT_SIGNATURES: readonly RegExp[] = [
  /API Error: (?:Unable to connect to API|Connection error|Request timed out)/i,
  /\bConnectionRefused\b/,
  /\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|AI_AGAIN|NOTFOUND|NETUNREACH|HOSTUNREACH|PIPE)\b/,
  /\bsocket hang up\b/i,
  /npm (?:ERR!|error) (?:network|code E(?:CONNRESET|TIMEDOUT|AI_AGAIN|NOTFOUND))/i,
  /npm (?:ERR!|error) code E50[234]\b/i,
  /Could not resolve host/i,
  /Failed to connect to \S+ port \d+/i,
  /Connection (?:timed out|refused|reset by peer)/i,
  /The requested URL returned error: 50[234]/i,
  /\bHTTP 50[234]\b/,
  /error connecting to (?:api\.)?github\.com/i,
  /TLS handshake timeout/i,
  /\boverloaded_error\b/,
];

export function transientSignature(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const signature of TRANSIENT_SIGNATURES) {
    const match = signature.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

export function transientBackoffMs(retry: number): number {
  const index = Math.max(0, Math.min(retry - 1, TRANSIENT_BACKOFF_MS.length - 1));
  return TRANSIENT_BACKOFF_MS[index]!;
}
