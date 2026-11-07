/** A C# `event Action` stand-in: subscribe returns an unsubscribe; a throwing listener never breaks the others. */
export class Signal<T = void> {
  private readonly fns = new Set<(v: T) => void>();

  on(fn: (v: T) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  emit(value: T): void {
    for (const fn of [...this.fns]) {
      try {
        fn(value);
      } catch (e) {
        console.error('[Economy] listener threw', e);
      }
    }
  }

  clear(): void {
    this.fns.clear();
  }
}
