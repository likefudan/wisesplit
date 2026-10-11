import { useEffect, useState } from "preact/hooks";
import { api } from "./api";

// The unread count on the bell, shared by every page. It is asked for when a page opens (unless it
// was just asked), every minute while the site is in view, and when it comes back into view.
const EVERY_MS = 60_000;
const FRESH_MS = 10_000;

let unread: number | null = null;
let askedAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(n: number | null) => void>();

function publish(n: number | null) {
  unread = n;
  listeners.forEach((l) => l(n));
}

/** Sets the count after something changed it here (marking read, or a list that came with it). */
export const setUnread = (n: number) => publish(n);

async function ask() {
  askedAt = Date.now();
  try {
    publish((await api<{ unread: number }>("/api/notifications/unread")).unread);
  } catch {
    // Offline or signed out meanwhile: keep showing the last count; the next try may work.
  }
}

const onVisible = () => {
  if (document.visibilityState === "visible" && Date.now() - askedAt > FRESH_MS) ask();
};

function start() {
  if (Date.now() - askedAt > FRESH_MS) ask();
  timer = setInterval(() => document.visibilityState === "visible" && ask(), EVERY_MS);
  document.addEventListener("visibilitychange", onVisible);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

/** The unread count for the bell (null until known), kept up to date while `enabled` (signed in). */
export function useUnread(enabled: boolean): number | null {
  const [n, setN] = useState(unread);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setN);
    setN(unread);
    if (listeners.size === 1) start();
    return () => {
      listeners.delete(setN);
      if (!listeners.size) stop();
    };
  }, [enabled]);
  return enabled ? n : null;
}
