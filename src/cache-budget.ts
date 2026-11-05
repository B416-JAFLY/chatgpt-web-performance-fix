/** Approximate retained string storage; JavaScript engines may use other encodings. */
export class CacheBudget {
  private entries = new Map<string, { bytes: number; evict: () => void }>();
  private total = 0;
  constructor(readonly limit: number) {}
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
}
