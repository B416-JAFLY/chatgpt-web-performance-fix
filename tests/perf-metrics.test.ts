import { describe, expect, test } from "bun:test";
import {
  DatasetStatBatcher,
  PerfTelemetry,
  RingBuffer,
} from "../src/perf-metrics";

describe("RingBuffer", () => {
  test("maintains fixed capacity and accurate summary stats", () => {
    const buffer = new RingBuffer(4);
    for (const sample of [10, 20, 30, 40, 50, 60]) {
      buffer.push(sample);
    }
    expect(buffer.count).toBe(6);
    expect(buffer.size).toBe(4);
    expect(buffer.total).toBe(210);
    expect(buffer.max).toBe(60);
    expect(buffer.mean).toBe(35);
    expect(buffer.toArray()).toEqual([30, 40, 50, 60]);
    expect(buffer.percentile(0.5)).toBe(50);
    expect(buffer.percentile(0.95)).toBe(60);
  });

  test("reset clears all state", () => {
    const buffer = new RingBuffer(8);
    buffer.push(12);
    buffer.push(24);
    buffer.reset();
    expect(buffer.count).toBe(0);
    expect(buffer.size).toBe(0);
    expect(buffer.total).toBe(0);
    expect(buffer.max).toBe(0);
    expect(buffer.percentile(0.95)).toBe(0);
  });
});

describe("PerfTelemetry", () => {
  test("does not accumulate performance.measure entries in normal mode", () => {
    let measureCalls = 0;
    const fakeWindow = {
      document: {
        documentElement: {
          dataset: {} as Record<string, string>,
        },
      },
      localStorage: {
        getItem: () => null,
      },
      performance: {
        now: () => 100,
        mark: () => undefined,
        measure: () => {
          measureCalls += 1;
        },
        clearMarks: () => undefined,
        clearMeasures: () => undefined,
      },
    } as unknown as Window & typeof globalThis;

    const telemetry = new PerfTelemetry(fakeWindow, 5);
    for (let i = 0; i < 20; i += 1) {
      telemetry.recordDuration(
        "worker-op",
        100,
        100 + i + 1,
        "chatgpt-perf:worker-op",
      );
    }
    expect(measureCalls).toBe(0);
    const snap = telemetry.summarize("worker-op");
    expect(snap.count).toBe(20);
    expect(snap.recentCount).toBe(5);
    expect(snap.maxMs).toBe(20);
  });

  test("records performance.measure in debug mode and caps User Timing buffer", () => {
    let measureCalls = 0;
    let clearMeasuresCalls = 0;
    const fakeWindow = {
      document: {
        documentElement: {
          dataset: {
            chatgptPerfDebug: "true",
          } as Record<string, string>,
        },
      },
      localStorage: {
        getItem: () => "1",
      },
      performance: {
        now: () => 250,
        mark: () => undefined,
        measure: () => {
          measureCalls += 1;
        },
        clearMarks: () => undefined,
        clearMeasures: () => {
          clearMeasuresCalls += 1;
        },
      },
    } as unknown as Window & typeof globalThis;

    const telemetry = new PerfTelemetry(fakeWindow, 10);
    for (let i = 0; i < 205; i += 1) {
      telemetry.recordDuration(
        "history-idle",
        200,
        205,
        "chatgpt-perf:history-idle",
      );
    }
    expect(measureCalls).toBe(205);
    expect(clearMeasuresCalls).toBe(1);
  });
});

describe("DatasetStatBatcher", () => {
  test("coalesces repeated increments and sets before flushing to dataset", async () => {
    const writes: Record<string, number> = {};
    const backing: Record<string, string | undefined> = {};
    const datasetProxy = new Proxy(backing, {
      set(target, prop: string, value: string) {
        writes[prop] = (writes[prop] ?? 0) + 1;
        target[prop] = value;
        return true;
      },
      get(target, prop: string) {
        return target[prop];
      },
    });

    const fakeWindow = {
      document: {
        documentElement: {
          dataset: datasetProxy,
        },
      },
    } as unknown as Window & typeof globalThis;

    const batcher = new DatasetStatBatcher(fakeWindow);
    for (let i = 0; i < 50; i += 1) {
      batcher.increment("chatgptWorkerTasks");
    }
    batcher.set("chatgptWorkerTotalMs", "12.5");
    batcher.set("chatgptWorkerTotalMs", "15.8");

    expect(writes.chatgptWorkerTasks ?? 0).toBe(0);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backing.chatgptWorkerTasks).toBe("50");
    expect(backing.chatgptWorkerTotalMs).toBe("15.8");
    expect(writes.chatgptWorkerTasks).toBe(1);
    expect(writes.chatgptWorkerTotalMs).toBe(1);
  });
});
