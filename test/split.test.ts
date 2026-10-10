import { describe, expect, it } from "vitest";
import { splitEqual, spread } from "../src/shared/expenses";

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("equal split", () => {
  it("splits evenly when it divides", () => {
    expect(Object.fromEntries(splitEqual(900, ["c", "a", "b"]))).toEqual({ a: 300, b: 300, c: 300 });
  });

  it("gives the leftover cents one each to the first by user id", () => {
    // 10.00 among 3: 3.34, 3.33, 3.33, the extra cent to "a" whatever the order given.
    expect(Object.fromEntries(splitEqual(1000, ["c", "a", "b"]))).toEqual({ a: 334, b: 333, c: 333 });
    expect(Object.fromEntries(splitEqual(1001, ["c", "b", "a"]))).toEqual({ a: 334, b: 334, c: 333 });
    // Ids compare as stored (case matters), the same order the database uses.
    expect(Object.fromEntries(splitEqual(1, ["b", "B", "a"]))).toEqual({ B: 1, a: 0, b: 0 });
  });

  it("can leave someone a share of 0 when there is less than a unit each", () => {
    expect(Object.fromEntries(splitEqual(2, ["a", "b", "c"]))).toEqual({ a: 1, b: 1, c: 0 });
  });

  it("gives everything to one person alone", () => {
    expect(Object.fromEntries(splitEqual(777, ["a"]))).toEqual({ a: 777 });
  });

  it("always adds up to the total", () => {
    const ids = Array.from({ length: 13 }, (_, i) => `u${i}`);
    for (let amount = 0; amount < 500; amount += 7) {
      for (let n = 1; n <= ids.length; n++) {
        const shares = splitEqual(amount, ids.slice(0, n));
        expect(sum(shares)).toBe(amount);
        const values = [...shares.values()];
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }
    }
    expect(sum(splitEqual(10_000_000_000, ids))).toBe(10_000_000_000);
  });

  it("refuses what can't be split", () => {
    expect(() => splitEqual(100, [])).toThrow(RangeError);
    expect(() => splitEqual(100, ["a", "a"])).toThrow(RangeError);
    expect(() => splitEqual(1.5, ["a"])).toThrow(RangeError);
    expect(() => splitEqual(-1, ["a"])).toThrow(RangeError);
  });
});

describe("weighted split", () => {
  it("gives leftovers to the largest remainders first", () => {
    // 100 by 1:1:1:2 → 20, 20, 20, 40; 101 → the extra unit to the largest remainder (d, weight 2).
    expect(Object.fromEntries(spread(100, [1, 1, 1, 2], ["a", "b", "c", "d"]))).toEqual({ a: 20, b: 20, c: 20, d: 40 });
    expect(Object.fromEntries(spread(101, [1, 1, 1, 2], ["a", "b", "c", "d"]))).toEqual({ a: 20, b: 20, c: 20, d: 41 });
    expect(Object.fromEntries(spread(10, [0, 1], ["a", "b"]))).toEqual({ a: 0, b: 10 });
  });

  it("refuses weights that don't make sense", () => {
    expect(() => spread(100, [0, 0], ["a", "b"])).toThrow(RangeError);
    expect(() => spread(100, [1, -1, 1], ["a", "b", "c"])).toThrow(RangeError);
    expect(() => spread(100, [1], ["a", "b"])).toThrow(RangeError);
  });
});
