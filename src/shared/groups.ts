import type { Currency } from "./currencies";

/** How long an invite link works. */
export const INVITE_DAYS = 7;

export const GROUP_NAME_MAX = 60;

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
  email: string;
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
  state: "valid" | "used" | "expired";
  /** Set when the signed-in user is already in the group. */
  memberOf: string | null;
}
