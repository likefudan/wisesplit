import type { Currency } from "./currencies";

/** How long an invite link works. */
export const INVITE_DAYS = 7;

export const GROUP_NAME_MAX = 60;

/**
 * Unused, unexpired invite links one member may have at a time, across all their groups. Each
 * lets someone skip the approval queue. (error.too_many_invites in i18n.ts names the number.)
 */
export const MAX_OPEN_INVITES = 10;

/** A group in the my-groups list (src/worker/routes/groups.ts). */
export interface GroupSummary {
  id: string;
  name: string;
  currency: Currency;
  ownerId: string;
  memberCount: number;
}

export interface GroupMember {
  id: string;
  name: string;
  picture: string | null;
  /** Deactivated by the site admin: still listed, since their records stay. */
  deactivated: boolean;
  joinedAt: string;
}

/** A group's page, for one of its members. */
export interface GroupDetail extends GroupSummary {
  createdAt: string;
  members: GroupMember[];
}

/** What an invite link shows before it is used (src/worker/routes/invites.ts). */
export interface InviteInfo {
  groupName: string;
  invitedBy: string;
  /** "revoked": the member who made it has left the group or can no longer use the site. */
  state: "valid" | "used" | "expired" | "revoked";
  /** Set when the signed-in user is already in the group. */
  memberOf: string | null;
}
