import { describe, expect, it } from "vitest";
import { FULL_PERCENT, MAX_SHARES, SplitError, splitEqual, splitShares, spread } from "../src/shared/expenses";
import { MAX_AMOUNT } from "../src/shared/money";

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

const split = (...args: Parameters<typeof splitShares>) => Object.fromEntries(splitShares(...args));

/** The code of the SplitError `run` throws. */
function failure(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof SplitError) return err.code;
    throw err;
  }
  throw new Error("did not fail");
}

describe("splitShares", () => {
  it("splits equally with no parameters", () => {
    expect(split("equal", 1000, ["c", "a", "b"], null)).toEqual({ a: 334, b: 333, c: 333 });
    expect(split("equal", 1000, ["a", "b"], undefined)).toEqual({ a: 500, b: 500 });
    expect(split("equal", 1000, ["a", "b"], {})).toEqual({ a: 500, b: 500 });
    expect(failure(() => splitShares("equal", 1000, ["a", "b"], { a: 1 }))).toBe("invalid_split");
  });

  it("takes exact amounts that add up to the total", () => {
    expect(split("exact", 1000, ["a", "b", "c"], { a: 100, b: 250, c: 650 })).toEqual({ a: 100, b: 250, c: 650 });
    expect(split("exact", 7, ["a"], { a: 7 })).toEqual({ a: 7 });
    expect(failure(() => splitShares("exact", 1000, ["a", "b"], { a: 100, b: 899 }))).toBe("split_exact_total");
    expect(failure(() => splitShares("exact", 1000, ["a", "b"], { a: 100, b: 901 }))).toBe("split_exact_total");
  });

  it("splits percentages that add up to 100%, rounding by the largest remainder", () => {
    expect(split("percent", 1000, ["a", "b"], { a: 2500, b: 7500 })).toEqual({ a: 250, b: 750 });
    // 33.33 / 33.33 / 33.34 of $10.00: 3.333, 3.333, 3.334 → the leftover cent to c, the largest remainder.
    expect(split("percent", 1000, ["a", "b", "c"], { a: 3333, b: 3333, c: 3334 })).toEqual({ a: 333, b: 333, c: 334 });
    // $0.01 at 50/50 goes to the smaller id.
    expect(split("percent", 1, ["b", "a"], { a: 5000, b: 5000 })).toEqual({ a: 1, b: 0 });
    expect(split("percent", 999, ["a"], { a: FULL_PERCENT })).toEqual({ a: 999 });
    expect(failure(() => splitShares("percent", 1000, ["a", "b"], { a: 5000, b: 4999 }))).toBe("split_percent_total");
    expect(failure(() => splitShares("percent", 1000, ["a", "b"], { a: 5000, b: 5001 }))).toBe("split_percent_total");
  });

  it("splits by shares", () => {
    expect(split("shares", 1000, ["a", "b", "c"], { a: 2, b: 1, c: 1 })).toEqual({ a: 500, b: 250, c: 250 });
    // ¥1000 by 1:1:1 in yen: the extra yen to the first id.
    expect(split("shares", 1000, ["a", "b", "c"], { a: 1, b: 1, c: 1 })).toEqual({ a: 334, b: 333, c: 333 });
    expect(split("shares", 100, ["a", "b"], { a: 3, b: MAX_SHARES })).toEqual({ a: 3, b: 97 });
  });

  it("adds adjustments on top of an equal split of the rest", () => {
    // 100 among 4, Wang 10 more than the others: 22.50 each and 32.50 for Wang.
    expect(split("adjust", 10000, ["a", "b", "c", "w"], { w: 1000 })).toEqual({ a: 2250, b: 2250, c: 2250, w: 3250 });
    // Less: Ann pays 5 less, so the other two pay 5 more than her.
    expect(split("adjust", 3000, ["a", "b", "c"], { a: -500 })).toEqual({ a: 667, b: 1167, c: 1166 });
    // The rest rounds like an equal split, by id.
    expect(split("adjust", 1000, ["c", "b", "a"], { c: 1 })).toEqual({ a: 333, b: 333, c: 334 });
    // Adjustments that use up the whole total leave the others nothing.
    expect(split("adjust", 1000, ["a", "b", "c"], { a: 600, b: 400 })).toEqual({ a: 600, b: 400, c: 0 });
    expect(split("adjust", 1000, ["a", "b"], {})).toEqual({ a: 500, b: 500 });
  });

  it("refuses adjustments that leave less than nothing", () => {
    expect(failure(() => splitShares("adjust", 1000, ["a", "b"], { a: 1001 }))).toBe("split_adjust_too_large");
    expect(failure(() => splitShares("adjust", 1000, ["a", "b"], { a: 600, b: 401 }))).toBe("split_adjust_too_large");
    // Ann pays $8 less than Bob: $1 and $9. $10 less leaves her nothing; any more, less than nothing.
    expect(split("adjust", 1000, ["a", "b"], { a: -800 })).toEqual({ a: 100, b: 900 });
    expect(split("adjust", 1000, ["a", "b"], { a: -1000 })).toEqual({ a: 0, b: 1000 });
    // (At -$10.01 the odd cent of the rest goes to Ann, by id, which still leaves her 0.)
    expect(split("adjust", 1000, ["a", "b"], { a: -1001 })).toEqual({ a: 0, b: 1001 - 1 });
    expect(failure(() => splitShares("adjust", 1000, ["a", "b"], { a: -1002 }))).toBe("split_adjust_negative");
    // A positive adjustment for one can still push another below 0 when someone else takes less.
    expect(failure(() => splitShares("adjust", 1000, ["a", "b", "c"], { a: 900, b: -200 }))).toBe(
      "split_adjust_negative",
    );
  });

  it("checks the parameters fit the people and the method", () => {
    for (const [method, people, params] of [
      ["exact", ["a", "b"], null],
      ["exact", ["a", "b"], { a: 1000 }],
      ["exact", ["a"], { a: 500, b: 500 }],
      ["exact", ["a", "b"], { a: 1000, b: 0 }],
      ["exact", ["a", "b"], { a: 1100, b: -100 }],
      ["exact", ["a", "b"], { a: 999.5, b: 0.5 }],
      ["percent", ["a", "b"], { a: 10_000, b: 0 }],
      ["percent", ["a"], { a: 10_001 }],
      ["shares", ["a", "b"], { a: 1, b: 1.5 }],
      ["shares", ["a", "b"], { a: 1, b: MAX_SHARES + 1 }],
      ["shares", ["a"], { a: Number.NaN }],
      ["adjust", ["a", "b"], null],
      ["adjust", ["a", "b"], { c: 100 }],
      ["adjust", ["a", "b"], { a: 0 }],
      ["adjust", ["a", "b"], { a: 0.5 }],
      ["adjust", ["a", "b"], { a: MAX_AMOUNT + 1 }],
      ["adjust", ["a", "b"], { a: "100" }],
      // So many cents taken off that the rest is past what an expense may be.
      ["adjust", ["a", "b", "c"], { a: -MAX_AMOUNT, b: -MAX_AMOUNT }],
    ] as const)
      expect(
        failure(() => splitShares(method, 1000, people, params as never)),
        `${method} ${JSON.stringify(params)}`,
      ).toBe("invalid_split");
  });

  it("always adds up to the total", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    for (let amount = 100; amount < 3000; amount += 37) {
      const shares = Object.fromEntries(ids.map((id, i) => [id, i + 1]));
      const percents = { a: 1, b: 9, c: 990, d: 3000, e: 3000, f: 3000, g: 0 } as Record<string, number>;
      delete percents.g;
      const adjust = { a: Math.floor(amount / 3) + 1, b: -3 };
      for (const [method, people, params] of [
        ["shares", ids, shares],
        ["percent", ids.slice(0, 6), percents],
        ["adjust", ids, adjust],
      ] as const) {
        const result = splitShares(method, amount, people, params);
        expect(sum(result), `${method} ${amount}`).toBe(amount);
        expect([...result.keys()].sort()).toEqual([...people].sort());
      }
    }
  });
});
