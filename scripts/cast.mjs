#!/usr/bin/env node
// cast.mjs: add or remove characters AFTER bootstrap, when the realm is already multi-admin.
//
// Every command only FILES a change request with TideCloak's root account. Nothing applies until
// a household owner approves it in the app ("Pending household approvals"), because root can't
// approve on an IGA realm. That's the property the demo is about.
//
//   node scripts/cast.mjs status
//   node scripts/cast.mjs remove riley          # DELETE_USER change request
//   node scripts/cast.mjs add riley owner       # CREATE_USER; then grant + invite once approved
//   node scripts/cast.mjs grant riley owner     # owner  = household-viewer + _tide_encryptor + _tide_decryptor
//   node scripts/cast.mjs grant jordan none     # none   = nothing (Jordan starts with no rights)
//   node scripts/cast.mjs invite riley          # fresh 12h Tide account link

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const TC = process.env.TIDECLOAK_URL || "http://localhost:8080";
const REALM = process.env.REALM_NAME || "camera-vault";
const STATE = join(ROOT, "server", "data", "realm-state.json");
const OWNER_ROLES = ["household-viewer"]; // composite: carries _tide_encryptor + _tide_decryptor
const NAMES = {
  alex: ["Alex", "(owner)"], sam: ["Sam", "(owner)"], riley: ["Riley", "(owner)"],
  jordan: ["Jordan", "(housemate)"], "camco-support": ["CamCo", "Support"],
};

async function token() {
  const res = await fetch(`${TC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: process.env.KC_BOOTSTRAP_ADMIN_USERNAME || "admin", password: process.env.KC_BOOTSTRAP_ADMIN_PASSWORD || "", grant_type: "password", client_id: "admin-cli" }),
  });
  const b = await res.json();
  if (!b.access_token) throw new Error(`master-admin token failed (HTTP ${res.status})`);
  return b.access_token;
}
async function api(method, path, body) {
  const res = await fetch(`${TC}/admin/realms/${REALM}${path}`, {
    method, headers: { Authorization: `Bearer ${await token()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, json };
}
const pending = async () => (await api("GET", "/iga/change-requests?status=PENDING")).json ?? [];
const userByName = async (u) => (await api("GET", `/users?username=${encodeURIComponent(u)}&exact=true`)).json?.[0];

function saveId(username, id) {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  if (id) s.userIds[username] = id; else delete s.userIds[username];
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
}

async function filed(label, before) {
  const now = await pending();
  const fresh = now.filter((c) => !before.has(c.id));
  for (const c of fresh) console.log(`  filed: ${c.actionType} ${c.id}  (threshold ${c.threshold ?? "?"})`);
  if (!fresh.length) console.log(`  ${label}: no new change request (it may have applied directly, or nothing changed)`);
  console.log("  -> approve it in the app as an owner: Household App -> Pending household approvals");
}

const [cmd, who, kind] = process.argv.slice(2);
const before = new Set((await pending()).map((c) => c.id));

if (cmd === "status") {
  const users = (await api("GET", "/users?max=50")).json ?? [];
  for (const u of users) console.log(`  ${u.username.padEnd(14)} linked=${!!u.attributes?.tideUserKey?.[0]}  id=${u.id}`);
  const p = await pending();
  console.log(`  pending change requests: ${p.length}`);
  for (const c of p) console.log(`    ${c.actionType} ${c.entityType} ${c.id} (${c.authorizationCount ?? "?"} of ${c.threshold ?? "?"})`);
} else if (cmd === "remove" && who) {
  const u = await userByName(who);
  if (!u) throw new Error(`no user ${who}`);
  const r = await api("DELETE", `/users/${u.id}`);
  console.log(`  DELETE /users/${who} -> HTTP ${r.status} ${r.text.slice(0, 200)}`);
  await filed("remove", before);
} else if (cmd === "add" && who) {
  const [firstName, lastName] = NAMES[who] ?? [who, ""];
  const r = await api("POST", "/users", {
    username: who, firstName, lastName, enabled: true,
    email: `${who}@${who === "camco-support" ? "camco" : "household"}.invalid`, emailVerified: false,
    attributes: { tideInvitable: ["true"] },
  });
  console.log(`  POST /users ${who} -> HTTP ${r.status} ${r.text.slice(0, 200)}`);
  await filed("add", before);
  console.log(`  once approved: node scripts/cast.mjs grant ${who} ${kind || "none"}  then  node scripts/cast.mjs invite ${who}`);
} else if (cmd === "grant" && who) {
  const u = await userByName(who);
  if (!u) throw new Error(`no user ${who} (is its CREATE_USER request approved yet?)`);
  saveId(who, u.id);
  if (kind === "owner") {
    const roles = [];
    for (const n of OWNER_ROLES) { const r = (await api("GET", `/roles/${encodeURIComponent(n)}`)).json; roles.push({ id: r.id, name: r.name }); }
    // ONE ROLE PER CALL: IGA records only the first role of a multi-role mapping POST.
    const held = new Set(((await api("GET", `/users/${u.id}/role-mappings/realm`)).json ?? []).map((r) => r.name));
    for (const role of roles) {
      if (held.has(role.name)) { console.log(`  ${role.name}: already held`); continue; }
      const r = await api("POST", `/users/${u.id}/role-mappings/realm`, [role]);
      console.log(`  grant ${role.name} to ${who} -> HTTP ${r.status}`);
    }
    await filed("grant", before);
    console.log("  to make them an approver too, use the app: Household members -> Make ... an owner");
  } else {
    console.log(`  ${who} gets no roles (recorded id ${u.id})`);
  }
} else if (cmd === "composite" && who && kind) {
  // node scripts/cast.mjs composite household-viewer _tide_decryptor   (ADD_COMPOSITE request)
  const parent = (await api("GET", `/roles/${encodeURIComponent(who)}`)).json;
  const child = (await api("GET", `/roles/${encodeURIComponent(kind)}`)).json;
  if (!parent?.id || !child?.id) throw new Error("role not found");
  const r = await api("POST", `/roles-by-id/${parent.id}/composites`, [{ id: child.id, name: child.name }]);
  console.log(`  add ${kind} into ${who} -> HTTP ${r.status} ${r.text.slice(0, 200)}`);
  await filed("composite", before);
} else if (cmd === "invite" && who) {
  const u = await userByName(who);
  if (!u) throw new Error(`no user ${who}`);
  saveId(who, u.id);
  const res = await fetch(`${TC}/admin/realms/${REALM}/tideAdminResources/get-required-action-link?userId=${u.id}&lifespan=43200`, {
    method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify(["link-tide-account-action"]),
  });
  const link = (await res.text()).trim();
  const file = join(ROOT, "server", "data", "invite-links.txt");
  const lines = (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []).filter((l) => l && !l.startsWith(`${who}:`));
  writeFileSync(file, [...lines, `${who}: ${link}`].join("\n") + "\n");
  console.log(`  ${who}: ${link}\n  (saved to server/data/invite-links.txt; linking will file a change request for an owner to approve)`);
} else {
  console.log("usage: node scripts/cast.mjs status | remove <user> | add <user> [owner|none] | grant <user> owner|none | composite <role> <child> | invite <user>");
  process.exit(1);
}
