/**
 * E4b: who may open a workspace and with which role (pure; the middleware and the Team service use it).
 * Roles are per workspace (`workspace_members.role`); a super-admin opens every workspace as admin.
 */
export type WorkspaceRole = "admin" | "salesperson";

export const NO_WORKSPACE_ACCESS_MESSAGE = "You don't have access to this workspace";

/** The role a user has in a workspace, or null when they may not open it. */
export function effectiveWorkspaceRole(memberRole: WorkspaceRole | null, isSuperAdmin: boolean): WorkspaceRole | null {
  return isSuperAdmin ? "admin" : memberRole;
}

export interface MemberRow {
  userId: string;
  role: WorkspaceRole;
}

/** True when `userId` is the only admin of the workspace (rule 9: never removed or demoted). */
export function isLastAdmin(members: MemberRow[], userId: string): boolean {
  const admins = members.filter((m) => m.role === "admin");
  return admins.length === 1 && admins[0]!.userId === userId;
}

export interface OwnedWork {
  contacts: number;
  deals: number;
  tasks: number;
}

/** Rule 9: why `userId` can't be removed from the workspace, or null. */
export function removeMemberProblem(members: MemberRow[], userId: string, owned: OwnedWork): string | null {
  if (!members.some((m) => m.userId === userId)) return "This user isn't a member of this workspace.";
  if (isLastAdmin(members, userId)) return "You can't remove the last admin of a workspace. Make someone else an admin first.";
  if (owned.contacts || owned.deals || owned.tasks) {
    return `This user still owns ${owned.contacts} active contact(s), ${owned.deals} open deal(s) and ${owned.tasks} open task(s) in this workspace. Reassign them first.`;
  }
  return null;
}

/** Rule 9: why `userId`'s role can't change to `role`, or null. */
export function changeRoleProblem(members: MemberRow[], userId: string, role: WorkspaceRole): string | null {
  if (!members.some((m) => m.userId === userId)) return "This user isn't a member of this workspace.";
  if (role !== "admin" && isLastAdmin(members, userId)) return "You can't demote the last admin of a workspace. Make someone else an admin first.";
  return null;
}
