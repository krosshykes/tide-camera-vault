#!/usr/bin/env node
// bootstrap.mjs — stands up TideCloak for the Home Camera Vault and seeds the household.
//
// Ported from the Tide pack's templates/shared/bootstrap-tidecloak.sh (same sequence, same
// checks) so it runs on Windows, macOS and Linux without sudo, jq or lsof. What it adds:
// the camera-vault characters and roles, created BEFORE tide-realm-admin is granted. Once that
// grant commits, the realm flips to multi-admin and every governed change needs a human to
// approve it in the Tide enclave. That is the point of the demo, so the script stops there.
//
//   node scripts/bootstrap.mjs            # reads .env
//   FORCE_WIPE=1 node scripts/bootstrap.mjs   # delete the container + its data and start over

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- .env ----------------------------------------------------------------------------------------
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const env = process.env;
const TC = env.TIDECLOAK_URL || "http://localhost:8080";
const REALM = env.REALM_NAME || "camera-vault";
const CLIENT = env.CLIENT_NAME || "camera-vault-client";
const APP_URL = env.CLIENT_APP_URL || "http://localhost:5173";
const IMAGE = env.TIDECLOAK_IMAGE || "tideorg/tidecloak-dev:latest";
const CONTAINER = "tidecloak-camvault";
const ADMIN_USER = env.KC_BOOTSTRAP_ADMIN_USERNAME || "admin";
const ADMIN_PASS = env.KC_BOOTSTRAP_ADMIN_PASSWORD || "";
const ADAPTER_OUT = join(ROOT, "web", "public", "tidecloak.json");
const STATE_DIR = join(ROOT, "server", "data");

// The cast. Owners hold the vault roles from the start; Jordan and CamCo hold nothing.
// Only Alex is made tide-realm-admin here. Sam and Riley become admins later, by change
// requests that Alex approves in the enclave (scripts/file-owner-grants.mjs).
const USERS = [
  { username: "alex", firstName: "Alex", lastName: "(owner)", vault: true },
  { username: "sam", firstName: "Sam", lastName: "(owner)", vault: true },
  { username: "riley", firstName: "Riley", lastName: "(owner)", vault: true },
  { username: "jordan", firstName: "Jordan", lastName: "(housemate)", vault: false },
  { username: "camco-support", firstName: "CamCo", lastName: "Support", vault: false },
];
// household-viewer is a composite of _tide_encryptor + _tide_decryptor (realm template).
const VAULT_ROLES = ["household-viewer"];
const SKIP_TYPES = new Set(["DISABLE_IGA", "DELETE_REALM", "OFFBOARD_REALM"]);

const log = (...a) => console.log("==>", ...a);
const die = (msg, code = 1) => { console.error(`ERROR: ${msg}`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Credentials + licence answers: from a person, never defaults (AP-41, AP-90) ---------------
if (!ADMIN_PASS) die("KC_BOOTSTRAP_ADMIN_PASSWORD is not set. Copy .env.example to .env and set it.");

const email = env.TIDE_LICENSE_EMAIL || "";
const placeholder = /@(example\.(com|org|net)|test\.com|localhost)$|\.(example|test|invalid|local)$/i;
if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) || placeholder.test(email) || env.TIDE_TERMS_ACCEPTED !== "yes") {
  console.error(`
STOP: the Tide realm was NOT set up. Nothing was created.

  Two answers are missing, and both must come from the person who owns this deployment:
    1. Which email address should manage your Tide licence?  -> TIDE_LICENSE_EMAIL in .env
    2. Do you agree to Tide's Terms & Conditions at https://tide.org/legal ?  -> TIDE_TERMS_ACCEPTED=yes

  Got: TIDE_LICENSE_EMAIL='${email}'  TIDE_TERMS_ACCEPTED='${env.TIDE_TERMS_ACCEPTED || ""}'
`);
  process.exit(2);
}
log(`Licence email: ${email}`);
log("Terms & Conditions (https://tide.org/legal): accepted by the operator");

// --- HTTP helpers --------------------------------------------------------------------------------
let cached = { token: "", at: 0 };
async function token() {
  // Master-admin tokens live ~60s. Re-mint every 30s.
  if (cached.token && Date.now() - cached.at < 30_000) return cached.token;
  const res = await fetch(`${TC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS, grant_type: "password", client_id: "admin-cli" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) die(`could not get a master-admin token (HTTP ${res.status})`);
  cached = { token: body.access_token, at: Date.now() };
  return cached.token;
}

async function api(method, path, body, { form = false, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${await token()}` };
  let payload;
  if (body !== undefined) {
    if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body); }
    else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  }
  const res = await fetch(`${TC}${path}`, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, json };
}
const adm = (p) => `/admin/realms/${REALM}${p}`;

// --- IGA drain (canon/iga-change-requests-api.md "Bootstrap pattern") ----------------------------
// FirstAdmin mode: authorize signs server-side, then commit, in passes so dependents commit.
async function pending() {
  const r = await api("GET", adm("/iga/change-requests?status=PENDING"));
  return Array.isArray(r.json) ? r.json.filter((cr) => !SKIP_TYPES.has(cr.actionType)) : [];
}
async function drain(label) {
  for (const cr of await pending()) {
    await api("POST", adm(`/iga/change-requests/${cr.id}/authorize`), {});
  }
  for (let pass = 0; pass < 5; pass++) {
    const ready = (await pending()).filter((cr) => cr.readyToCommit === true);
    if (!ready.length) break;
    for (const cr of ready) await api("POST", adm(`/iga/change-requests/${cr.id}/commit`));
  }
  const left = await pending();
  if (left.length) {
    console.warn(`    WARNING (${label}): ${left.length} change request(s) still pending:`);
    for (const cr of left) console.warn(`      - ${cr.actionType} ${cr.entityType} ${cr.id} blocked=${cr.blocked ?? ""} ${cr.blockedReason ?? ""}`);
  } else {
    console.log(`    drained (${label}): 0 pending`);
  }
  return left;
}

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", env, ...opts });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function up() {
  try { return (await fetch(`${TC}/realms/master`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

// --- Step 0: never clobber a realm by accident ---------------------------------------------------
if (env.FORCE_WIPE === "1") {
  log("FORCE_WIPE=1: removing the container and its data...");
  docker(["rm", "-f", CONTAINER]);
}
// RESUME_FROM=users: the realm was created, licensed and IGA-enabled by an earlier run that
// stopped before any user existed. Pick up from Step 6 instead of re-licensing.
// RESUME_FROM=finish: users exist and the accounts that could be linked are linked (the free tier
// caps linked accounts). Skip to Step 9 and finish; the rest link later, approved by an owner.
let resume = false;
let finish = false;
if (await up()) {
  const realms = await api("GET", "/admin/realms");
  const names = Array.isArray(realms.json) ? realms.json.map((r) => r.realm) : [];
  if (names.includes(REALM)) {
    const igaOn = String((await api("GET", adm(""))).json?.attributes?.isIGAEnabled ?? "") === "true";
    const anyUsers = ((await api("GET", adm("/users?max=1"))).json || []).length > 0;
    if (env.RESUME_FROM === "finish" && igaOn && anyUsers) {
      resume = true; finish = true;
      log(`Finishing realm '${REALM}' with the accounts linked so far.`);
    } else if (env.RESUME_FROM === "users" && igaOn && !anyUsers) {
      resume = true;
      log(`Resuming realm '${REALM}' at user creation (licence + IGA already done).`);
    } else {
      die(`realm '${REALM}' already exists on ${TC}. A realm cannot be un-flipped from multi-admin, so this\n` +
        `       script will not touch it. To start over: FORCE_WIPE=1 node scripts/bootstrap.mjs`);
    }
  } else {
    log(`TideCloak already running on ${TC}; adding realm '${REALM}' to it.`);
  }
} else {
  // --- Step 1: start the container ---------------------------------------------------------------
  docker(["rm", "-f", CONTAINER]);
  log(`Starting TideCloak (${IMAGE}) as container '${CONTAINER}'...`);
  // `-e NAME` with no value passes it from this process's env, so the password never hits argv.
  // No volume: the H2 database lives in the container's own filesystem (writable by its uid 1000),
  // and survives `docker stop` / `docker start`. Only `docker rm` (or FORCE_WIPE) deletes it.
  const run = docker(["run", "-d", "--name", CONTAINER, "-p", "8080:8080",
    "-e", "KC_BOOTSTRAP_ADMIN_USERNAME", "-e", "KC_BOOTSTRAP_ADMIN_PASSWORD", IMAGE],
    { env: { ...env, KC_BOOTSTRAP_ADMIN_USERNAME: ADMIN_USER, KC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASS } });
  if (run.code !== 0) die(`docker run failed:\n${run.out}`);

  // --- Step 2: wait for readiness ----------------------------------------------------------------
  log("Waiting for TideCloak to start...");
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(5000); ok = await up(); }
  if (!ok) die(`TideCloak did not start within 200s. Check: docker logs ${CONTAINER}`);
  log("TideCloak is ready.");
}

if (!resume) {
// --- Step 3: realm from template -----------------------------------------------------------------
log(`Creating realm '${REALM}'...`);
const realmJson = readFileSync(join(ROOT, "scripts", "realm.json.template"), "utf8")
  .replaceAll("REALM_NAME", REALM).replaceAll("CLIENT_NAME", CLIENT).replaceAll("CLIENT_APP_URL", APP_URL);
const created = await api("POST", "/admin/realms", JSON.parse(realmJson));
if (created.status >= 300) die(`realm import failed (HTTP ${created.status}): ${created.text.slice(0, 400)}`);

// --- Step 3b: no Keycloak "Update Account Information" page (must run before IGA) ----------------
log("Disabling the first-broker-login profile page...");
const execs = (await api("GET", adm("/authentication/flows/first%20broker%20login/executions"))).json || [];
const review = execs.find((e) => e.providerId === "idp-review-profile");
const reviewCfg = { alias: "review profile config", config: { "update.profile.on.first.login": "off" } };
if (review?.authenticationConfig) await api("PUT", adm(`/authentication/config/${review.authenticationConfig}`), reviewCfg);
else if (review?.id) await api("POST", adm(`/authentication/executions/${review.id}/config`), reviewCfg);
const execsNow = (await api("GET", adm("/authentication/flows/first%20broker%20login/executions"))).json || [];
const cfgId = execsNow.find((e) => e.providerId === "idp-review-profile")?.authenticationConfig;
const cfgVal = cfgId ? (await api("GET", adm(`/authentication/config/${cfgId}`))).json?.config?.["update.profile.on.first.login"] : undefined;
if (cfgVal !== "off") die(`could not disable the first-broker-login profile page (read back '${cfgVal ?? "<unset>"}')`);

// --- Step 4: licence + IGA -----------------------------------------------------------------------
log("Initializing Tide realm (licence + VRK)...");
const setup = await api("POST", adm("/vendorResources/setUpTideRealm"), { email, isRagnarokEnabled: "true" }, { form: true, raw: true });
if (setup.status === 303) die(`setUpTideRealm answered 303 (paid checkout): no free-tier licence. ${setup.text.slice(0, 300)}`);
if (setup.status < 200 || setup.status >= 300) die(`setUpTideRealm failed (HTTP ${setup.status}): ${setup.text.slice(0, 400)}\n       See: docker logs ${CONTAINER} (look for [Midgard])`);
if (setup.text.includes("NEED_PAYMENT")) die("setUpTideRealm answered NEED_PAYMENT: the realm is NOT licensed.");

log("Stamping iga.attestor=tide...");
const rep = (await api("GET", adm(""))).json;
rep.attributes = { ...(rep.attributes || {}), "iga.attestor": "tide" };
await api("PUT", adm(""), rep);

log("Enabling IGA...");
// toggle-iga is a FLIP on current source: read the state first and call it at most once.
const igaNow = String((await api("GET", adm(""))).json?.attributes?.isIGAEnabled ?? "false").toLowerCase();
if (igaNow === "true") {
  console.log("    IGA already enabled; not calling toggle-iga again.");
} else {
  const iga = await api("POST", adm("/tide-admin/toggle-iga"), { isIGAEnabled: "true" }, { form: true, raw: true });
  if (!iga.text.includes('"enabled":true')) die(`toggle-iga did not report enabled=true: ${iga.text.slice(0, 400)}`);
  if (/"warnings"|commitFailures/.test(iga.text)) console.warn(`WARNING: toggle-iga reported warnings: ${iga.text.slice(0, 600)}`);
}

// --- Step 5: approve client/role change requests -------------------------------------------------
await sleep(2000);
await drain("clients + roles");
} // end !resume

// --- Step 6: the household + vendor accounts -----------------------------------------------------
if (!finish) {
log("Creating users: " + USERS.map((u) => u.username).join(", "));
for (const u of USERS) {
  const r = await api("POST", adm("/users"), {
    username: u.username, firstName: u.firstName, lastName: u.lastName, enabled: true,
    // Fictional characters: addresses on the reserved .invalid TLD (RFC 2606), never deliverable.
    // The user profile requires an email; Tide itself does not use it.
    email: `${u.username}@${u.username === "camco-support" ? "camco" : "household"}.invalid`, emailVerified: false,
    attributes: { tideInvitable: ["true"] },
  });
  if (r.status >= 300 && r.status !== 409) die(`create user ${u.username} failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
}
await sleep(2000);
await drain("users");
} // end !finish

const ids = {};
for (const u of USERS) {
  const found = (await api("GET", adm(`/users?username=${u.username}&exact=true`))).json;
  if (!found?.[0]?.id) die(`user ${u.username} not found after creation (change request not committed?)`);
  ids[u.username] = found[0].id;
}

if (!finish) {
// --- Step 6b: vault roles for the three owners (before multi-admin, so no enclave needed) -------
log(`Granting ${VAULT_ROLES.join(", ")} to the owners...`);
const roleReps = [];
for (const name of VAULT_ROLES) {
  const r = (await api("GET", adm(`/roles/${encodeURIComponent(name)}`))).json;
  if (!r?.id) die(`realm role ${name} missing`);
  roleReps.push({ id: r.id, name: r.name });
}
// ONE ROLE PER CALL: IGA records only the first role of a multi-role mapping POST.
for (const u of USERS.filter((u) => u.vault)) {
  for (const rep of roleReps) await api("POST", adm(`/users/${ids[u.username]}/role-mappings/realm`), [rep]);
}
await sleep(2000);
await drain("owner role grants");

// --- Step 7: invite links ------------------------------------------------------------------------
mkdirSync(STATE_DIR, { recursive: true });
const links = {};
for (const u of USERS) {
  const r = await api("POST", adm(`/tideAdminResources/get-required-action-link?userId=${ids[u.username]}&lifespan=43200`),
    ["link-tide-account-action"], { raw: true });
  links[u.username] = r.text.trim();
}
writeFileSync(join(STATE_DIR, "invite-links.txt"), Object.entries(links).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
console.log("\n============================================");
console.log("Create a Tide account for EACH character. Open each link in its own private/incognito");
console.log("window (or a different browser profile) and pick a username + password for that person:\n");
for (const [k, v] of Object.entries(links)) console.log(`  ${k.padEnd(14)} ${v}\n`);
console.log(`(also saved to server/data/invite-links.txt, valid 12h)`);
console.log("============================================\n");

// --- Step 8: wait until every account is linked --------------------------------------------------
// Linking writes tideUserKey, which is itself a change request. Draining as we go keeps all of
// them inside FirstAdmin mode, where the script can still approve them.
log("Waiting for all five accounts to be linked (polling every 5s)...");
const linked = new Set();
while (linked.size < USERS.length) {
  for (const u of USERS) {
    if (linked.has(u.username)) continue;
    const found = (await api("GET", adm(`/users/${ids[u.username]}`))).json;
    if (found?.attributes?.tideUserKey?.[0]) { linked.add(u.username); console.log(`    linked: ${u.username} (${linked.size}/${USERS.length})`); }
  }
  if (linked.size < USERS.length) { await sleep(5000); if ((await pending()).length) await drain("account linking"); }
}

} // end !finish

// --- Step 9: approve everything left -------------------------------------------------------------
await sleep(2000);
await drain("after linking");

// --- Step 10: tide IdP console origin + signed IdP settings --------------------------------------
log("Configuring CustomAdminUIDomain + signing IdP settings...");
const inst = (await api("GET", adm("/identity-provider/instances/tide"))).json;
inst.config = { ...(inst.config || {}), CustomAdminUIDomain: `${TC}/realms/${REALM}/tide-console/` };
await api("PUT", adm("/identity-provider/instances/tide"), inst);
const signIdp = await api("POST", adm("/vendorResources/sign-idp-settings"), undefined, { raw: true });
if (signIdp.status >= 300) console.warn(`WARNING: sign-idp-settings HTTP ${signIdp.status}: ${signIdp.text.slice(0, 300)}`);
await drain("idp settings");

// --- Step 11: export the adapter (before the flip; it is a read, but keep the order simple) ------
log("Exporting adapter config...");
const clientUuid = (await api("GET", adm(`/clients?clientId=${CLIENT}`))).json?.[0]?.id;
const adapter = await api("GET", adm(`/vendorResources/get-installations-provider?clientId=${clientUuid}&providerId=keycloak-oidc-keycloak-json`), undefined, { raw: true });
let adapterJson; try { adapterJson = JSON.parse(adapter.text); } catch { die(`adapter export was not JSON: ${adapter.text.slice(0, 300)}`); }
mkdirSync(dirname(ADAPTER_OUT), { recursive: true });
writeFileSync(ADAPTER_OUT, JSON.stringify(adapterJson, null, 2) + "\n");

// --- Step 12: tide-realm-admin for Alex, LAST (flips FirstAdmin -> MultiAdmin) -------------------
log("Granting tide-realm-admin to alex (this flips the realm to multi-admin)...");
const rmUuid = (await api("GET", adm("/clients?clientId=realm-management"))).json?.[0]?.id;
const tra = (await api("GET", adm(`/clients/${rmUuid}/roles/tide-realm-admin`))).json;
if (!tra?.id) die("tide-realm-admin role not found");
await api("POST", adm(`/users/${ids.alex}/role-mappings/clients/${rmUuid}`), [tra]);
await sleep(2000);
const left = await drain("tide-realm-admin grant");

writeFileSync(join(STATE_DIR, "realm-state.json"), JSON.stringify({ realm: REALM, client: CLIENT, userIds: ids, realmManagementClient: rmUuid }, null, 2) + "\n");

console.log(`
============================================
Bootstrap complete.
  Adapter:   web/public/tidecloak.json
  Realm:     ${REALM}  (${TC}/admin/master/console/#/${REALM})
  Admins:    alex (tide-realm-admin). The realm is now multi-admin: every governed
             change from here on needs an enclave approval.
  Pending:   ${left.length} change request(s)
============================================`);
