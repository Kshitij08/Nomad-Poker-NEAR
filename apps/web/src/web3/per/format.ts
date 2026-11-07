/** C# "N0" (invariant culture): thousands separators, no decimals, banker's-free rounding like .NET (away from zero at .5). */
export function formatN0(v: number): string {
  const r = Math.sign(v) * Math.round(Math.abs(v));
  return r.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
