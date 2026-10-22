// Provisioning: a new household gets its own TideCloak realm, automatically, when someone signs up.
//
// Same sequence as scripts/bootstrap.mjs (itself a port of the Tide pack's bootstrap), run by the
// server per sign-up:
//   realm from template -> no profile-review page -> licence -> iga.attestor=tide -> IGA on ->
//   first owner user + household-viewer -> invite link -> (owner links their Tide account) ->
//   sign IdP settings -> export adapter -> tide-realm-admin for the owner LAST.
// Everything before that last grant runs in FirstAdmin mode, where root can still approve its own
// setup. Committing the grant flips the realm to multi-admin: from then on CamCo can only file
// requests, and only this household's owners can approve them.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";
import { rootCall, listChangeRequests, userByName, realmManagementClient, TC } from "./tidecloakAdmin.ts";
import { addHousehold, household, households, newHouseholdPaths, updateHousehold, type Household } from "./households.ts";

const APP_URL = process.env.CLIENT_APP_URL || "http://localhost:5173";
const SKIP = new Set(["DISABLE_IGA", "DELETE_REALM", "OFFBOARD_REALM"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SignupInput { householdName: string; ownerName: string; username: string; email?: string }

export function validateSignup(b: Partial<SignupInput>): SignupInput | string {
  const householdName = String(b.householdName ?? "").trim().slice(0, 60);
  const ownerName = String(b.ownerName ?? "").trim().slice(0, 40);
  const username = String(b.username ?? "").trim().toLowerCase();
  const email = String(b.email ?? "").trim();
  if (householdName.length < 2) return "Give your household a name.";
  if (ownerName.length < 1) return "Enter your name.";
  if (!/^[a-z][a-z0-9._-]{1,29}$/.test(username)) return "Username: 2-30 characters, letters, numbers, . _ - and starting with a letter.";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "That email doesn't look right.";
  return { householdName, ownerName, username, email: email || undefined };
}

// The licence belongs to CamCo, the operator, whose own person answered Tide's two questions
// (AP-90). Without both answers, provisioning refuses, exactly like the bootstrap script.
function licence() {
  const email = process.env.TIDE_LICENSE_EMAIL || "";
  if (!email || process.env.TIDE_TERMS_ACCEPTED !== "yes") {
    throw new Error("Provisioning is disabled: TIDE_LICENSE_EMAIL and TIDE_TERMS_ACCEPTED=yes must be set in .env by the operator.");
  }
  return email;
}

/** Start provisioning. Returns at once; progress is polled with the signup token. */
export function startSignup(input: SignupInput): Household {
  licence(); // fail fast before creating anything
  const slug = input.householdName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "home";
  const id = `${slug}-${randomBytes(3).toString("hex")}`;
  const realm = `hh-${id}`;
  const h: Household = {
    id, name: input.householdName, realm, client: `${realm}-client`, ...newHouseholdPaths(id),
    status: "provisioning", createdAt: Date.now(), owner: input.username,
    signupToken: randomBytes(18).toString("base64url"),
  };
  addHousehold(h);
  queue = queue.then(() => provision(h.id, input)).catch(() => {});
  return h;
}

// One provisioning at a time: each runs many root calls and Tide ceremonies.
let queue: Promise<void> = Promise.resolve();

async function drain(realm: string) {
  for (const cr of (await listChangeRequests(realm)).filter((c) => !SKIP.has(c.actionType))) {
    await rootCall(realm, "POST", `/iga/change-requests/${cr.id}/authorize`, {});
  }
  for (let pass = 0; pass < 5; pass++) {
    const ready = (await listChangeRequests(realm)).filter((c) => !SKIP.has(c.actionType) && c.readyToCommit);
    if (!ready.length) break;
    for (const cr of ready) await rootCall(realm, "POST", `/iga/change-requests/${cr.id}/commit`);
  }
  return (await listChangeRequests(realm)).filter((c) => !SKIP.has(c.actionType)).length;
}

function step(id: string, detail: string) {
  console.log(`[provision ${id}] ${detail}`);
}

async function provision(id: string, input: SignupInput) {
  const h = household(id)!;
  const r = h.realm;
  try {
    // 1. realm from template
    step(id, "creating realm");
    const tpl = readFileSync(join(ROOT, "scripts", "realm.json.template"), "utf8")
      .replaceAll("REALM_NAME", r).replaceAll("CLIENT_NAME", h.client).replaceAll("CLIENT_APP_URL", APP_URL);
    const created = await rootCall("", "POST", "", JSON.parse(tpl));
    if (created.status >= 300) throw new Error(`realm import failed (HTTP ${created.status}): ${created.text.slice(0, 200)}`);

    // 2. no Keycloak "Update Account Information" page (must happen before IGA)
    const flows = (await rootCall(r, "GET", "/authentication/flows/first%20broker%20login/executions")).body as { providerId: string; id: string; authenticationConfig?: string }[];
    const review = flows?.find((e) => e.providerId === "idp-review-profile");
    const cfg = { alias: "review profile config", config: { "update.profile.on.first.login": "off" } };
    if (review?.authenticationConfig) await rootCall(r, "PUT", `/authentication/config/${review.authenticationConfig}`, cfg);
    else if (review?.id) await rootCall(r, "POST", `/authentication/executions/${review.id}/config`, cfg);

    // 3. licence + keys
    step(id, "licensing");
    const setup = await rootCall(r, "POST", "/vendorResources/setUpTideRealm", { email: licence(), isRagnarokEnabled: "true" }, { form: true });
    if (setup.status < 200 || setup.status >= 300 || setup.text.includes("NEED_PAYMENT")) {
      throw new Error(`Tide licensing failed (HTTP ${setup.status}): ${setup.text.slice(0, 200)}`);
    }

    // 4. cryptographic governance on
    step(id, "enabling IGA");
    const rep = (await rootCall(r, "GET", "")).body as { attributes?: Record<string, string> };
    rep.attributes = { ...(rep.attributes ?? {}), "iga.attestor": "tide" };
    await rootCall(r, "PUT", "", rep);
    const iga = await rootCall(r, "POST", "/tide-admin/toggle-iga", { isIGAEnabled: "true" }, { form: true });
    if (!iga.text.includes('"enabled":true')) throw new Error(`toggle-iga did not report enabled: ${iga.text.slice(0, 200)}`);
    await sleep(1500);
    await drain(r);

    // 5. first owner, holding the vault role (still FirstAdmin: root can approve its own setup)
    step(id, "creating first owner");
    const u = await rootCall(r, "POST", "/users", {
      username: input.username, firstName: input.ownerName, lastName: "", enabled: true,
      email: input.email || `${input.username}@${r}.invalid`, emailVerified: false, attributes: { tideInvitable: ["true"] },
    });
    if (u.status >= 300) throw new Error(`creating the owner failed (HTTP ${u.status}): ${u.text.slice(0, 200)}`);
    await sleep(1000);
    await drain(r);
    const owner = await userByName(r, input.username);
    if (!owner) throw new Error("owner not found after creation");
    const viewer = (await rootCall(r, "GET", "/roles/household-viewer")).body as { id: string; name: string };
    await rootCall(r, "POST", `/users/${owner.id}/role-mappings/realm`, [{ id: viewer.id, name: viewer.name }]);
    await sleep(1000);
    await drain(r);

    // 6. the owner creates their Tide account
    const link = await rootCall(r, "POST", `/tideAdminResources/get-required-action-link?userId=${owner.id}&lifespan=43200`, ["link-tide-account-action"]);
    if (link.status >= 300) throw new Error(`invite link failed (HTTP ${link.status})`);
    updateHousehold(id, { status: "awaiting-owner", inviteLink: link.text.trim() });
    step(id, "waiting for the owner to link a Tide account");
    // Not awaited: waiting for a person can take hours and must not hold up other sign-ups.
    void waitThenFinish(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    step(id, `FAILED: ${msg}`);
    updateHousehold(id, { status: "failed", error: msg });
  }
}

/** Waits for the owner's Tide account, then completes setup. Also resumes after a restart. */
async function finishWhenLinked(id: string) {
  const h = household(id)!;
  const r = h.realm;
  const deadline = Date.now() + 12 * 3600_000; // the invite link's lifetime
  for (;;) {
    const owner = await userByName(r, h.owner!);
    if (owner?.attributes?.tideUserKey?.[0]) break;
    if (Date.now() > deadline) throw new Error("the owner's invite link expired before it was used");
    if ((await listChangeRequests(r)).length) await drain(r);
    await sleep(5000);
  }
  updateHousehold(id, { status: "finalizing" });
  step(id, "owner linked; finalizing");
  await sleep(1500);
  await drain(r);

  // sign IdP settings (needs healthy ORKs), still FirstAdmin
  const inst = (await rootCall(r, "GET", "/identity-provider/instances/tide")).body as { config?: Record<string, string> };
  inst.config = { ...(inst.config ?? {}), CustomAdminUIDomain: `${TC}/realms/${r}/tide-console/` };
  await rootCall(r, "PUT", "/identity-provider/instances/tide", inst);
  await rootCall(r, "POST", "/vendorResources/sign-idp-settings");
  await drain(r);

  // export the adapter (public: realm key, vendorId, URLs)
  const clientUuid = ((await rootCall(r, "GET", `/clients?clientId=${h.client}`)).body as { id: string }[])?.[0]?.id;
  const adapter = await rootCall(r, "GET", `/vendorResources/get-installations-provider?clientId=${clientUuid}&providerId=keycloak-oidc-keycloak-json`);
  const json = JSON.parse(adapter.text);
  if (!json.jwk) throw new Error("adapter has no jwk: the realm is not licensed");
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(h.adapterPath, JSON.stringify(json, null, 2) + "\n");

  // tide-realm-admin LAST: flips FirstAdmin -> multi-admin
  const rm = await realmManagementClient(r);
  const owner = (await userByName(r, h.owner!))!;
  const tra = (await rootCall(r, "GET", `/clients/${rm}/roles/tide-realm-admin`)).body;
  await rootCall(r, "POST", `/users/${owner.id}/role-mappings/clients/${rm}`, [tra]);
  await sleep(1500);
  await drain(r);

  updateHousehold(id, { status: "ready", inviteLink: undefined });
  step(id, "ready");
}

/** Runs finishWhenLinked and records a failure if it throws. */
function waitThenFinish(id: string) {
  return finishWhenLinked(id).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    step(id, `FAILED: ${msg}`);
    updateHousehold(id, { status: "failed", error: msg });
  });
}

/** On server start: pick up households that were waiting for their owner when we stopped. */
export function resumeProvisioning() {
  for (const h of households()) {
    if (h.status === "awaiting-owner" || h.status === "finalizing") {
      void waitThenFinish(h.id);
    } else if (h.status === "provisioning") {
      updateHousehold(h.id, { status: "failed", error: "the server restarted during provisioning; sign up again" });
    }
  }
}
