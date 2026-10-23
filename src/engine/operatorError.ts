export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

export function isOperatorError(cause: unknown): cause is OperatorError {
  return cause instanceof OperatorError;
}
