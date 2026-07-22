// A tiny insertion-ordered set of strings with an optional LRU cap. Used by
// local-history + checkpoint + activities to dedupe object_ids without each
// site re-implementing the same "add-if-new, trim-oldest-when-full" loop
// (L4). Insertion order is preserved via the underlying JS Set semantics —
// re-adding an existing key does NOT move it to the tail (that would defeat
// the "always evict truly-oldest" property callers expect).
//
// Sizing is per-caller: LocalHistory passes SEEN_CAP_PER_KIND; callers that
// don't need a cap (e.g. per-run dedupe in a single fetch loop) just omit
// the `cap` argument.

export class LruStringSet {
  private inner: Set<string>;
  private cap: number;

  constructor(initial: Iterable<string> = [], cap = Infinity) {
    this.inner = new Set(initial);
    this.cap = cap;
    this.trim();
  }

  get size(): number {
    return this.inner.size;
  }

  has(id: string): boolean {
    return this.inner.has(id);
  }

  /** Returns true iff the id was newly inserted. */
  add(id: string): boolean {
    if (this.inner.has(id)) return false;
    this.inner.add(id);
    this.trim();
    return true;
  }

  /** Bulk-add; returns count of newly-inserted ids. */
  addAll(ids: Iterable<string>): number {
    let added = 0;
    for (const id of ids) {
      if (!this.inner.has(id)) {
        this.inner.add(id);
        added++;
      }
    }
    this.trim();
    return added;
  }

  toArray(): string[] {
    return Array.from(this.inner);
  }

  /** LRU trim: drop the oldest entries until size <= cap. */
  private trim(): void {
    if (this.inner.size <= this.cap) return;
    const drop = this.inner.size - this.cap;
    let i = 0;
    for (const id of this.inner) {
      if (i++ >= drop) break;
      this.inner.delete(id);
    }
  }
}
