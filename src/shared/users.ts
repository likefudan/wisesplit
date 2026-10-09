/** Where a user's application stands. Only approved users may use the site. */
export const USER_STATUSES = ["pending", "approved", "rejected", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** What the admin can do to a user: the states each action applies to and the state it leads to. */
export const ADMIN_ACTIONS = {
  approve: { from: ["pending", "rejected"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  deactivate: { from: ["approved"], to: "deactivated" },
  reactivate: { from: ["deactivated"], to: "approved" },
} as const satisfies Record<string, { from: readonly UserStatus[]; to: UserStatus }>;
export type AdminAction = keyof typeof ADMIN_ACTIONS;

/** The actions offered for a user in `status`. */
export const actionsFor = (status: UserStatus) =>
  (Object.keys(ADMIN_ACTIONS) as AdminAction[]).filter((a) =>
    (ADMIN_ACTIONS[a].from as readonly UserStatus[]).includes(status),
  );
