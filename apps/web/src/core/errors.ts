/** Stand-in for .NET's InvalidOperationException (illegal action, wrong turn, empty deck...). */
export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

/** Stand-in for .NET's ArgumentOutOfRangeException. */
export class ArgumentOutOfRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentOutOfRangeError';
  }
}
