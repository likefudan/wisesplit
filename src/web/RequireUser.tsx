import type { VNode } from "preact";
import { useLocation } from "preact-iso";
import { useEffect } from "preact/hooks";
import { ErrorMessage, Loading, Page, useErrorText } from "./components";
import { SignedOut } from "./pages/Home";
import { type User, useSession } from "./session";

/**
 * Renders `children` for an approved user (with `isAdmin` too when `admin` is set). Anyone signed
 * out gets the sign-in page and comes back here afterwards; anyone else goes to the front page,
 * which says what they are waiting for.
 */
export function RequireUser({ admin, children }: { admin?: boolean; children: (user: User) => VNode }) {
  const session = useSession();
  const { url, route } = useLocation();
  const errorText = useErrorText();
  const user = session.state === "ok" ? session.data.user : null;
  const allowed = !!user && user.status === "approved" && (!admin || user.isAdmin);
  const signedOut = session.state === "ok" && !session.data.identity;
  useEffect(() => {
    if (session.state === "ok" && !allowed && !signedOut) route("/", true);
  }, [session.state, allowed, signedOut]);
  if (session.state === "loading")
    return (
      <Page>
        <Loading />
      </Page>
    );
  if (session.state === "error")
    return (
      <Page>
        <ErrorMessage>{errorText(session.error)}</ErrorMessage>
      </Page>
    );
  if (signedOut) return <SignedOut session={session.data} next={url} />;
  return allowed && user ? children(user) : null;
}
