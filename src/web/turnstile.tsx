import { useEffect, useRef, useState } from "preact/hooks";
import { useI18n } from "./i18n";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, options: Record<string, unknown>): string;
      remove(id: string): void;
    };
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Let a retry add the script again.
      script.remove();
      loading = null;
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare's human check. Calls `onToken` with the answer to send along with the form, and with
 * "" whenever there is no usable answer (expired, failed, or a new widget). Each answer works only
 * once, so the form changes `resetKey` after sending one to get a fresh widget.
 */
export function Turnstile({
  siteKey,
  onToken,
  resetKey,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  resetKey: number;
}) {
  const { lang, t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let widget: string | null = null;
    callback.current("");
    setFailed(false);
    loadScript()
      .then(() => {
        if (!alive || !box.current || !window.turnstile) return;
        widget = window.turnstile.render(box.current, {
          sitekey: siteKey,
          language: lang === "zh" ? "zh-cn" : "en",
          callback: (token: string) => callback.current(token),
          "expired-callback": () => callback.current(""),
          "error-callback": () => callback.current(""),
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [siteKey, lang, resetKey, attempt]);

  return (
    <div class="turnstile">
      <div ref={box} />
      {failed && (
        <p class="error" role="alert">
          {t("signup.turnstileFailed")}{" "}
          <button type="button" class="button small secondary" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </p>
      )}
    </div>
  );
}
