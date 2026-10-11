import { importJWK, SignJWT } from "jose";
import type { Currency } from "../shared/currencies";
import { type Lang, translate } from "../shared/i18n";
import { notificationText } from "../shared/notifications";
import type { Env } from "./env";
import type { Note } from "./notifications";
import { HttpError, now } from "./http";
import { concat } from "./lib/bytes";
import { fromBase64Url, toBase64Url } from "./lib/crypto";

/**
 * Web Push, sent straight from the Worker: each message is encrypted for the browser that gets it
 * (RFC 8291, aes128gcm) and signed with this site's VAPID key (RFC 8292), all with Web Crypto.
 * No third-party service sits in between, only each browser maker's own push service.
 */

/** A browser's push subscription, as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker (src/web/public/sw.js) shows. */
export interface PushMessage {
  title: string;
  body: string;
  /** The page to open when the notification is tapped (a path on this site). */
  url: string;
  /** A newer message with the same tag replaces the one still showing. */
  tag: string;
}

/** Browsers per person that get push; turning it on in one more drops the one turned on longest ago. */
export const MAX_PUSH_DEVICES = 10;

/** Messages one event sends at most (Workers on the free plan may make 50 requests per request). */
const MAX_PUSHES = 40;

/**
 * How long one event's pushes may take in all (ms). They go out after the answer, which Workers
 * allow 30 seconds; this leaves time to remove the subscriptions found gone.
 */
const PUSH_BUDGET_MS = 20_000;

/** How long a push service keeps a message for a phone that is off (seconds). */
const TTL = 24 * 3600;

// The push services of Chrome (and Edge, Opera…), Firefox, Windows and Safari. A subscription
// elsewhere is refused, so the Worker can't be made to post to any address someone gives it.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

const enc = new TextEncoder();

/** HKDF-SHA-256 (RFC 5869): `length` bytes from `ikm`, with `salt` and `info`. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function decodeKey(value: string, length: number): Uint8Array | null {
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

function isPushService(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return endpoint.length <= 1000 && url.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

async function isP256Point(point: Uint8Array): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", point, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

/** Checks a subscription a browser sent; throws 400 if it is not one this site can push to. */
export async function parseSubscription(body: Record<string, unknown>): Promise<PushSubscriptionInput> {
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const { endpoint } = body;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  if (typeof endpoint !== "string" || !isPushService(endpoint))
    throw new HttpError(400, "invalid_subscription", "Not a push service this site knows");
  // An uncompressed P-256 point, and a 16-byte secret.
  const point = decodeKey(p256dh, 65);
  if (point?.[0] !== 4 || !decodeKey(auth, 16) || !(await isP256Point(point)))
    throw new HttpError(400, "invalid_subscription", "The subscription's keys are not valid");
  return { endpoint, p256dh, auth };
}

/**
 * Encrypts `plaintext` for a browser (RFC 8291): an ECDH key agreement between a key pair made
 * for this message and the browser's key, mixed with the browser's secret, gives the AES-128-GCM
 * key; the body is one aes128gcm record (RFC 8188) behind a header carrying the salt and this
 * message's public key. `fixed` is for the RFC's test vector only.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  to: { p256dh: string; auth: string },
  fixed?: { keys: CryptoKeyPair; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(to.p256dh);
  const authSecret = fromBase64Url(to.auth);
  const keys =
    fixed?.keys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The types call it `$public`; Web Crypto (and the Workers runtime) takes `public`.
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      keys.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(authSecret, shared, concat([enc.encode("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (here the only) record.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat([plaintext, new Uint8Array([2])])),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat([salt, recordSize, new Uint8Array([asPublic.length]), asPublic, sealed]);
}

/** This site's VAPID key (the VAPID_KEY secret, a P-256 private key as JWK), or null if not set up. */
export function vapidKey(env: Env): { jwk: JsonWebKey; publicKey: string } | null {
  if (!env.VAPID_KEY) return null;
  try {
    const jwk = JSON.parse(env.VAPID_KEY) as JsonWebKey;
    const x = decodeKey(jwk.x ?? "", 32);
    const y = decodeKey(jwk.y ?? "", 32);
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !x || !y) throw new Error("not a P-256 private key");
    // The public key as browsers take it (applicationServerKey): the uncompressed point.
    return { jwk, publicKey: toBase64Url(concat([new Uint8Array([4]), x, y])) };
  } catch (err) {
    console.error("VAPID_KEY is not valid:", err);
    return null;
  }
}

// The VAPID key, imported once per Worker instance (and again only if the secret changes).
let imported: { secret: string; key: Promise<CryptoKey | Uint8Array> } | null = null;
function signingKey(secret: string, jwk: JsonWebKey) {
  if (imported?.secret !== secret) {
    const key = importJWK(jwk, "ES256");
    imported = { secret, key };
    // A key that won't import is tried again next time rather than remembered.
    key.catch(() => {
      if (imported?.key === key) imported = null;
    });
  }
  return imported.key;
}

/** Sends one message, giving up after `timeoutMs`. */
type Sender = (
  sub: PushSubscriptionInput,
  message: PushMessage,
  timeoutMs?: number,
) => Promise<"sent" | "gone" | "failed">;

/** Sends messages signed with this site's key; null if push isn't set up. */
async function sender(env: Env): Promise<Sender | null> {
  const vapid = vapidKey(env);
  if (!vapid) return null;
  const key = await signingKey(env.VAPID_KEY!, vapid.jwk);
  // One token per push service (its origin is the token's audience), good for 12 hours.
  const tokens = new Map<string, Promise<string>>();
  const token = (audience: string) => {
    let t = tokens.get(audience);
    if (!t) {
      t = new SignJWT({})
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setAudience(audience)
        .setExpirationTime("12h")
        // Who runs the sender, which push services require to be https: (or mailto:); a local
        // site on http://localhost names the real one.
        .setSubject(env.SITE_ORIGIN.startsWith("https:") ? env.SITE_ORIGIN : "https://wisesplit.llmat.dev")
        .sign(key);
      tokens.set(audience, t);
    }
    return t;
  };
  return async (sub, message, timeoutMs = 10_000) => {
    try {
      const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub);
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: `vapid t=${await token(new URL(sub.endpoint).origin)}, k=${vapid.publicKey}`,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(TTL),
          Urgency: "normal",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return "sent";
      // The browser unsubscribed, or the subscription expired: it will never work again.
      if (res.status === 404 || res.status === 410) return "gone";
      console.warn("push refused:", res.status, new URL(sub.endpoint).hostname, (await res.text()).slice(0, 300));
      return "failed";
    } catch (err) {
      console.warn("push failed:", new URL(sub.endpoint).hostname, err);
      return "failed";
    }
  };
}

async function forget(env: Env, endpoints: string[]) {
  if (endpoints.length)
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(endpoints))
      .run();
}

/**
 * At most `max` of `subs` (newest first), shared out fairly: everyone's newest browser, then
 * everyone's second newest, and so on.
 */
function fairShare<T extends { user_id: string }>(subs: T[], max: number): T[] {
  const seen = new Map<string, number>();
  const ranked = subs.map((sub, i) => {
    const rank = seen.get(sub.user_id) ?? 0;
    seen.set(sub.user_id, rank + 1);
    return { sub, rank, i };
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, max)
    .map((r) => r.sub);
}

/**
 * Runs `task` on each item, a few at a time: a Worker keeps only six connections open at once, so
 * any more would wait in line while their timeouts ran.
 */
async function inTurn<T>(items: T[], task: (item: T) => Promise<void>, atOnce = 6): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
}

/**
 * Pushes each note to every browser its reader turned push on in, in the reader's language, if
 * they are still approved and (for a group's event) still in the group. Subscriptions the push
 * service says are gone are removed. Never throws.
 */
export async function pushNotes(
  env: Env,
  event: { actorId: string; groupId: string | null; subjectId: string | null },
  notes: Note[],
): Promise<void> {
  try {
    const send = await sender(env);
    if (!send || !notes.length) return;
    const readers = [...new Set(notes.map((n) => n.userId))];
    const mentioned = new Set<string>([event.actorId]);
    // Whoever did it, and who paid an expense, are the only names the messages give.
    for (const n of notes) if (n.kind === "expense.added") mentioned.add(n.data.paidBy);
    const [subs, users, groups] = await env.DB.batch([
      env.DB.prepare(
        `SELECT s.endpoint, s.p256dh, s.auth, s.user_id, u.lang FROM push_subscriptions s JOIN users u ON u.id = s.user_id
         WHERE s.user_id IN (SELECT value FROM json_each(?)) AND u.status = 'approved'
           AND (? IS NULL OR EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = s.user_id))
         ORDER BY s.created_at DESC`,
      ).bind(JSON.stringify(readers), event.groupId, event.groupId),
      env.DB.prepare("SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))").bind(
        JSON.stringify([...mentioned]),
      ),
      env.DB.prepare("SELECT name, currency FROM groups WHERE id = ?").bind(event.groupId),
    ]);
    const names = new Map((users!.results as { id: string; name: string }[]).map((u) => [u.id, u.name]));
    const group = (groups!.results as { name: string; currency: Currency }[])[0] ?? null;
    const gone: string[] = [];
    const chosen = fairShare(subs!.results as (PushSubscriptionInput & { user_id: string; lang: Lang })[], MAX_PUSHES);
    const deadline = Date.now() + PUSH_BUDGET_MS;
    await inTurn(chosen, async (sub) => {
      // A slow push service mustn't use up the time the rest (and the clean-up) need.
      const left = deadline - Date.now();
      if (left < 1000) return;
      const note = notes.find((n) => n.userId === sub.user_id)!;
      const said = notificationText({ ...note, actorId: event.actorId, group }, sub.lang, (id) =>
        id === sub.user_id
          ? translate(sub.lang, "notifications.you")
          : (id && names.get(id)) || translate(sub.lang, "activity.someone"),
      );
      if (!said) return;
      const message: PushMessage = {
        title: group?.name ?? translate(sub.lang, "app.name"),
        body: said.detail ? `${said.text}\n${said.detail}` : said.text,
        url: event.groupId ? `/groups/${encodeURIComponent(event.groupId)}` : "/",
        tag: event.subjectId ?? event.groupId ?? note.kind,
      };
      if ((await send(sub, message, Math.min(5000, left))) === "gone") gone.push(sub.endpoint);
    });
    await forget(env, gone);
  } catch (err) {
    console.error("pushing failed:", err);
  }
}

/**
 * Turns push on for a browser, as `userId` in the session `session`: moving it from whoever had it
 * before (the same browser, signed in as someone else), but keeping when it was first turned on if
 * it was theirs. Taking it from someone else needs the browser's own keys, not just its address.
 */
export async function subscribe(
  env: Env,
  userId: string,
  session: string | null,
  sub: PushSubscriptionInput,
): Promise<void> {
  const [saved] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, session_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         session_hash = excluded.session_hash,
         created_at = CASE WHEN user_id = excluded.user_id THEN created_at ELSE excluded.created_at END
       WHERE user_id = excluded.user_id OR (p256dh = excluded.p256dh AND auth = excluded.auth)`,
    ).bind(sub.endpoint, userId, sub.p256dh, sub.auth, session, now()),
    env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
         (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).bind(userId, userId, MAX_PUSH_DEVICES),
  ]);
  if (!saved?.meta.changes)
    throw new HttpError(400, "invalid_subscription", "This subscription belongs to another browser");
}

/** Turns push off for a browser of `userId`'s (nothing if it isn't theirs). */
export async function unsubscribe(env: Env, userId: string, endpoint: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
    .bind(endpoint, userId)
    .run();
}

/** Sends one browser of `userId`'s a message saying push works, in their language. */
export async function pushTest(env: Env, userId: string, endpoint: string): Promise<"sent" | "gone" | "failed"> {
  const send = await sender(env);
  if (!send) throw new HttpError(503, "push_not_configured", "Push notifications are not set up on this site");
  const sub = await env.DB.prepare(
    `SELECT s.endpoint, s.p256dh, s.auth, u.lang FROM push_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.endpoint = ? AND s.user_id = ?`,
  )
    .bind(endpoint, userId)
    .first<PushSubscriptionInput & { lang: Lang }>();
  if (!sub) throw new HttpError(404, "push_not_subscribed", "Push is not on in this browser");
  const result = await send(sub, {
    title: translate(sub.lang, "app.name"),
    body: translate(sub.lang, "push.test"),
    url: "/notifications/settings",
    tag: "test",
  });
  if (result === "gone") await forget(env, [sub.endpoint]);
  return result;
}
