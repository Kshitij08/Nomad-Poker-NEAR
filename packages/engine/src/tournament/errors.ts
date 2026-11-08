/** Stand-ins for the .NET exceptions the tournament core throws that the shared core/errors.ts doesn't define. */

/** System.ArgumentException (bad entrants, bad hand reports). */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

/** System.OverflowException (a `checked` block overflowed a C# long). */
export class OverflowError extends Error {
  constructor(message = 'Arithmetic operation resulted in an overflow.') {
    super(message);
    this.name = 'OverflowError';
  }
}
