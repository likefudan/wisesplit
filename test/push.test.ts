import { env } from "cloudflare:workers";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/worker/lib/crypto";
import { encryptPayload, MAX_PUSH_DEVICES, type PushMessage } from "../src/worker/push";
import { json, makeUser, ORIGIN, send, signIn } from "./helpers";

afterEach(() => vi.restoreAllMocks());

/** RFC 8291's worked example (appendix A). */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A P-256 private key as JWK, from its raw private and public parts. */
function jwkOf(d: string, publicKey: string): JsonWebKey {
  const point = fromBase64Url(publicKey);
  return { kty: "EC", crv: "P-256", d, x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33)) };
}

/** A browser's side of push: its key pair and secret, and decrypting what it is sent (RFC 8291). */
async function makeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const p256dh = toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer));
  const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  return { endpoint, keys: { p256dh, auth }, privateKey: keys.privateKey, publicKey: p256dh, authSecret: auth };
}

const hmac = async (key: Uint8Array, data: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      data,
    ),
  );
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);

async function decrypt(browser: Awaited<ReturnType<typeof makeBrowser>>, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const asPublic = body.slice(21, 21 + idLength);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      browser.privateKey,
      256,
    ),
  );
  const uaPublic = fromBase64Url(browser.publicKey);
  const prkKey = await hmac(fromBase64Url(browser.authSecret), shared);
  const ikm = await hmac(prkKey, join(text("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, text("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, text("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + idLength)),
  );
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

/** A VAPID key for the site, as the VAPID_KEY secret holds it, and its public half. */
async function makeVapid() {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const { kty, crv, x, y, d } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const raw = toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer));
  return { secret: JSON.stringify({ kty, crv, x, y, d }), publicKey: raw };
}

const vapid = await makeVapid();
const withPush = { VAPID_KEY: vapid.secret };

type Person = { id: string; email: string; cookie: string };
const post = (path: string, who: Person, body: unknown) => send(path, { cookie: who.cookie, body, env: withPush });

async function subscribe(who: Person, browser: Awaited<ReturnType<typeof makeBrowser>>) {
  const res = await post("/api/push/subscribe", who, { endpoint: browser.endpoint, keys: browser.keys });
  expect(res.status).toBe(204);
}

const subscriptionsOf = async (userId: string) =>
  (
    await env.DB.prepare("SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at")
      .bind(userId)
      .all<{ endpoint: string }>()
  ).results.map((r) => r.endpoint);

/** Catches what the Worker posts to push services, answering each with `status`. */
function pushService(status = 201) {
  const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
    return new Response(null, { status });
  });
  return sent;
}

describe("push encryption", () => {
  it("matches RFC 8291's example", async () => {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { ...jwkOf(RFC.asPrivate, RFC.asPublic), key_ops: ["deriveBits"] },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(RFC.asPublic),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const body = await encryptPayload(
      text(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { keys: { privateKey, publicKey }, salt: fromBase64Url(RFC.salt) },
    );
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  it("can be read by the browser it is for", async () => {
    const browser = await makeBrowser();
    expect(await decrypt(browser, await encryptPayload(text("héllo 你好"), browser.keys))).toBe("héllo 你好");
  });
});

describe("push subscriptions", () => {
  it("gives the key browsers subscribe with, or null when push isn't set up", async () => {
    const me = await makeUser("approved");
    expect(await json(await send("/api/push", { cookie: me.cookie }))).toEqual({ publicKey: null });
    expect(await json(await send("/api/push", { cookie: me.cookie, env: withPush }))).toEqual({
      publicKey: vapid.publicKey,
    });
    expect((await send("/api/push", { env: withPush })).status).toBe(401);
  });

  it("takes subscriptions only for known push services, with valid keys", async () => {
    const me = await makeUser("approved");
    const browser = await makeBrowser();
    for (const endpoint of [
      "https://example.com/push",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
      "not a url",
    ]) {
      const res = await post("/api/push/subscribe", me, { endpoint, keys: browser.keys });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_subscription");
    }
    for (const keys of [
      { p256dh: browser.keys.p256dh, auth: "short" },
      { p256dh: "AAAA", auth: browser.keys.auth },
      {},
    ]) {
      const res = await post("/api/push/subscribe", me, { endpoint: browser.endpoint, keys });
      expect((await json(res)).error.code).toBe("invalid_subscription");
    }
    expect(await subscriptionsOf(me.id)).toEqual([]);
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGx",
      "https://wns2-by3p.notify.windows.com/w/?token=abc",
    ])
      await subscribe(me, { ...browser, endpoint });
    expect(await subscriptionsOf(me.id)).toHaveLength(3);
  });

  it("moves a browser to whoever subscribes it last, and keeps the newest few per person", async () => {
    const ann = await makeUser("approved");
    const bob = await makeUser("approved");
    const shared = await makeBrowser();
    await subscribe(ann, shared);
    await subscribe(bob, shared);
    expect(await subscriptionsOf(ann.id)).toEqual([]);
    expect(await subscriptionsOf(bob.id)).toEqual([shared.endpoint]);

    // Nor take it over knowing only its address: that needs the browser's own keys.
    const other = await makeBrowser();
    const res = await post("/api/push/subscribe", ann, { endpoint: shared.endpoint, keys: other.keys });
    expect((await json(res)).error.code).toBe("invalid_subscription");
    expect(await subscriptionsOf(bob.id)).toEqual([shared.endpoint]);

    // Ann can't turn off Bob's browser.
    expect((await post("/api/push/unsubscribe", ann, { endpoint: shared.endpoint })).status).toBe(204);
    expect(await subscriptionsOf(bob.id)).toEqual([shared.endpoint]);
    expect((await post("/api/push/unsubscribe", bob, { endpoint: shared.endpoint })).status).toBe(204);
    expect(await subscriptionsOf(bob.id)).toEqual([]);

    const browsers = [];
    for (let i = 0; i < MAX_PUSH_DEVICES + 2; i++) {
      const b = await makeBrowser();
      browsers.push(b);
      await subscribe(ann, b);
    }
    expect(await subscriptionsOf(ann.id)).toEqual(browsers.slice(2).map((b) => b.endpoint));
    // Telling the server again (each visit to the settings page does) doesn't make one newer.
    await subscribe(ann, browsers[2]!);
    await subscribe(ann, await makeBrowser());
    expect(await subscriptionsOf(ann.id)).not.toContain(browsers[2]!.endpoint);
  });

  it("turns push off for the browsers a session turned it on in when it signs out", async () => {
    const me = await makeUser("approved");
    const phone = await makeBrowser();
    await subscribe(me, phone);
    const laptop = await makeBrowser();
    const elsewhere = await signIn(me.email, `sub-${me.email}`);
    expect(
      (await send("/api/push/subscribe", { cookie: elsewhere, body: { endpoint: laptop.endpoint, keys: laptop.keys } }))
        .status,
    ).toBe(204);
    expect((await send("/api/auth/logout", { cookie: me.cookie, body: {} })).status).toBeLessThan(300);
    expect(await subscriptionsOf(me.id)).toEqual([laptop.endpoint]);
  });

  it("keeps push on when the same person signs in again, and drops it when someone else does", async () => {
    const testEnv = { ...withPush, ENVIRONMENT: "local", TEST_LOGIN_SECRET: "s3cret" };
    const login = (email: string, cookie: string) =>
      send("/api/test/login", { cookie, body: { email }, headers: { "X-Test-Login-Secret": "s3cret" }, env: testEnv });
    const ann = await makeUser("approved");
    const bob = await makeUser("approved");
    const phone = await makeBrowser();
    await subscribe(ann, phone);
    // From here on they sign in as the test login does.
    for (const p of [ann, bob])
      await env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(`test:${p.email}`, p.id).run();

    let res = await login(ann.email, ann.cookie);
    expect(res.status).toBe(204);
    const again = res.headers.getSetCookie()[0]!.split(";")[0]!;
    expect(await subscriptionsOf(ann.id)).toEqual([phone.endpoint]);

    res = await login(bob.email, again);
    expect(res.status).toBe(204);
    expect(await subscriptionsOf(ann.id)).toEqual([]);
  });

  it("refuses keys that aren't a point on the curve", async () => {
    const me = await makeUser("approved");
    const browser = await makeBrowser();
    const bad = new Uint8Array(65);
    bad[0] = 4;
    bad.fill(7, 1);
    const res = await post("/api/push/subscribe", me, {
      endpoint: browser.endpoint,
      keys: { p256dh: toBase64Url(bad), auth: browser.keys.auth },
    });
    expect((await json(res)).error.code).toBe("invalid_subscription");
  });

  it("sends a test message, and forgets a browser the push service says is gone", async () => {
    const me = await makeUser("approved");
    const browser = await makeBrowser();
    await subscribe(me, browser);
    const sent = pushService();
    expect(await json(await post("/api/push/test", me, { endpoint: browser.endpoint }))).toEqual({ result: "sent" });
    expect(sent).toHaveLength(1);
    const message = JSON.parse(await decrypt(browser, sent[0]!.body)) as PushMessage;
    expect(message).toEqual({
      title: "wisesplit",
      body: "Push notifications are on for this device.",
      url: "/notifications/settings",
      tag: "test",
    });

    // The headers a push service needs, and a VAPID token signed with the site's key.
    const { headers } = sent[0]!;
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(headers.get("TTL")).toBe("86400");
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get("Authorization") ?? "") ?? [];
    expect(k).toBe(vapid.publicKey);
    const point = fromBase64Url(vapid.publicKey);
    const key = await importJWK(
      { kty: "EC", crv: "P-256", x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33)) },
      "ES256",
    );
    const { payload } = await jwtVerify(token!, key, { audience: "https://fcm.googleapis.com" });
    expect(payload.sub).toBe(ORIGIN);
    expect(payload.exp! - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600 + 5);

    vi.restoreAllMocks();
    pushService(410);
    expect(await json(await post("/api/push/test", me, { endpoint: browser.endpoint }))).toEqual({ result: "gone" });
    expect(await subscriptionsOf(me.id)).toEqual([]);
    expect((await json(await post("/api/push/test", me, { endpoint: browser.endpoint }))).error.code).toBe(
      "push_not_subscribed",
    );
  });

  it("refuses a test message when push isn't set up", async () => {
    const me = await makeUser("approved");
    const res = await send("/api/push/test", { cookie: me.cookie, body: { endpoint: "x" } });
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("push_not_configured");
  });
});

describe("push notifications", () => {
  async function makeGroup(names: string[], currency = "USD") {
    const people: Person[] = [];
    for (const name of names) people.push(await makeUser("approved", undefined, name));
    const owner = people[0]!;
    const group = (await json(await post("/api/groups", owner, { name: "Camping weekend", currency }))).group;
    for (const p of people.slice(1))
      expect((await post(`/api/groups/${group.id}/members`, owner, { email: p.email })).status).toBe(200);
    return { id: group.id as string, people };
  }

  const addExpense = (groupId: string, by: Person, paidBy: Person, amount: number, participants: Person[]) =>
    post(`/api/groups/${groupId}/expenses`, by, {
      description: "Dinner",
      amount,
      paidBy: paidBy.id,
      date: "2026-10-01",
      splitMethod: "equal",
      participants: participants.map((p) => p.id),
    });

  it("pushes what the bell says to each browser of everyone involved, in their language", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat", "Dan"]);
    const [ann, bob, cat, dan] = people as [Person, Person, Person, Person];
    await env.DB.prepare("UPDATE users SET lang = 'zh' WHERE id = ?").bind(cat.id).run();
    const annPhone = await makeBrowser();
    const annLaptop = await makeBrowser("https://updates.push.services.mozilla.com/wpush/v2/ann");
    const bobPhone = await makeBrowser();
    const catPhone = await makeBrowser();
    const danPhone = await makeBrowser();
    await subscribe(ann, annPhone);
    await subscribe(ann, annLaptop);
    await subscribe(bob, bobPhone);
    await subscribe(cat, catPhone);
    await subscribe(dan, danPhone);
    // Ann turned notifications on the site off; push is its own switch.
    await post("/api/notifications/settings", ann, { inApp: false });

    const sent = pushService();
    // Bob adds what Ann paid for Ann, Bob and Cat; Dan is not in it, and Bob did it.
    const res = await addExpense(id, bob, ann, 3000, [ann, bob, cat]);
    expect(res.status).toBe(200);
    const expenseId = (await json(res)).expense.id;
    await vi.waitFor(() => expect(sent).toHaveLength(3));

    const read = async (browser: Awaited<ReturnType<typeof makeBrowser>>) => {
      const one = sent.find((s) => s.url === browser.endpoint);
      return one ? (JSON.parse(await decrypt(browser, one.body)) as PushMessage) : null;
    };
    const url = `/groups/${id}`;
    expect(await read(annPhone)).toEqual({
      title: "Camping weekend",
      body: "Bob added “Dinner” ($30.00), paid by you\nYour share: $10.00",
      url,
      tag: expenseId,
    });
    expect(await read(annLaptop)).toEqual(await read(annPhone));
    expect(await read(catPhone)).toEqual({
      title: "Camping weekend",
      body: "Bob 记了一笔“Dinner”（US$30.00），由 Ann 付款\n你的份额：US$10.00",
      url,
      tag: expenseId,
    });
    expect(await read(bobPhone)).toBeNull();
    expect(await read(danPhone)).toBeNull();
  });

  it("doesn't push to someone who left the group or was deactivated, and drops gone browsers", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const bobPhone = await makeBrowser();
    const catPhone = await makeBrowser();
    await subscribe(bob, bobPhone);
    await subscribe(cat, catPhone);
    await env.DB.prepare("UPDATE users SET status = 'deactivated' WHERE id = ?").bind(cat.id).run();

    const sent = pushService(410);
    expect((await addExpense(id, ann, ann, 900, [ann, bob, cat])).status).toBe(200);
    await vi.waitFor(async () => expect(await subscriptionsOf(bob.id)).toEqual([]));
    expect(sent.map((s) => s.url)).toEqual([bobPhone.endpoint]);
    expect(await subscriptionsOf(cat.id)).toEqual([catPhone.endpoint]);
  });

  it("shares out the pushes one event may send: everyone's newest browser first", async () => {
    const { id, people } = await makeGroup(["Ann", "Cat", "B1", "B2", "B3", "B4"]);
    const [ann, cat, ...busy] = people as [Person, Person, ...Person[]];
    // Cat turned push on in one browser, before the others did in 10 each: 41 browsers in all.
    const catPhone = await makeBrowser();
    await subscribe(cat, catPhone);
    for (const p of busy) for (let i = 0; i < 10; i++) await subscribe(p, await makeBrowser());
    const sent = pushService();
    expect((await addExpense(id, ann, ann, 1200, people)).status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(40));
    expect(sent.map((s) => s.url)).toContain(catPhone.endpoint);
  });

  it("still does what was asked when push fails", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await subscribe(bob, await makeBrowser());
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await addExpense(id, ann, ann, 900, [ann, bob])).status).toBe(200);
    expect((await json(await send("/api/notifications/unread", { cookie: bob.cookie }))).unread).toBeGreaterThan(0);
  });
});

describe("web app manifest", () => {
  it("names the site, and the test site as such", async () => {
    const live = await send("/manifest.webmanifest");
    expect(live.headers.get("Content-Type")).toBe("application/manifest+json");
    expect(await live.json()).toMatchObject({
      name: "wisesplit",
      display: "standalone",
      icons: expect.arrayContaining([expect.objectContaining({ src: "/icons/icon-192.png" })]),
    });
    const staging = await send("/manifest.webmanifest", { env: { ENVIRONMENT: "staging" } });
    expect(await staging.json()).toMatchObject({
      name: "wisesplit (test)",
      icons: expect.arrayContaining([expect.objectContaining({ src: "/icons/staging-icon-192.png" })]),
    });
  });
});
