import { useEffect, useState } from "preact/hooks";
import { api } from "./api";

// Fetched once per page load and shared by every page.
let staging = false;
let loading: Promise<void> | null = null;
const listeners = new Set<(s: boolean) => void>();

function load() {
  if (!loading)
    loading = api<{ staging: boolean }>("/api/site")
      .then((r) => {
        staging = r.staging;
        if (staging)
          document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((icon) => {
            icon.href = "/favicon-staging.svg";
          });
        listeners.forEach((l) => l(staging));
      })
      .catch(() => {
        // Try again on the next page that asks.
        loading = null;
      });
}

/** True on the test site (staging.…), which shows a banner so it is never mistaken for the real one. */
export function useStaging(): boolean {
  const [s, setS] = useState(staging);
  useEffect(() => {
    listeners.add(setS);
    load();
    return () => void listeners.delete(setS);
  }, []);
  return s;
}
