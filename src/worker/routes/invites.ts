import { Hono } from "hono";
import type { InviteInfo } from "../../shared/groups";
import { notApproved, signedIn } from "../auth";
import type { Env } from "../env";
import { isMember } from "../groups";
import { HttpError } from "../http";
import { findInvite, inviteNotFound, joinByInvite } from "../invites";

/**
 * Invite links (/invite/<token> in the app). Anyone holding the link may see which group it is
 * for; using it takes a signed-in account. New users sign up through it with POST
 * /api/auth/register and an `inviteToken` (routes/auth.ts).
 */
export const inviteRoutes = new Hono<{ Bindings: Env }>();

inviteRoutes.get("/:token", async (c) => {
  const invite = await findInvite(c.env, c.req.param("token"));
  if (!invite) throw inviteNotFound();
  const { user } = await signedIn(c);
  const info: InviteInfo = {
    groupName: invite.group_name,
    invitedBy: invite.inviter_name,
    state: invite.state,
    // Only someone who can open the group is sent there.
    memberOf: user?.status === "approved" && (await isMember(c.env, invite.group_id, user.id)) ? invite.group_id : null,
  };
  return c.json({ invite: info });
});

// A signed-up user joins the group. One already in it just gets the group back, leaving the link
// for someone else.
inviteRoutes.post("/:token/accept", async (c) => {
  const token = c.req.param("token");
  const { session, user } = await signedIn(c);
  if (!session) throw new HttpError(401, "login_required", "Sign in with Google first");
  if (!user) throw new HttpError(403, "signup_required", "Finish signing up first");
  if (user.status === "rejected" || user.status === "deactivated") throw notApproved[user.status]();
  const invite = await findInvite(c.env, token);
  if (!invite) throw inviteNotFound();
  if (!(await isMember(c.env, invite.group_id, user.id)))
    try {
      await joinByInvite(c.env, token, user);
    } catch (err) {
      // Joined meanwhile (another tab, or added by email): that's what they wanted.
      if (!(await isMember(c.env, invite.group_id, user.id))) throw err;
    }
  return c.json({ groupId: invite.group_id });
});
