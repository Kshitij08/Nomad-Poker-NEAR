/**
 * Raise-slider amounts. The sheet's slider is continuous; amounts snap to the minimum raise increment counted from
 * the minimum raise-to (so every stop is a legal raise), and the far end always reaches the all-in total even when
 * the stack isn't a whole number of increments. The −/+ buttons step by the same increment and land on the grid.
 */
export function snapRaise(value: number, min: number, max: number, step: number): number {
  if (!(max > min)) return max;
  const s = Math.max(1, Math.round(step));
  if (value >= max) return max;
  if (value <= min) return min;
  const k = Math.round((value - min) / s);
  const snapped = min + k * s;
  // The last partial step goes to all-in rather than stopping just short of it.
  if (snapped >= max || max - value < s / 2) return max;
  return snapped;
}

/** −/+ : one increment from the current amount, onto the grid, clamped (min … all-in). */
export function nudgeRaise(value: number, dir: number, min: number, max: number, step: number): number {
  const s = Math.max(1, Math.round(step));
  if (dir > 0) {
    if (value >= max) return max;
    const k = Math.floor((value - min) / s) + 1;
    return Math.min(max, min + k * s);
  }
  if (value <= min) return min;
  if (value >= max) {
    // From all-in, step back onto the last full increment below it.
    const k = Math.floor((max - min) / s);
    const v = min + k * s;
    return v >= max ? Math.max(min, max - s) : v;
  }
  const k = Math.ceil((value - min) / s) - 1;
  return Math.max(min, min + k * s);
}
