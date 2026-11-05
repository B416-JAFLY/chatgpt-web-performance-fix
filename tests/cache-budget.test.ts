import { expect, test } from "bun:test";
import { CacheBudget } from "../src/cache-budget";

test("budget evicts least recently used entries and handles replacement", () => {
  const budget = new CacheBudget(10);
  const evicted: string[] = [];
  budget.set("a", 4, () => evicted.push("a"));
  budget.set("b", 4, () => evicted.push("b"));
  budget.touch("a");
  budget.set("c", 4, () => evicted.push("c"));
  expect(evicted).toEqual(["b"]);
  budget.set("a", 2, () => evicted.push("new-a"));
  budget.set("d", 5, () => evicted.push("d"));
  expect(evicted).toEqual(["b", "c"]);
  budget.set("huge", 11, () => evicted.push("huge"));
  expect(evicted).toEqual(["b", "c", "new-a", "d", "huge"]);
});

test("tracks size and totalBytes accurately", () => {
  const budget = new CacheBudget(20);
  expect(budget.size).toBe(0);
  expect(budget.totalBytes).toBe(0);

  budget.set("k1", 5, () => {});
  budget.set("k2", 7, () => {});
  expect(budget.size).toBe(2);
  expect(budget.totalBytes).toBe(12);
  expect(budget.has("k1")).toBe(true);
  expect(budget.has("k3")).toBe(false);

  budget.delete("k1");
  expect(budget.size).toBe(1);
  expect(budget.totalBytes).toBe(7);
});

test("deleteMatching selectively evicts and invokes callback", () => {
  const budget = new CacheBudget(50);
  const evicted: string[] = [];
  budget.set("conv1:msg1", 10, () => evicted.push("conv1:msg1"));
  budget.set("conv1:msg2", 10, () => evicted.push("conv1:msg2"));
  budget.set("conv2:msg1", 10, () => evicted.push("conv2:msg1"));

  expect(budget.size).toBe(3);
  expect(budget.totalBytes).toBe(30);

  const removed = budget.deleteMatching((k) => k.startsWith("conv1:"));
  expect(removed).toBe(2);
  expect(budget.size).toBe(1);
  expect(budget.totalBytes).toBe(10);
  expect(evicted).toEqual(["conv1:msg1", "conv1:msg2"]);
  expect(budget.has("conv2:msg1")).toBe(true);
});

test("clear evicts all entries", () => {
  const budget = new CacheBudget(50);
  const evicted: string[] = [];
  budget.set("a", 10, () => evicted.push("a"));
  budget.set("b", 10, () => evicted.push("b"));

  budget.clear();
  expect(budget.size).toBe(0);
  expect(budget.totalBytes).toBe(0);
  expect(evicted).toEqual(["a", "b"]);
});
