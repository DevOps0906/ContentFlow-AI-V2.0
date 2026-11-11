// Roles, permissions (mirroring the database rules) and validation for the team features.
// The database is the authority; these helpers only decide what the UI offers and map errors.
/** Cookie holding the active workspace id (validated against memberships on every request). */
export const WORKSPACE_COOKIE_NAME = "cf-workspace";
export const roles = ["owner", "admin", "editor", "reviewer", "viewer"] as const;
export type Role = (typeof roles)[number];
export const roleLabels: Record<Role, string> = {
  owner: "소유자",
  admin: "관리자",
  editor: "편집자",
  reviewer: "검수자",
  viewer: "읽기 전용",
};
export const roleHelp: Record<Role, string> = {
  owner: "모든 권한. 변경·삭제할 수 없습니다.",
  admin: "팀 관리, 편집, 승인, 수익 가져오기. 다른 관리자는 관리할 수 없습니다.",
  editor: "콘텐츠·키워드 작성과 수정. 승인은 할 수 없습니다.",
  reviewer: "승인 대기 글을 승인하거나 수정 요청. 내용은 고칠 수 없습니다.",
  viewer: "읽기만 가능합니다.",
};
export const isRole = (v: unknown): v is Role => roles.includes(v as Role);

export const canEdit = (r?: Role | null) => r === "owner" || r === "admin" || r === "editor";
/** Approving or sending an article back from `approval_pending`. */
export const canDecide = (r?: Role | null) => r === "owner" || r === "admin" || r === "reviewer";
export const canManageTeam = (r?: Role | null) => r === "owner" || r === "admin";
export const canImportRevenue = canManageTeam;
export const canRecordSiteChecks = canManageTeam;
export const canRecordCosts = canManageTeam;
export const canManageBlogs = canManageTeam;
export const canManageImprovements = (r?: Role | null) => canEdit(r) || canDecide(r);

/** Roles the actor may grant when inviting or changing a role (never `owner`). */
export function grantableRoles(actor?: Role | null): Role[] {
  if (actor === "owner") return ["admin", "editor", "reviewer", "viewer"];
  if (actor === "admin") return ["editor", "reviewer", "viewer"];
  return [];
}
/** Whether `actor` may change or remove a member currently holding `target`. */
export function canManageMember(actor: Role | null | undefined, target: Role): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  return actor === "admin" && target !== "admin";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseInvite(input: unknown): { email: string; role: Role } {
  const r = (input ?? {}) as Record<string, unknown>;
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) throw new Error("이메일 형식이 올바르지 않습니다.");
  if (!isRole(r.role) || r.role === "owner") throw new Error("부여할 수 없는 역할입니다.");
  return { email, role: r.role };
}

const messages: [RegExp, number, string][] = [
  [/only the owner can/, 403, "소유자만 할 수 있는 작업입니다."],
  [/owner role can not be (granted|changed)|owner can not be removed/, 400, "소유자 역할은 부여·변경·삭제할 수 없습니다."],
  [/invalid email/, 400, "이메일 형식이 올바르지 않습니다."],
  [/already a member/, 409, "이미 이 워크스페이스의 멤버입니다."],
  [/invitation not found/, 404, "초대를 찾을 수 없습니다. 이미 처리됐거나 이메일이 확인되지 않았을 수 있어요."],
  [/not allowed/, 403, "이 작업을 할 권한이 없습니다."],
];
/** Maps a database error from the team functions to a safe, translated response. */
export function teamError(error: { message?: string } | null | undefined): { status: number; message: string } {
  const text = error?.message ?? "";
  for (const [re, status, message] of messages) if (re.test(text)) return { status, message };
  return { status: 500, message: "팀 정보를 처리하지 못했습니다." };
}