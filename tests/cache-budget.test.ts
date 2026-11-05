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
