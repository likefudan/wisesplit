/** True on the test site (staging.…), which shows a banner so it is never mistaken for the real one. */
export const isStaging = location.hostname.startsWith("staging.");

if (isStaging)
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((icon) => {
    icon.href = "/favicon-staging.svg";
  });
