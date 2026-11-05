import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canDecide,
  canEdit,
  canManageMember,
  canManageTeam,
  grantableRoles,
  isRole,
  parseInvite,
  roles,
  teamError,
} from "../src/lib/team";

test("permissions mirror the database rules", () => {
  assert.deepEqual(roles.filter(canEdit), ["owner", "admin", "editor"]);
  assert.deepEqual(roles.filter(canDecide), ["owner", "admin", "reviewer"]);
  assert.deepEqual(roles.filter(canManageTeam), ["owner", "admin"]);
  assert.ok(!canEdit(null) && !canDecide(undefined) && !canManageTeam(null));
});

test("nobody can grant the owner role; admins can not create admins", () => {
  for (const r of roles) assert.ok(!grantableRoles(r).includes("owner"));
  assert.deepEqual(grantableRoles("owner"), ["admin", "editor", "reviewer", "viewer"]);
  assert.deepEqual(grantableRoles("admin"), ["editor", "reviewer", "viewer"]);
  for (const r of ["editor", "reviewer", "viewer"] as const) assert.deepEqual(grantableRoles(r), []);
});

test("who may change or remove whom", () => {
  assert.ok(canManageMember("owner", "admin") && canManageMember("owner", "viewer"));
  assert.ok(canManageMember("admin", "editor") && !canManageMember("admin", "admin"));
  for (const a of ["owner", "admin", "editor", "reviewer", "viewer", null] as const) assert.ok(!canManageMember(a, "owner"));
  assert.ok(!canManageMember("editor", "viewer") && !canManageMember(null, "viewer"));
});

test("invitations are validated", () => {
  assert.deepEqual(parseInvite({ email: " New@Example.COM ", role: "editor" }), { email: "new@example.com", role: "editor" });
  for (const bad of [null, {}, { email: "x", role: "editor" }, { email: "a@b.co", role: "owner" }, { email: "a@b.co", role: "root" }, { email: "a@b.co" }, { email: `${"a".repeat(250)}@b.co`, role: "viewer" }])
    assert.throws(() => parseInvite(bad));
  assert.ok(isRole("viewer") && !isRole("owner ") && !isRole(undefined));
});

test("database errors map to safe messages without leaking internals", () => {
  assert.equal(teamError({ message: "only the owner can invite admins" }).status, 403);
  assert.equal(teamError({ message: "already a member" }).status, 409);
  assert.equal(teamError({ message: "invitation not found" }).status, 404);
  assert.equal(teamError({ message: "not allowed" }).status, 403);
  const other = teamError({ message: 'relation "secret_table" does not exist' });
  assert.equal(other.status, 500);
  assert.ok(!other.message.includes("secret_table"));
  assert.equal(teamError(null).status, 500);
});

test("the SQL transition and permission rules agree with team.ts", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/0004_team_and_roles.sql", import.meta.url), "utf8");
  // The owner role can never be invited, and memberships are no longer writable by clients.
  assert.ok(/role <> 'owner'/.test(sql));
  assert.ok(/drop policy mem_write on memberships/.test(sql));
  // Reviewers may only decide an article waiting for approval.
  assert.ok(/old\.state = 'approval_pending' and new\.state in \('approved', 'needs_revision'\)/.test(sql));
});
