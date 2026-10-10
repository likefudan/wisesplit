import { useEffect, useState } from "preact/hooks";
import type { Lang } from "../shared/i18n";
import type { PublicUser } from "../shared/users";
import { ApiError, api } from "./api";
import { currentLang, setLang } from "./i18n";

export type User = PublicUser;

/** GET /api/auth/session: who is here (src/worker/routes/auth.ts). */
export interface Session {
  googleEnabled: boolean;
  turnstileSiteKey: string | null;
  /** The Google account this browser is signed in with, before or after signing up. */
  identity: { email: string; name: string; picture: string | null } | null;
  /** The account, once signed up. */
  user: User | null;
}

export type SessionState = { state: "loading" } | { state: "error"; error: ApiError } | { state: "ok"; data: Session };

let current: SessionState = { state: "loading" };
const listeners = new Set<(s: SessionState) => void>();

function publish(next: SessionState) {
  current = next;
  listeners.forEach((l) => l(next));
}

/** Loads the session again, e.g. after signing up or saving the profile; every page using it updates. */
export async function refreshSession(): Promise<void> {
  try {
    const data = await api<Session>("/api/auth/session");
    const choice = choiceWhileLoading;
    choiceWhileLoading = null;
    publish({ state: "ok", data });
    if (data.user?.status !== "approved") return;
    // A language picked while this loaded is the newest choice: save it. Otherwise the language
    // saved in the profile wins over this browser's.
    if (choice && choice !== data.user.lang) chooseLang(choice);
    else if (data.user.lang !== currentLang()) setLang(data.user.lang);
  } catch (e) {
    publish({ state: "error", error: e instanceof ApiError ? e : new ApiError("network", 0, String(e)) });
  }
}

/** Replaces the signed-up user in the session after an API call returned the new version. */
export function setUser(user: User) {
  if (current.state === "ok") publish({ state: "ok", data: { ...current.data, user } });
}

export function useSession(): SessionState {
  const [state, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    setState(current);
    return () => void listeners.delete(setState);
  }, []);
  return state;
}

let langSaves: Promise<void> = Promise.resolve();
let choiceWhileLoading: Lang | null = null;

/**
 * Switches the pages' language. Signed-in users keep the choice in their profile, so it follows
 * them to other devices; saves go one after another, so quick double clicks reach the server in
 * the order they were made.
 */
export function chooseLang(next: Lang) {
  setLang(next);
  if (current.state === "loading") choiceWhileLoading = next;
  if (current.state !== "ok" || current.data.user?.status !== "approved") return;
  langSaves = langSaves.then(async () => {
    try {
      setUser((await api<{ user: User }>("/api/me", { lang: next })).user);
    } catch {
      // The page has switched anyway; the profile keeps the old one until the next change.
    }
  });
}

/** Signs out and goes to the front page (which still shows the account if the server could not be reached). */
export async function signOut(): Promise<void> {
  try {
    await api("/api/auth/logout", {});
  } catch {
    // Nothing more to do here; the front page shows where things stand.
  }
  window.location.assign("/");
}

refreshSession();
