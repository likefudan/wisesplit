import { useEffect, useState } from "preact/hooks";
import type { Lang } from "../shared/i18n";
import { ApiError, api } from "./api";
import { currentLang, setLang } from "./i18n";

export type UserStatus = "pending" | "approved" | "rejected" | "deactivated";

export interface User {
  id: string;
  name: string;
  email: string;
  picture: string | null;
  venmo: string | null;
  lang: Lang;
  status: UserStatus;
  isAdmin: boolean;
}

/** GET /api/auth/session: who is here (src/worker/routes/auth.ts). */
export interface Session {
  googleEnabled: boolean;
  turnstileSiteKey: string | null;
  testLogin: boolean;
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
    // The language saved in the profile wins over this browser's choice.
    if (data.user?.status === "approved" && data.user.lang !== currentLang()) setLang(data.user.lang);
    publish({ state: "ok", data });
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

export async function signOut(): Promise<void> {
  await api("/api/auth/logout", {});
  window.location.assign("/");
}

refreshSession();
