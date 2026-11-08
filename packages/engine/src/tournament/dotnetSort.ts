/**
 * `List<T>.Sort(Comparison<T>)` exactly as .NET runs it (ArraySortHelper<T>.IntrospectiveSort): a 2- or 3-element
 * sorting network, insertion sort up to 16, then median-of-three quicksort with a heapsort fallback. It is NOT
 * stable, and the tournament core relies on the order it leaves equal elements in (same-hand busts with equal start
 * stacks are dealt their high cards in that order), so Array.prototype.sort (stable) would diverge from the C#.
 * Sorts `keys` in place and returns it.
 */
export function dotnetSort<T>(keys: T[], comparer: (a: T, b: T) => number): T[] {
  if (keys.length > 1) introSort(keys, 0, keys.length, 2 * (Math.floor(Math.log2(keys.length)) + 1), comparer);
  return keys;
}

const INTROSORT_SIZE_THRESHOLD = 16;

function introSort<T>(keys: T[], lo: number, length: number, depthLimit: number, cmp: (a: T, b: T) => number): void {
  let partitionSize = length;
  while (partitionSize > 1) {
    if (partitionSize <= INTROSORT_SIZE_THRESHOLD) {
      if (partitionSize === 2) {
        swapIfGreater(keys, cmp, lo, lo + 1);
        return;
      }
      if (partitionSize === 3) {
        swapIfGreater(keys, cmp, lo, lo + 1);
        swapIfGreater(keys, cmp, lo, lo + 2);
        swapIfGreater(keys, cmp, lo + 1, lo + 2);
        return;
      }
      insertionSort(keys, lo, partitionSize, cmp);
      return;
    }
    if (depthLimit === 0) {
      heapSort(keys, lo, partitionSize, cmp);
      return;
    }
    depthLimit--;
    const p = pickPivotAndPartition(keys, lo, partitionSize, cmp);
    introSort(keys, lo + p + 1, partitionSize - (p + 1), depthLimit, cmp);
    partitionSize = p;
  }
}

function swapIfGreater<T>(keys: T[], cmp: (a: T, b: T) => number, i: number, j: number): void {
  if (cmp(keys[i]!, keys[j]!) > 0) swap(keys, i, j);
}

function swap<T>(keys: T[], i: number, j: number): void {
  const t = keys[i]!;
  keys[i] = keys[j]!;
  keys[j] = t;
}

function pickPivotAndPartition<T>(keys: T[], lo: number, length: number, cmp: (a: T, b: T) => number): number {
  const hi = length - 1;
  const middle = hi >> 1;
  swapIfGreater(keys, cmp, lo, lo + middle);
  swapIfGreater(keys, cmp, lo, lo + hi);
  swapIfGreater(keys, cmp, lo + middle, lo + hi);
  const pivot = keys[lo + middle]!;
  swap(keys, lo + middle, lo + hi - 1);
  let left = 0;
  let right = hi - 1;
  while (left < right) {
    while (cmp(keys[lo + ++left]!, pivot) < 0);
    while (cmp(pivot, keys[lo + --right]!) < 0);
    if (left >= right) break;
    swap(keys, lo + left, lo + right);
  }
  if (left !== hi - 1) swap(keys, lo + left, lo + hi - 1);
  return left;
}

function heapSort<T>(keys: T[], lo: number, n: number, cmp: (a: T, b: T) => number): void {
  for (let i = n >> 1; i >= 1; i--) downHeap(keys, lo, i, n, cmp);
  for (let i = n; i > 1; i--) {
    swap(keys, lo, lo + i - 1);
    downHeap(keys, lo, 1, i - 1, cmp);
  }
}

function downHeap<T>(keys: T[], lo: number, i: number, n: number, cmp: (a: T, b: T) => number): void {
  const d = keys[lo + i - 1]!;
  while (i <= n >> 1) {
    let child = 2 * i;
    if (child < n && cmp(keys[lo + child - 1]!, keys[lo + child]!) < 0) child++;
    if (!(cmp(d, keys[lo + child - 1]!) < 0)) break;
    keys[lo + i - 1] = keys[lo + child - 1]!;
    i = child;
  }
  keys[lo + i - 1] = d;
}

function insertionSort<T>(keys: T[], lo: number, length: number, cmp: (a: T, b: T) => number): void {
  for (let i = 0; i < length - 1; i++) {
    const t = keys[lo + i + 1]!;
    let j = i;
    while (j >= 0 && cmp(t, keys[lo + j]!) < 0) {
      keys[lo + j + 1] = keys[lo + j]!;
      j--;
    }
    keys[lo + j + 1] = t;
  }
}

/** C# `a.CompareTo(b)` for numbers (long / int). */
export const compareNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
