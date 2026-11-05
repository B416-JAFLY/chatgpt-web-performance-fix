/** Approximate retained string storage; JavaScript engines may use other encodings. */
export class CacheBudget {
  private entries = new Map<string, { bytes: number; evict: () => void }>();
  private total = 0;
  constructor(readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.total;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.total -= entry.bytes;
    this.entries.delete(key);
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  set(key: string, bytes: number, evict: () => void): void {
    this.delete(key);
    this.entries.set(key, { bytes, evict });
    this.total += bytes;
    while (this.total > this.limit && this.entries.size) {
      const oldest = this.entries.keys().next().value!;
      const entry = this.entries.get(oldest)!;
      this.delete(oldest);
      entry.evict();
    }
  }

  deleteMatching(predicate: (key: string) => boolean): number {
    let count = 0;
    for (const [key, entry] of [...this.entries]) {
      if (predicate(key)) {
        this.delete(key);
        entry.evict();
        count++;
      }
    }
    return count;
  }

  clear(): void {
    for (const [key, entry] of [...this.entries]) {
      this.delete(key);
      entry.evict();
    }
  }
}
