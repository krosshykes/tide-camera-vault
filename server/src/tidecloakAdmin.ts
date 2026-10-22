// The vendor's root credential: TideCloak's master admin (from .env, never in code).
//
// CamCo runs this server and this TideCloak, so it genuinely holds this account. The demo uses
// it to show what root CANNOT do on an IGA realm in multi-admin mode: every role change it makes
// becomes a pending change request, and it cannot approve or commit one. Approvals need a
// household owner's signature in the Tide enclave, sent from that owner's browser.
//
// Every function takes the household's realm, so one backend serves any number of households.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const TC = process.env.TIDECLOAK_URL || "http://localhost:8080";
const ADMIN_USER = process.env.KC_BOOTSTRAP_ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.KC_BOOTSTRAP_ADMIN_PASSWORD || "";

let cached = { token: "", at: 0 };
export async function rootToken(): Promise<string> {
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
  text: string;
  location?: string | null;
}

/** Root call against /admin/realms/{realm}{path}. `form` sends x-www-form-urlencoded. */
export async function rootCall(realm: string, method: string, path: string, body?: unknown, opts: { form?: boolean } = {}): Promise<AdminResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await rootToken()}` };
  let payload: string | undefined;
  if (body !== undefined) {
    if (opts.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body as Record<string, string>).toString(); }
    else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  }
  const url = realm ? `${TC}/admin/realms/${realm}${path}` : `${TC}/admin/realms${path}`;
  const res = await fetch(url, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body: parsed, text, location: res.headers.get("location") };
}

export interface RealmUser { id: string; username: string; attributes?: Record<string, string[]> }

export async function realmUsers(realm: string): Promise<RealmUser[]> {
  const r = await rootCall(realm, "GET", "/users?max=500&briefRepresentation=false");
  return Array.isArray(r.body) ? (r.body as RealmUser[]) : [];
}

export async function userByName(realm: string, username: string): Promise<RealmUser | null> {
  const r = await rootCall(realm, "GET", `/users?username=${encodeURIComponent(username)}&exact=true`);
  return Array.isArray(r.body) && r.body[0] ? (r.body[0] as RealmUser) : null;
}

const rmCache = new Map<string, string>();
export async function realmManagementClient(realm: string): Promise<string> {
  if (!rmCache.has(realm)) {
    const id = ((await rootCall(realm, "GET", "/clients?clientId=realm-management")).body as { id: string }[])?.[0]?.id;
    if (!id) throw new Error(`realm-management client not found in ${realm}`);
    rmCache.set(realm, id);
  }
  return rmCache.get(realm)!;
}

async function realmRoles(realm: string, names: string[]) {
  const reps = [];
  for (const n of names) {
    const r = await rootCall(realm, "GET", `/roles/${encodeURIComponent(n)}`);
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

export async function listChangeRequests(realm: string, status = "PENDING"): Promise<ChangeRequest[]> {
  const r = await rootCall(realm, "GET", `/iga/change-requests?status=${status}`);
  return Array.isArray(r.body) ? (r.body as ChangeRequest[]) : [];
}

type RoleResult = { role: string; status: number; changeRequestId?: string; note?: string };

/**
 * Files (does not apply) realm-role grants or removals. On an IGA realm each is captured as a
 * change request (multi-admin answers 204 with no body; some builds 202 + changeRequestId).
 * ONE ROLE PER CALL: when a single role-mapping request carries several roles, IGA records only
 * the first (measured on this realm). And one pending request per user: a second answers 409.
 */
async function fileRealmRoles(realm: string, username: string, roles: string[], method: "POST" | "DELETE") {
  const user = await userByName(realm, username);
  if (!user) throw new Error(`unknown user ${username}`);
  const held = new Set(((await rootCall(realm, "GET", `/users/${user.id}/role-mappings/realm`)).body as { name: string }[] ?? []).map((r) => r.name));
  const results: RoleResult[] = [];
  for (const rep of await realmRoles(realm, roles)) {
    if (method === "POST" && held.has(rep.name!)) { results.push({ role: rep.name!, status: 0, note: "already held" }); continue; }
    if (method === "DELETE" && !held.has(rep.name!)) { results.push({ role: rep.name!, status: 0, note: "not held" }); continue; }
    const before = new Set((await listChangeRequests(realm)).map((c) => c.id));
    const r = await rootCall(realm, method, `/users/${user.id}/role-mappings/realm`, [rep]);
    const fresh = (await listChangeRequests(realm)).find((c) => !before.has(c.id) && c.entityId === user.id);
    const conflict = (r.body as { conflictingChangeRequestId?: string })?.conflictingChangeRequestId;
    results.push({
      role: rep.name!, status: r.status,
      changeRequestId: (r.body as { changeRequestId?: string })?.changeRequestId ?? fresh?.id ?? conflict,
      note: r.status === 409 ? "blocked: a change for this user is already pending" : undefined,
    });
  }
  const ids = new Set(results.map((r) => r.changeRequestId).filter(Boolean));
  const changeRequests = (await listChangeRequests(realm)).filter((c) => ids.has(c.id));
  return { results, changeRequests };
}

export const fileRealmRoleGrant = (realm: string, username: string, roles: string[]) => fileRealmRoles(realm, username, roles, "POST");
export const fileRealmRoleRevoke = (realm: string, username: string, roles: string[]) => fileRealmRoles(realm, username, roles, "DELETE");

/** Files a tide-realm-admin grant (making someone a household owner/approver). */
export async function fileOwnerGrant(realm: string, username: string) {
  const user = await userByName(realm, username);
  if (!user) throw new Error(`unknown user ${username}`);
  const rm = await realmManagementClient(realm);
  const role = (await rootCall(realm, "GET", `/clients/${rm}/roles/tide-realm-admin`)).body;
  const before = new Set((await listChangeRequests(realm)).map((c) => c.id));
  const r = await rootCall(realm, "POST", `/users/${user.id}/role-mappings/clients/${rm}`, [role]);
  const id = (r.body as { changeRequestId?: string })?.changeRequestId
    ?? (await listChangeRequests(realm)).find((c) => !before.has(c.id) && c.entityId === user.id)?.id;
  const changeRequests = (await listChangeRequests(realm)).filter((c) => c.id === id);
  return { results: [{ role: "tide-realm-admin", status: r.status, changeRequestId: id }], changeRequests };
}

/** Files a CREATE_USER request for a new person. They get a Tide invite link once it's approved. */
export async function fileCreateUser(realm: string, username: string, firstName: string, email?: string) {
  const r = await rootCall(realm, "POST", "/users", {
    username, firstName, lastName: "", enabled: true,
    // The user profile requires an email; Tide itself doesn't use it. Without a real one, use the
    // reserved .invalid TLD (RFC 2606), which can never receive mail.
    email: email || `${username}@${realm}.invalid`, emailVerified: false,
    attributes: { tideInvitable: ["true"] },
  });
  return { status: r.status, body: r.body };
}

/** A 12-hour link for a realm user to create (link) their Tide account. */
export async function inviteLink(realm: string, username: string): Promise<string> {
  const user = await userByName(realm, username);
  if (!user) throw new Error(`unknown user ${username} (has its CREATE_USER request been approved?)`);
  const r = await rootCall(realm, "POST", `/tideAdminResources/get-required-action-link?userId=${user.id}&lifespan=43200`, ["link-tide-account-action"]);
  if (r.status >= 300) throw new Error(`invite link failed (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
  return r.text.trim();
}

/** Everyone in the realm, as TideCloak sees them right now (not as any token claims). */
export async function members(realm: string, exclude: string[] = []) {
  const rm = await realmManagementClient(realm);
  const pending = await listChangeRequests(realm);
  const out = [];
  for (const user of await realmUsers(realm)) {
    if (exclude.includes(user.username)) continue;
    const realmRoles = ((await rootCall(realm, "GET", `/users/${user.id}/role-mappings/realm`)).body as { name: string }[]) ?? [];
    const client = ((await rootCall(realm, "GET", `/users/${user.id}/role-mappings/clients/${rm}`)).body as { name: string }[]) ?? [];
    out.push({
      username: user.username,
      linked: !!user.attributes?.tideUserKey?.[0],
      viewer: Array.isArray(realmRoles) && realmRoles.some((r) => r.name === "household-viewer"),
      owner: Array.isArray(client) && client.some((r) => r.name === "tide-realm-admin"),
      pending: pending.filter((c) => c.entityId === user.id).map((c) => c.actionType),
    });
  }
  return out;
}

/** Ids -> names, so approval screens can say who and what instead of uuids. */
export async function directory(realm: string) {
  const users: Record<string, string> = {};
  for (const u of await realmUsers(realm)) users[u.id] = u.username;
  const roles: Record<string, string> = {};
  for (const r of ((await rootCall(realm, "GET", "/roles?max=200")).body as { id: string; name: string }[]) ?? []) roles[r.id] = r.name;
  const rm = await realmManagementClient(realm);
  for (const r of ((await rootCall(realm, "GET", `/clients/${rm}/roles?max=200`)).body as { id: string; name: string }[]) ?? []) roles[r.id] = r.name;
  return { users, roles };
}

export const adminPolicy = (realm: string) => rootCall(realm, "GET", "/iga/role-policies/name/tide-realm-admin");
