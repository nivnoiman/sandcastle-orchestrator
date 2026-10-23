export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function flagNumber(args: readonly string[], name: string, fallback: number): number {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  if (!found) return fallback;
  const value = Number(found.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer, got "${found}"`);
  return value;
}

export function optionalFlagNumber(args: readonly string[], name: string): number | undefined {
  return args.some((arg) => arg.startsWith(`--${name}=`)) ? flagNumber(args, name, 1) : undefined;
}
