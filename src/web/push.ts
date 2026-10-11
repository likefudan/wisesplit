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

function toBase64Url(buffer: ArrayBuffer | null | undefined): string {
  if (!buffer) return "";
  let s = "";
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Whether push is on in this browser, telling the server its subscription again if so (the server
 * may have dropped it, or it may have been made with a key the site no longer uses: then it is
 * made again with `publicKey`).
 */
export async function checkPush(publicKey: string): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub || Notification.permission !== "granted") return false;
  if (toBase64Url(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe();
    await turnOnPush(publicKey);
    return true;
  }
  await api("/api/push/subscribe", sub.toJSON());
  return true;
}

/** Asks for permission (if not given yet), subscribes this browser and tells the server. */
export async function turnOnPush(publicKey: string): Promise<void> {
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
  await api("/api/push/unsubscribe", { endpoint });
}

/** Asks the server to send this browser a test message. */
export async function testPush(): Promise<"sent" | "gone" | "failed"> {
  const sub = await currentSubscription();
  if (!sub) return "gone";
  return (await api<{ result: "sent" | "gone" | "failed" }>("/api/push/test", { endpoint: sub.endpoint })).result;
}

/** On signing out: whoever uses this browser next mustn't get this person's notifications. */
export async function forgetPushHere(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) await turnOffPush();
  } catch {
    // Signed out anyway; the server stops sending once the push service says it is gone.
  }
}
