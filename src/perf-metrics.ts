/**
 * Fixed-capacity numeric ring buffer backed by Float64Array.
 * Retains the most recent N samples with zero heap allocations after construction.
 */
export class RingBuffer {
  private readonly buffer: Float64Array;
  private writeIndex = 0;
  private length = 0;
  private sum = 0;
  private maxValue = 0;
  private totalCount = 0;

  constructor(readonly capacity = 100) {
    this.buffer = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  push(value: number): void {
    const safe = Number.isFinite(value) && value >= 0 ? value : 0;
    this.totalCount += 1;
    this.sum += safe;
    if (safe > this.maxValue) {
      this.maxValue = safe;
    }
    this.buffer[this.writeIndex] = safe;
    this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    if (this.length < this.buffer.length) {
      this.length += 1;
    }
  }

  get count(): number {
    return this.totalCount;
  }

  get size(): number {
    return this.length;
  }

  get total(): number {
    return this.sum;
  }

  get max(): number {
    return this.maxValue;
  }

  get mean(): number {
    return this.totalCount > 0 ? this.sum / this.totalCount : 0;
  }

  toArray(): number[] {
    const result = new Array<number>(this.length);
    const start =
      this.length < this.buffer.length ? 0 : this.writeIndex;
    for (let i = 0; i < this.length; i += 1) {
      result[i] = this.buffer[(start + i) % this.buffer.length];
    }
    return result;
  }

  percentile(fraction: number): number {
    if (this.length === 0) return 0;
    const sorted = this.toArray().sort((a, b) => a - b);
    const clamped = Math.min(1, Math.max(0, fraction));
    const idx = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * clamped),
    );
    return sorted[idx] ?? 0;
  }

  reset(): void {
    this.writeIndex = 0;
    this.length = 0;
    this.sum = 0;
    this.maxValue = 0;
    this.totalCount = 0;
  }
}

export interface MetricSummary {
  count: number;
  totalMs: number;
  maxMs: number;
  meanMs: number;
  p95Ms: number;
  recentCount: number;
}

const MAX_DEBUG_USER_TIMING_MEASURES = 200;

/**
 * Lightweight performance telemetry that avoids unbounded User Timing measure
 * accumulation unless debug mode is explicitly enabled.
 */
export class PerfTelemetry {
  private readonly series = new Map<string, RingBuffer>();
  private debugMeasuresRecorded = 0;

  constructor(
    private readonly pageWindow: Window & typeof globalThis,
    private readonly ringCapacity = 100,
  ) {}

  isDebugEnabled(): boolean {
    try {
      if (
        this.pageWindow.document?.documentElement?.dataset.chatgptPerfDebug ===
        "true"
      ) {
        return true;
      }
      return (
        this.pageWindow.localStorage?.getItem(
          "chatgpt-performance-fix:debug",
        ) === "1"
      );
    } catch {
      return false;
    }
  }

  recordDuration(
    category: string,
    startedAt: number,
    finishedAt = this.pageWindow.performance.now(),
    measureName?: string,
  ): number {
    const elapsed = Math.max(0, finishedAt - startedAt);
    let ring = this.series.get(category);
    if (!ring) {
      ring = new RingBuffer(this.ringCapacity);
      this.series.set(category, ring);
    }
    ring.push(elapsed);

    if (this.isDebugEnabled() && measureName) {
      try {
        if (this.debugMeasuresRecorded >= MAX_DEBUG_USER_TIMING_MEASURES) {
          this.pageWindow.performance.clearMeasures?.();
          this.debugMeasuresRecorded = 0;
        }
        this.pageWindow.performance.measure(measureName, {
          start: startedAt,
          end: finishedAt,
          detail: { durationMs: elapsed },
        });
        this.debugMeasuresRecorded += 1;
      } catch {
        // Ignore unavailable User Timing APIs in older/restricted contexts.
      }
    }

    return elapsed;
  }

  getRing(category: string): RingBuffer | undefined {
    return this.series.get(category);
  }

  summarize(category: string): MetricSummary {
    const ring = this.series.get(category);
    if (!ring) {
      return {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        meanMs: 0,
        p95Ms: 0,
        recentCount: 0,
      };
    }
    return {
      count: ring.count,
      totalMs: Math.round(ring.total * 100) / 100,
      maxMs: Math.round(ring.max * 100) / 100,
      meanMs: Math.round(ring.mean * 100) / 100,
      p95Ms: Math.round(ring.percentile(0.95) * 100) / 100,
      recentCount: ring.size,
    };
  }

  snapshot(): Record<string, MetricSummary> {
    const out: Record<string, MetricSummary> = {};
    for (const key of this.series.keys()) {
      out[key] = this.summarize(key);
    }
    return out;
  }
}

/**
 * Batches high-frequency statistical counter writes to `documentElement.dataset`
 * so tight loops update in-memory numbers and commit to DOM once per microtask/frame.
 */
export class DatasetStatBatcher {
  private readonly numericValues = new Map<string, number>();
  private readonly pendingWrites = new Map<string, string>();
  private flushScheduled = false;

  constructor(private readonly pageWindow: Window & typeof globalThis) {}

  private readInitialNumber(key: string): number {
    const cached = this.numericValues.get(key);
    if (cached !== undefined) return cached;
    const raw = this.pageWindow.document?.documentElement?.dataset?.[key];
    const parsed = raw !== undefined ? Number(raw) : 0;
    const valid = Number.isFinite(parsed) ? parsed : 0;
    this.numericValues.set(key, valid);
    return valid;
  }

  getNumber(key: string): number {
    return this.readInitialNumber(key);
  }

  increment(key: string, delta = 1): number {
    const next = this.readInitialNumber(key) + delta;
    this.numericValues.set(key, next);
    this.pendingWrites.set(key, String(next));
    this.scheduleFlush();
    return next;
  }

  addFloat(key: string, delta: number, roundToInt = true): number {
    const next = this.readInitialNumber(key) + delta;
    this.numericValues.set(key, next);
    this.pendingWrites.set(
      key,
      String(roundToInt ? Math.round(next) : Math.round(next * 100) / 100),
    );
    this.scheduleFlush();
    return next;
  }

  set(key: string, value: string | number): void {
    if (typeof value === "number" && Number.isFinite(value)) {
      this.numericValues.set(key, value);
    }
    this.pendingWrites.set(key, String(value));
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => this.flushNow();
    if (typeof queueMicrotask === "function") {
      queueMicrotask(run);
    } else {
      this.pageWindow.setTimeout(run, 0);
    }
  }

  flushNow(): void {
    this.flushScheduled = false;
    if (this.pendingWrites.size === 0) return;
    const dataset = this.pageWindow.document?.documentElement?.dataset;
    if (!dataset) {
      this.pendingWrites.clear();
      return;
    }
    for (const [key, value] of this.pendingWrites) {
      if (dataset[key] !== value) {
        dataset[key] = value;
      }
    }
    this.pendingWrites.clear();
  }
}
