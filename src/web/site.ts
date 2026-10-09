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
        staging = r.staging === true;
        if (staging) markStaging();
        listeners.forEach((l) => l(staging));
      })
      .catch(() => {
        // Try again shortly, so a page left open still learns it is on the test site.
        setTimeout(() => {
          loading = null;
          load();
        }, 15_000);
      });
}

/** Staging favicon, and a noindex for search engines that run scripts (robots.txt already says Disallow). */
function markStaging() {
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((icon) => {
    icon.href = "/favicon-staging.svg";
  });
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  document.head.appendChild(robots);
}

/** True on the test site (staging.…), which shows a banner so it is never mistaken for the real one. */
export function useStaging(): boolean {
  const [s, setS] = useState(staging);
  useEffect(() => {
    listeners.add(setS);
    // It may have loaded between the first render and this effect.
    setS(staging);
    load();
    return () => void listeners.delete(setS);
  }, []);
  return s;
}
