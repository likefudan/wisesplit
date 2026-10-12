import { fromBase64Url, toBase64Url } from "../shared/base64url";
import { api } from "./api";

// Push notifications in this browser: the service worker (public/sw.js) shows them, and the
// server (src/worker/push.ts) sends them to every browser it was given a subscription for.

/** Registers the service worker, which also lets the site be installed (Add to Home Screen). */
export function registerServiceWorker() {
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("service worker:", err));
}

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/**
 * Whether this browser can get push: "ios-install" for Safari on iPhone or iPad outside the Home
 * Screen, where Apple only allows it once the site is added there.
 */
export function pushSupport(): "ok" | "ios-install" | "unsupported" {
  if (isIos() && !isStandalone()) return "ios-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "unsupported";
  return "ok";
}

/** The browser said no to notifications (now, or earlier, for this site). */
export class PushDenied extends Error {}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

// Whose push this browser's subscription is, so someone else signing in here doesn't inherit it.
const OWNER = "push-owner";
const owner = {
  get: (): string | null => {
    try {
      return localStorage.getItem(OWNER);
    } catch {
      return null;
    }
  },
  set: (userId: string | null) => {
    try {
      if (userId) localStorage.setItem(OWNER, userId);
      else localStorage.removeItem(OWNER);
    } catch {
      // Blocked storage: nothing to go on later, so nothing is undone either.
    }
  },
};

/**
 * Unsubscribes this browser if its push is someone else's than `userId`, who has signed in here
 * (their server row went when they signed out, or goes once the push service says it is gone).
 */
export async function dropOthersPush(userId: string): Promise<void> {
  const mine = owner.get();
  if (!mine || mine === userId || !("serviceWorker" in navigator)) return;
  try {
    await (await currentSubscription())?.unsubscribe();
    owner.set(null);
  } catch {
    // Tried again on the next visit.
  }
}

/** Whether this browser has a push subscription, without asking the server anything. */
export const hasPushSubscription = async () => (await currentSubscription()) !== null;

/**
 * Whether push is on in this browser, telling the server its subscription again if so (the server
 * may have dropped it, or it may have been made with a key the site no longer uses: then it is
 * made again with `publicKey`).
 */
export async function checkPush(publicKey: string, userId: string): Promise<boolean> {
  await dropOthersPush(userId);
  const sub = await currentSubscription();
  if (!sub || Notification.permission !== "granted") return false;
  const key = sub.options.applicationServerKey;
  // A browser that doesn't say which key the subscription was made with is taken at its word.
  if (key && toBase64Url(key) !== publicKey) {
    const { endpoint } = sub;
    await sub.unsubscribe();
    await api("/api/push/unsubscribe", { endpoint }).catch(() => {});
    await turnOnPush(publicKey, userId);
    return true;
  }
  await api("/api/push/subscribe", sub.toJSON());
  owner.set(userId);
  return true;
}

/** Asks for permission (if not given yet), subscribes this browser and tells the server. */
export async function turnOnPush(publicKey: string, userId: string): Promise<void> {
  // Asked first, while the tap that turned it on still counts (Safari needs that).
  if ((await Notification.requestPermission()) !== "granted") throw new PushDenied();
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(publicKey),
  });
  try {
    await api("/api/push/subscribe", sub.toJSON());
    owner.set(userId);
  } catch (err) {
    // The server doesn't know it, so don't leave it looking on.
    await sub.unsubscribe().catch(() => {});
    throw err;
  }
}

/** Unsubscribes this browser, and tells the server (which may fail; the browser is off anyway). */
export async function turnOffPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe();
  owner.set(null);
  await api("/api/push/unsubscribe", { endpoint });
}

/** Asks the server to send this browser a test message. */
export async function testPush(): Promise<"sent" | "gone" | "failed"> {
  const sub = await currentSubscription();
  if (!sub) return "gone";
  const { result } = await api<{ result: "sent" | "gone" | "failed" }>("/api/push/test", { endpoint: sub.endpoint });
  // The push service dropped it, so it can never work again; turning push on makes a new one.
  if (result === "gone") await sub.unsubscribe().catch(() => {});
  return result;
}

/** After signing out: unsubscribes this browser (the server has already forgotten it). */
export async function forgetPushHere(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) await (await currentSubscription())?.unsubscribe();
    owner.set(null);
  } catch {
    // Signed out anyway; the server stops sending once the push service says it is gone.
  }
}
