import { describe, expect, it } from "vitest";
import type { Balance } from "../src/shared/expenses";
import { simplifyDebts, type Transfer, venmoLink, venmoNote } from "../src/shared/settlements";

const b = (userId: string, net: number): Balance => ({ userId, name: userId.toUpperCase(), net });
const pairs = (ts: Transfer[]) => ts.map((t) => [t.fromId, t.toId, t.amount]);

/** Everyone's balance after the transfers are made: all 0 when they settle the group. */
function after(balances: Balance[], transfers: Transfer[]) {
  const net = new Map(balances.map((x) => [x.userId, x.net]));
  for (const t of transfers) {
    net.set(t.fromId, net.get(t.fromId)! + t.amount);
    net.set(t.toId, net.get(t.toId)! - t.amount);
  }
  return [...net.values()];
}

describe("simplifyDebts", () => {
  it("suggests nothing when everyone is settled", () => {
    expect(simplifyDebts([])).toEqual([]);
    expect(simplifyDebts([b("a", 0), b("b", 0)])).toEqual([]);
  });

  it("turns a chain into one payment", () => {
    // A owes B 10, B owes C 10: B is even, A pays C.
    expect(pairs(simplifyDebts([b("a", -10), b("b", 0), b("c", 10)]))).toEqual([["a", "c", 10]]);
  });

  it("pays the one owed most first, from the one who owes most", () => {
    const balances = [b("a", -500), b("b", -300), b("c", 600), b("d", 200)];
    const ts = simplifyDebts(balances);
    expect(pairs(ts)).toEqual([
      ["a", "c", 500],
      ["b", "d", 200],
      ["b", "c", 100],
    ]);
    expect(ts[0]).toMatchObject({ fromName: "A", toName: "C" });
    expect(after(balances, ts)).toEqual([0, 0, 0, 0]);
  });

  it("breaks ties by user id, so the same balances always give the same answer", () => {
    const one = simplifyDebts([b("y", -5), b("x", -5), b("q", 5), b("p", 5)]);
    const two = simplifyDebts([b("p", 5), b("x", -5), b("q", 5), b("y", -5)]);
    expect(pairs(one)).toEqual([
      ["x", "p", 5],
      ["y", "q", 5],
    ]);
    expect(pairs(two)).toEqual(pairs(one));
  });

  it("settles any balances with fewer payments than people", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(random() * 9);
      const nets = Array.from({ length: n - 1 }, () => Math.floor(random() * 20001) - 10000);
      nets.push(-nets.reduce((s, x) => s + x, 0));
      const balances = nets.map((net, i) => b(`u${i}`, net));
      const ts = simplifyDebts(balances);
      expect(after(balances, ts).every((x) => x === 0)).toBe(true);
      expect(ts.length).toBeLessThanOrEqual(Math.max(0, balances.filter((x) => x.net !== 0).length - 1));
      for (const t of ts) {
        expect(t.amount).toBeGreaterThan(0);
        expect(Number.isSafeInteger(t.amount)).toBe(true);
        // Nobody both pays and is paid.
        expect(ts.some((u) => u.toId === t.fromId)).toBe(false);
      }
    }
  });

  it("refuses balances that don't add up", () => {
    expect(() => simplifyDebts([b("a", -1), b("b", 2)])).toThrow(RangeError);
  });
});

describe("venmoLink", () => {
  it("prefills the payee, the amount in dollars and the note", () => {
    const url = new URL(venmoLink("Ann-Lee_1", 1205, venmoNote("Camping weekend")));
    expect(url.origin).toBe("https://venmo.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      txn: "pay",
      audience: "private",
      recipients: "Ann-Lee_1",
      amount: "12.05",
      note: "wisesplit: Camping weekend",
    });
    expect(url.search).toContain("note=wisesplit%3A%20Camping%20weekend");
    expect(new URL(venmoLink("bob99", 7, "x")).searchParams.get("amount")).toBe("0.07");
    expect(new URL(venmoLink("bob99", 100000, "露营 & more")).searchParams.get("note")).toBe("露营 & more");
  });
});
