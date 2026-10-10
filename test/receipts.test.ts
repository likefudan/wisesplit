import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RECEIPT_MAX_BYTES } from "../src/shared/receipts";
import worker from "../src/worker/index";
import { cleanUpReceipts, ORPHAN_AGE_MS, stripJpegMetadata } from "../src/worker/receipts";
import { ADMIN_EMAIL, json, makeUser, ORIGIN, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });
type Person = { id: string; email: string; cookie: string };

const bytes = (text: string) => [...new TextEncoder().encode(text)];
/** A JPEG segment: marker, then its length (which counts itself) and payload. */
const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];
const JFIF = segment(0xe0, bytes("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
const QUANT = segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
/** Baseline frame header: 8 bits, 16 × 16, one component. */
const FRAME = segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
const SCAN = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0x56, 0xff, 0xd9];

/** A JPEG as far as the server looks: its segments up to the scan, with EXIF (GPS) and a comment. */
const photo = (scan = SCAN) =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...JFIF,
    ...segment(0xe1, bytes("Exif\0\0GPS 37.7749 N 122.4194 W")),
    ...segment(0xfe, bytes("taken by Ann's phone")),
    ...QUANT,
    ...FRAME,
    ...scan,
  ]);
/** The same without what the server strips. */
const stripped = (scan = SCAN) => Uint8Array.from([0xff, 0xd8, ...QUANT, ...FRAME, ...scan]);

/** Sends a receipt photo the way the page does: the bytes as the body. */
function upload(path: string, cookie: string, body: Uint8Array, type = "image/jpeg", origin = ORIGIN) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": type, Origin: origin },
      body,
    }),
    { ...env, SITE_ORIGIN: ORIGIN, ADMIN_EMAILS: ADMIN_EMAIL },
    {} as ExecutionContext,
  );
}

async function makeGroup(names: string[]) {
  const people: Person[] = [];
  for (const name of names) people.push(await makeUser("approved", undefined, name));
  const owner = people[0]!;
  const group = (await json(await post("/api/groups", owner.cookie, { name: "Trip", currency: "USD" }))).group;
  for (const p of people.slice(1))
    expect((await post(`/api/groups/${group.id}/members`, owner.cookie, { email: p.email })).status).toBe(200);
  return { id: group.id as string, people };
}

async function addExpense(groupId: string, by: Person, paidBy: Person, participants: Person[], amount = 1000) {
  const res = await post(`/api/groups/${groupId}/expenses`, by.cookie, {
    description: "Dinner",
    amount,
    paidBy: paidBy.id,
    date: "2026-10-01",
    splitMethod: "equal",
    participants: participants.map((p) => p.id),
  });
  expect(res.status).toBe(200);
  return (await json(res)).expense.id as string;
}

const receiptOf = (groupId: string, expenseId: string) => `/api/groups/${groupId}/expenses/${expenseId}/receipt`;
const objectsOf = async (groupId: string) =>
  (await env.RECEIPTS.list({ prefix: `receipts/${groupId}/` })).objects.map((o) => o.key);
const logOf = async (expenseId: string) =>
  (
    await env.DB.prepare("SELECT action, actor_id FROM activity_log WHERE subject_id = ? ORDER BY rowid")
      .bind(expenseId)
      .all<{ action: string; actor_id: string }>()
  ).results;

describe("receipt photos", () => {
  it("any member adds one, everyone in the group sees it, without its EXIF", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const expenseId = await addExpense(id, ann, ann, [ann, bob]);

    const res = await upload(receiptOf(id, expenseId), bob.cookie, photo());
    expect(res.status).toBe(200);
    const { receipt } = await json(res);
    expect(receipt).toMatch(/^[\w-]{22}$/);
    const list = await json(await send(`/api/groups/${id}/expenses`, { cookie: ann.cookie }));
    expect(list.expenses[0]).toMatchObject({ id: expenseId, receipt });

    const got = await send(`${receiptOf(id, expenseId)}?v=${receipt}`, { cookie: ann.cookie });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/jpeg");
    expect(got.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(stripped());
    const row = await env.DB.prepare("SELECT * FROM receipts WHERE expense_id = ?").bind(expenseId).first<any>();
    expect(row).toMatchObject({ id: receipt, size: stripped().length, uploaded_by: bob.id });
    expect(await objectsOf(id)).toEqual([row.object_key]);

    // The browser's copy is still good: no body.
    const again = await send(receiptOf(id, expenseId), {
      cookie: ann.cookie,
      headers: { "If-None-Match": got.headers.get("ETag")! },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    expect(await logOf(expenseId)).toEqual([
      { action: "expense.added", actor_id: ann.id },
      { action: "receipt.added", actor_id: bob.id },
    ]);
  });

  it("replacing one deletes the old photo", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const expenseId = await addExpense(id, ann, ann, [bob]);
    const first = (await json(await upload(receiptOf(id, expenseId), ann.cookie, photo()))).receipt;
    const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x99, 0xff, 0xd9];
    const second = (await json(await upload(receiptOf(id, expenseId), bob.cookie, photo(scan)))).receipt;
    expect(second).not.toBe(first);
    const keys = await objectsOf(id);
    expect(keys).toEqual([`receipts/${id}/${expenseId}/${second}.jpg`]);
    const got = await send(receiptOf(id, expenseId), { cookie: ann.cookie });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(stripped(scan));
    expect((await logOf(expenseId)).map((l) => l.action)).toEqual([
      "expense.added",
      "receipt.added",
      "receipt.replaced",
    ]);
  });

  it("removing one deletes the photo; removing none is fine", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const expenseId = await addExpense(id, ann, ann, [bob]);
    expect((await upload(receiptOf(id, expenseId), ann.cookie, photo())).status).toBe(200);
    expect((await post(`${receiptOf(id, expenseId)}/delete`, bob.cookie)).status).toBe(204);
    expect(await objectsOf(id)).toEqual([]);
    const got = await send(receiptOf(id, expenseId), { cookie: ann.cookie });
    expect(got.status).toBe(404);
    expect((await json(got)).error.code).toBe("receipt_not_found");
    const list = await json(await send(`/api/groups/${id}/expenses`, { cookie: ann.cookie }));
    expect(list.expenses[0].receipt).toBeNull();

    expect((await post(`${receiptOf(id, expenseId)}/delete`, bob.cookie)).status).toBe(204);
    expect((await logOf(expenseId)).map((l) => l.action)).toEqual([
      "expense.added",
      "receipt.added",
      "receipt.removed",
    ]);
    const res = await post(`${receiptOf(id, "nope")}/delete`, bob.cookie);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("expense_not_found");
  });

  it("only the group's members can see or change it", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const expenseId = await addExpense(id, ann, ann, [ann, bob]);
    expect((await upload(receiptOf(id, expenseId), ann.cookie, photo())).status).toBe(200);
    const outsider = await makeUser("approved");
    expect((await send(receiptOf(id, expenseId), { cookie: outsider.cookie })).status).toBe(404);
    expect((await upload(receiptOf(id, expenseId), outsider.cookie, photo())).status).toBe(404);
    expect((await post(`${receiptOf(id, expenseId)}/delete`, outsider.cookie)).status).toBe(404);
    expect((await send(receiptOf(id, expenseId))).status).toBe(401);
    // Writes need this site's Origin, like every other.
    expect(
      (await upload(receiptOf(id, expenseId), ann.cookie, photo(), "image/jpeg", "https://evil.test")).status,
    ).toBe(403);

    // An expense of another group, asked for through this one.
    const other = await makeGroup(["Dan"]);
    const otherExpense = await addExpense(other.id, other.people[0]!, other.people[0]!, [other.people[0]!]);
    expect((await upload(receiptOf(other.id, otherExpense), other.people[0]!.cookie, photo())).status).toBe(200);
    expect((await send(receiptOf(id, otherExpense), { cookie: ann.cookie })).status).toBe(404);
    const res = await upload(receiptOf(id, otherExpense), ann.cookie, photo());
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("expense_not_found");
    expect((await post(`${receiptOf(id, otherExpense)}/delete`, ann.cookie)).status).toBe(404);
    expect(await objectsOf(other.id)).toHaveLength(1);

    // Someone who leaves can't load it any more.
    expect((await send(receiptOf(id, expenseId), { cookie: cat.cookie })).status).toBe(200);
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
    expect((await send(receiptOf(id, expenseId), { cookie: cat.cookie })).status).toBe(404);
  });

  it("takes only a JPEG of at most 2 MB", async () => {
    const { id, people } = await makeGroup(["Ann"]);
    const [ann] = people as [Person];
    const expenseId = await addExpense(id, ann, ann, [ann]);
    const path = receiptOf(id, expenseId);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    for (const [body, type, status] of [
      [photo(), "image/png", 415],
      [photo(), "application/octet-stream", 415],
      [png, "image/jpeg", 400],
      [new Uint8Array(), "image/jpeg", 400],
      // Cut off before the image data.
      [photo().subarray(0, 30), "image/jpeg", 400],
      [photo(Array.from({ length: RECEIPT_MAX_BYTES }, () => 0)), "image/jpeg", 413],
    ] as const) {
      const res = await upload(path, ann.cookie, body, type);
      expect(res.status, `${type} ${body.length}`).toBe(status);
      expect((await json(res)).error.code).toBe(status === 413 ? "receipt_too_large" : "invalid_receipt");
    }
    expect(await objectsOf(id)).toEqual([]);
    expect((await upload(path, ann.cookie, photo(), "image/jpeg; charset=binary")).status).toBe(200);
  });

  it("deleting the group deletes its photos", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const a = await addExpense(id, ann, ann, [ann, bob]);
    const b = await addExpense(id, bob, bob, [ann, bob]);
    for (const expenseId of [a, b])
      expect((await upload(receiptOf(id, expenseId), ann.cookie, photo())).status).toBe(200);
    expect(await objectsOf(id)).toHaveLength(2);
    expect((await post(`/api/groups/${id}/delete`, ann.cookie)).status).toBe(204);
    expect(await objectsOf(id)).toEqual([]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM receipts WHERE expense_id IN (?, ?)").bind(a, b).first("n"),
    ).toBe(0);
  });

  it("the daily clean-up removes photos no expense uses, once they are an hour old", async () => {
    const { id, people } = await makeGroup(["Ann"]);
    const [ann] = people as [Person];
    const expenseId = await addExpense(id, ann, ann, [ann]);
    expect((await upload(receiptOf(id, expenseId), ann.cookie, photo())).status).toBe(200);
    const orphan = `receipts/${id}/${expenseId}/left-behind.jpg`;
    await env.RECEIPTS.put(orphan, stripped());
    const [used] = (await objectsOf(id)).filter((k) => k !== orphan);

    // Too new: it may be an upload whose row is about to be written.
    await cleanUpReceipts(env);
    expect(await objectsOf(id)).toContain(orphan);
    expect(await cleanUpReceipts(env, Date.now() + ORPHAN_AGE_MS + 1000)).toBeGreaterThanOrEqual(1);
    expect(await objectsOf(id)).toEqual([used]);
    expect((await send(receiptOf(id, expenseId), { cookie: ann.cookie })).status).toBe(200);
  });
});

describe("stripJpegMetadata", () => {
  const strip = (data: number[]) => stripJpegMetadata(Uint8Array.from(data));

  it("drops EXIF, IPTC, thumbnails and comments, and keeps what changes how it looks", () => {
    const icc = segment(0xe2, bytes("ICC_PROFILE\0\x01\x01"));
    const mpf = segment(0xe2, bytes("MPF\0"));
    const adobe = segment(0xee, bytes("Adobe"));
    const iptc = segment(0xed, bytes("Photoshop 3.0\0"));
    const jfxx = segment(0xe0, bytes("JFXX\0\x10 a thumbnail"));
    expect(strip([0xff, 0xd8, ...JFIF, ...jfxx, ...icc, ...mpf, ...iptc, 0xff, ...adobe, ...FRAME, ...SCAN])).toEqual(
      Uint8Array.from([0xff, 0xd8, ...icc, ...adobe, ...FRAME, ...SCAN]),
    );
  });

  it("follows the scans, keeping restarts and escaped bytes, and drops what lies between them and after the end", () => {
    const scan1 = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x01, 0xff, 0x00, 0x02, 0xff, 0xd0, 0x03];
    const scan2 = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x04, 0xff, 0xff, 0xd9];
    const exif = segment(0xe1, bytes("Exif\0\0GPS"));
    const comment = segment(0xfe, bytes("hi"));
    // A second picture after the end of the first, with its own EXIF, as phones add.
    const second = [0xff, 0xd8, ...exif, ...FRAME, ...SCAN];
    expect(strip([0xff, 0xd8, ...FRAME, ...scan1, ...exif, ...comment, ...scan2, ...second])).toEqual(
      // (Less the fill byte before the end.)
      Uint8Array.from([0xff, 0xd8, ...FRAME, ...scan1, ...scan2.slice(0, -3), 0xff, 0xd9]),
    );
  });

  it("refuses what isn't a whole JPEG", () => {
    for (const data of [
      [],
      [0xff, 0xd8],
      [0x89, 0x50, 0x4e, 0x47],
      [0xff, 0xd8, ...JFIF],
      [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 1, 2],
      [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, ...FRAME, ...SCAN],
      [0xff, 0xd8, 0x12, 0x34, ...FRAME, ...SCAN],
      [0xff, 0xd8, 0xff, 0xd8, ...FRAME, ...SCAN],
      // No frame header, no scan, or no end.
      [0xff, 0xd8, ...SCAN],
      [0xff, 0xd8, ...FRAME, 0xff, 0xd9],
      [0xff, 0xd8, ...FRAME, ...SCAN.slice(0, -2)],
      // Anything at all after a bare scan header.
      [0xff, 0xd8, ...FRAME, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, ...bytes("PK\x03\x04 a zip file")],
    ])
      expect(strip(data), JSON.stringify(data)).toBeNull();
  });
});
