export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
