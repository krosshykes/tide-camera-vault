// The vendor's root credential: TideCloak's master admin (from .env, never in code).
//
// CamCo runs this server and this TideCloak, so it genuinely holds this account. The demo uses
// it to show what root CANNOT do on an IGA realm in multi-admin mode: every role change it makes
// becomes a pending change request, and it cannot approve or commit one. Approvals need a
// household owner's signature in the Tide enclave, sent from that owner's browser.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, STATE_PATH } from "./paths.ts";

const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const TC = process.env.TIDECLOAK_URL || "http://localhost:8080";
export const REALM = process.env.REALM_NAME || "camera-vault";
const ADMIN_USER = process.env.KC_BOOTSTRAP_ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.KC_BOOTSTRAP_ADMIN_PASSWORD || "";

let cached = { token: "", at: 0 };
async function rootToken(): Promise<string> {
  if (!ADMIN_PASS) throw new Error("KC_BOOTSTRAP_ADMIN_PASSWORD is not set in .env");
  if (cached.token && Date.now() - cached.at < 30_000) return cached.token; // tokens live ~60s
  const res = await fetch(`${TC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS, grant_type: "password", client_id: "admin-cli" }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!body.access_token) throw new Error(`master-admin token failed (HTTP ${res.status})`);
  cached = { token: body.access_token, at: Date.now() };
  return cached.token;
}

export interface AdminResult {
  status: number;
  body: unknown;
  location?: string | null;
}

export async function rootCall(method: string, path: string, body?: unknown): Promise<AdminResult> {
  const res = await fetch(`${TC}/admin/realms/${REALM}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await rootToken()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body: parsed, location: res.headers.get("location") };
}

export function realmState(): { userIds: Record<string, string>; realmManagementClient: string } {
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

async function realmRoles(names: string[]) {
  const reps = [];
  for (const n of names) {
    const r = await rootCall("GET", `/roles/${encodeURIComponent(n)}`);
    const role = r.body as { id?: string; name?: string };
    if (!role?.id) throw new Error(`realm role ${n} not found`);
    reps.push({ id: role.id, name: role.name });
  }
  return reps;
}

export interface ChangeRequest {
  id: string;
  entityType: string;
  entityId: string;
  actionType: string;
  status: string;
  requestedBy?: string;
  createdAt?: number;
  authorizationCount?: number;
  authorizers?: { username: string; timestamp: number }[];
  threshold?: number;
  readyToCommit?: boolean;
  rows?: unknown;
}

export async function listChangeRequests(status = "PENDING"): Promise<ChangeRequest[]> {
  const r = await rootCall("GET", `/iga/change-requests?status=${status}`);
  return Array.isArray(r.body) ? (r.body as ChangeRequest[]) : [];
}

/**
 * Files (does not approve) realm-role grants. On an IGA realm each answers 202 + a change request.
 * ONE ROLE PER CALL: when a single role-mapping POST carries several roles, IGA records only the
 * first one in the change request (measured on this realm), and the rest are silently dropped.
 */
export async function fileRealmRoleGrant(username: string, roles: string[]) {
  const userId = realmState().userIds[username];
  if (!userId) throw new Error(`unknown user ${username}`);
  const held = new Set(((await rootCall("GET", `/users/${userId}/role-mappings/realm`)).body as { name: string }[] ?? []).map((r) => r.name));
  const results: { role: string; status: number; changeRequestId?: string; note?: string }[] = [];
  for (const rep of await realmRoles(roles)) {
    if (held.has(rep.name!)) { results.push({ role: rep.name!, status: 0, note: "already held" }); continue; }
    const before = new Set((await listChangeRequests()).map((c) => c.id));
    const r = await rootCall("POST", `/users/${userId}/role-mappings/realm`, [rep]);
    // Multi-admin answers 204 with no body for a captured write (202 + changeRequestId on some
    // builds), and 409 when this user already has a pending request. Find the CR by entity.
    const fresh = (await listChangeRequests()).find((c) => !before.has(c.id) && c.entityId === userId);
    const conflict = (r.body as { conflictingChangeRequestId?: string })?.conflictingChangeRequestId;
    results.push({
      role: rep.name!, status: r.status,
      changeRequestId: (r.body as { changeRequestId?: string })?.changeRequestId ?? fresh?.id ?? conflict,
      note: r.status === 409 ? "blocked: a change for this user is already pending" : undefined,
    });
  }
  const ids = new Set(results.map((r) => r.changeRequestId).filter(Boolean));
  const changeRequests = (await listChangeRequests()).filter((c) => ids.has(c.id));
  return { results, changeRequests };
}

/** Files (does not apply) a realm-role removal. Same rules as grants: one role per call. */
export async function fileRealmRoleRevoke(username: string, roles: string[]) {
  const userId = realmState().userIds[username];
  if (!userId) throw new Error(`unknown user ${username}`);
  const held = new Set(((await rootCall("GET", `/users/${userId}/role-mappings/realm`)).body as { name: string }[] ?? []).map((r) => r.name));
  const results: { role: string; status: number; changeRequestId?: string; note?: string }[] = [];
  for (const rep of await realmRoles(roles)) {
    if (!held.has(rep.name!)) { results.push({ role: rep.name!, status: 0, note: "not held" }); continue; }
    const before = new Set((await listChangeRequests()).map((c) => c.id));
    const r = await rootCall("DELETE", `/users/${userId}/role-mappings/realm`, [rep]);
    const fresh = (await listChangeRequests()).find((c) => !before.has(c.id) && c.entityId === userId);
    const conflict = (r.body as { conflictingChangeRequestId?: string })?.conflictingChangeRequestId;
    results.push({
      role: rep.name!, status: r.status,
      changeRequestId: (r.body as { changeRequestId?: string })?.changeRequestId ?? fresh?.id ?? conflict,
      note: r.status === 409 ? "blocked: a change for this user is already pending" : undefined,
    });
  }
  const ids = new Set(results.map((r) => r.changeRequestId).filter(Boolean));
  const changeRequests = (await listChangeRequests()).filter((c) => ids.has(c.id));
  return { results, changeRequests };
}

/** Everyone in the realm, as TideCloak sees them right now (not as any token claims). */
export async function members(vendorStaff: string[]) {
  const { userIds, realmManagementClient } = realmState();
  const pending = await listChangeRequests();
  const out = [];
  for (const [username, id] of Object.entries(userIds)) {
    if (vendorStaff.includes(username)) continue;
    const user = (await rootCall("GET", `/users/${id}`)).body as { attributes?: Record<string, string[]> } | null;
    if (!user || typeof user !== "object" || !("attributes" in user || "username" in user)) continue; // deleted
    const realm = ((await rootCall("GET", `/users/${id}/role-mappings/realm`)).body as { name: string }[]) ?? [];
    const client = ((await rootCall("GET", `/users/${id}/role-mappings/clients/${realmManagementClient}`)).body as { name: string }[]) ?? [];
    out.push({
      username,
      linked: !!user.attributes?.tideUserKey?.[0],
      viewer: Array.isArray(realm) && realm.some((r) => r.name === "household-viewer"),
      owner: Array.isArray(client) && client.some((r) => r.name === "tide-realm-admin"),
      pending: pending.filter((c) => c.entityId === id).map((c) => c.actionType),
    });
  }
  return out;
}

export async function roleNames(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of ((await rootCall("GET", "/roles?max=200")).body as { id: string; name: string }[]) ?? []) out[r.id] = r.name;
  const rm = realmState().realmManagementClient;
  for (const r of ((await rootCall("GET", `/clients/${rm}/roles?max=200`)).body as { id: string; name: string }[]) ?? []) out[r.id] = r.name;
  return out;
}

/** Files a tide-realm-admin grant (making someone a household owner/approver). */
export async function fileOwnerGrant(username: string) {
  const { userIds, realmManagementClient } = realmState();
  const userId = userIds[username];
  if (!userId) throw new Error(`unknown user ${username}`);
  const role = (await rootCall("GET", `/clients/${realmManagementClient}/roles/tide-realm-admin`)).body;
  const r = await rootCall("POST", `/users/${userId}/role-mappings/clients/${realmManagementClient}`, [role]);
  const id = (r.body as { changeRequestId?: string })?.changeRequestId;
  const changeRequests = (await listChangeRequests()).filter((c) => c.id === id);
  return { results: [{ role: "tide-realm-admin", status: r.status, changeRequestId: id }], changeRequests };
}

export async function adminPolicy() {
  return rootCall("GET", "/iga/role-policies/name/tide-realm-admin");
}
