export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function shortMessageOf(cause: unknown): string {
  return messageOf(cause).slice(0, 200);
}
