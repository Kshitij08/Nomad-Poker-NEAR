/**
 * .NET numeric/formatting semantics the port depends on.
 */

/** C# Math.Round(double) / Mathf.RoundToInt: round half to even ("banker's rounding"). */
export function roundHalfEven(x: number): number {
  const r = Math.round(x); // half up
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, minimumFractionDigits: 0 });

/** C# `v.ToString("N0")` (en-US / invariant culture): "1,234". */
export function formatN0(v: number): string {
  return N0.format(v);
}
