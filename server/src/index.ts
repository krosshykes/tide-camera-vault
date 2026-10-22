// CamCo's cloud backend. It stores what cameras upload and serves the apps, for every household.
//
// It only ever holds ciphertext: each clip is AES-GCM encrypted in the browser, and the clip key
// is wrapped by the Tide network under that household's vault policy. Nothing here can unwrap it.
// Every authenticated route verifies the Tide JWT and its DPoP proof (src/auth/tide.ts); the
// token's issuer decides which household (realm) the request belongs to.
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, isHousehold, isOwner, type Caller } from "./auth/tide.ts";
import { db, save, audit, type Clip, type Camera } from "./db.ts";
import {
  rootCall, listChangeRequests, fileRealmRoleGrant, fileRealmRoleRevoke, fileOwnerGrant, fileCreateUser,
  inviteLink, members, directory, adminPolicy, userByName,
} from "./tidecloakAdmin.ts";
import { households, household, adapterOf, publicView, VENDOR_REALM, isStaffRealm, staffRealm, customerHouseholds, updateHousehold, type Household } from "./households.ts";
import { startSignup, validateSignup, resumeProvisioning, ensureStaffRealm } from "./provision.ts";
import { serviceHealth, householdMetadata, fleet, legalRequests, logLegalRequest } from "./ops.ts";
import { QUOTA_BYTES, RETENTION_CHOICES, usedBytes, storageSummary, removeClips, prune, startRetentionSweep } from "./storage.ts";

const VENDOR_STAFF = (process.env.VENDOR_STAFF || "camco-support").split(",").map((s) => s.trim());
// CamCo staff sign in to CamCo's own staff realm: anyone there is staff. Until that realm's first
// account is linked, camco-support in the demo realm still works (the legacy vendor login).
// A username alone means nothing in a customer realm.
const isVendor = (c: Caller, h: Household) => isStaffRealm(h) || (h.realm === VENDOR_REALM && VENDOR_STAFF.includes(c.username));
// household-viewer is a composite carrying _tide_decryptor + _tide_encryptor, so joining the
// household is ONE governed grant (IGA allows one pending change request per user).
const VIEW_ROLES = ["household-viewer"];

const app = express();
app.use(express.json({ limit: "15mb" }));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) }));
const H = (req: Request) => req.household!;
const record = (req: Request, what: string, detail: string) => { audit(H(req), req.caller!.username, what, detail); save(H(req)); };

app.get("/api/health", (_req, res) => { res.json({ ok: true, households: households().length }); });

// --- public: find a household, sign up -----------------------------------------------------------
// A household id is only useful to someone who knows it; the list of households is never public.
app.get("/api/households/:id", (req, res) => {
  const h = household(String(req.params.id));
  if (!h) return res.status(404).json({ error: "No household with that code" });
  res.json(publicView(h));
});

// The adapter is public by design: realm URL, client id, the realm's public key, vendorId.
app.get("/api/households/:id/adapter", (req, res) => {
  const h = household(String(req.params.id));
  const a = h && (h.status === "ready" || h.status === "finalizing") ? adapterOf(h) : null;
  if (!a) return res.status(404).json({ error: h ? `This household is still being set up (${h.status})` : "No household with that code" });
  res.json(a);
});

// Which realm CamCo staff sign in to (for the /staff page). Not a secret: it holds no customer data.
app.get("/api/staff-realm", (_req, res) => {
  const s = staffRealm();
  if (s?.status === "ready") return res.json({ id: s.id, name: s.name, legacy: false });
  res.json({ id: VENDOR_REALM, name: "The Demo Household", legacy: true, staffRealmStatus: s?.status ?? "not created" });
});

// Light abuse control for the one unauthenticated write. Each sign-up creates and licenses a realm.
const signups = new Map<string, number[]>();
app.post("/api/signup", (req, res) => {
  const ip = req.ip ?? "?";
  const recent = (signups.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000);
  if (recent.length >= 3) return res.status(429).json({ error: "Too many sign-ups from here. Try again in an hour." });
  const input = validateSignup(req.body ?? {});
  if (typeof input === "string") return res.status(400).json({ error: input });
  try {
    const h = startSignup(input);
    signups.set(ip, [...recent, Date.now()]);
    res.status(202).json({ token: h.signupToken, household: publicView(h) });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Progress for the person who signed up. The token is the only key; it's never listed anywhere.
app.get("/api/signup/:token", (req, res) => {
  const h = households().find((x) => x.signupToken && x.signupToken === req.params.token);
  if (!h) return res.status(404).json({ error: "Unknown sign-up" });
  res.json({
    household: publicView(h), status: h.status, error: h.error ?? null,
    inviteLink: h.status === "awaiting-owner" ? h.inviteLink : null, owner: h.owner,
  });
});

// --- who am I ------------------------------------------------------------------------------------
app.get("/api/me", requireAuth(), (req, res) => {
  const c = req.caller!;
  res.json({
    username: c.username,
    realmRoles: c.realmRoles,
    isOwner: c.isRealmAdmin,
    isHousehold: isHousehold(c),
    isVendor: isVendor(c, H(req)),
    canDecrypt: c.realmRoles.includes("_tide_decryptor"),
    household: publicView(H(req)),
  });
});

// --- the vault policy (signed once by an owner in the Tide enclave) -----------------------------
app.get("/api/vault/status", requireAuth(), (req, res) => {
  const p = db(H(req)).vaultPolicy;
  res.json({ hasPolicy: !!p, recordId: p?.recordId ?? null, signedBy: p?.signedBy ?? null, signedAt: p?.signedAt ?? null });
});

// The policy names a role, so it is useless without that role. Still, only hand it out to
// household members (AP-RA07): who-has-access is metadata.
app.get("/api/vault/policy", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  const p = db(H(req)).vaultPolicy;
  if (!p) return res.status(404).json({ error: "The household has not set up its vault yet" });
  res.json(p);
});

// Owners only (AP-RA08). The bytes are only useful if the network signed them.
app.put("/api/vault/policy", requireAuth(isOwner, "Only household owners can set the vault policy"), (req, res) => {
  const { policy, recordId } = req.body ?? {};
  if (typeof policy !== "string" || policy.length < 32 || typeof recordId !== "string" || !recordId) {
    return res.status(400).json({ error: "policy (base64) and recordId are required" });
  }
  db(H(req)).vaultPolicy = { policy, recordId, signedBy: req.caller!.username, signedAt: Date.now() };
  record(req, "vault-policy.signed", `RelationshipAttestation:1 policy for record ${recordId}`);
  res.json({ ok: true });
});

// The realm's admin policy, needed to authorise signing the vault policy (relationship.ts).
app.get("/api/admin-policy", requireAuth(isOwner, "Owners only"), wrap(async (req, res) => {
  const r = await adminPolicy(H(req).realm);
  const policy = (r.body as { policy?: string })?.policy;
  if (r.status !== 200 || !policy) return res.status(502).json({ error: `admin policy unavailable (HTTP ${r.status})`, body: r.body });
  res.json({ policy });
}));

// --- cameras ---------------------------------------------------------------------------------------
// Owners register the household's cameras; any member can feed one from a device on their computer.
app.get("/api/cameras", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  res.json(db(H(req)).cameras);
});

app.post("/api/cameras", requireAuth(isOwner, "Only owners can add cameras"), (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 40);
  const location = String(req.body?.location ?? "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "Give the camera a name" });
  const d = db(H(req));
  if (d.cameras.length >= 16) return res.status(400).json({ error: "A household can have up to 16 cameras" });
  if (d.cameras.some((c) => c.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: `There is already a camera called "${name}"` });
  const cam: Camera = { id: randomUUID(), name, location, addedBy: req.caller!.username, addedAt: Date.now() };
  d.cameras.push(cam);
  record(req, "camera.added", `${name}${location ? ` (${location})` : ""}`);
  res.status(201).json(cam);
});

app.delete("/api/cameras/:id", requireAuth(isOwner, "Only owners can remove cameras"), (req, res) => {
  const d = db(H(req));
  const i = d.cameras.findIndex((c) => c.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "No such camera" });
  const [cam] = d.cameras.splice(i, 1);
  record(req, "camera.removed", `${cam.name} (its clips are kept)`);
  res.json({ ok: true });
});

// --- clips ---------------------------------------------------------------------------------------
app.post("/api/clips", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  const { id: wantedId, cameraId, camera: cameraName, label, mime, iv, ciphertext, wrappedKey, capturedAt, restore } = req.body ?? {};
  for (const [k, v] of Object.entries({ cameraId, mime, iv, ciphertext, wrappedKey })) {
    if (typeof v !== "string" || !v) return res.status(400).json({ error: `${k} is required` });
  }
  // The household's device saves its own encrypted copy first, under an id it chose, so both
  // copies share one id. A restore re-uploads that copy after CamCo lost or deleted its own.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (wantedId !== undefined && (typeof wantedId !== "string" || !UUID.test(wantedId))) return res.status(400).json({ error: "id must be a UUID" });
  const d = db(H(req));
  if (wantedId && d.clips.some((c) => c.id === wantedId)) return res.status(409).json({ error: "CamCo's cloud already holds this clip" });
  const cam = d.cameras.find((c) => c.id === cameraId);
  // A restored clip may come from a camera that has since been removed: keep its recorded name.
  if (!cam && !(restore === true && typeof cameraName === "string" && cameraName)) return res.status(400).json({ error: "Unknown camera: it may have been removed" });
  const camera = cam?.name ?? String(cameraName).slice(0, 40);
  const bytes = Math.floor((ciphertext.length * 3) / 4);
  prune(H(req));
  if (usedBytes(H(req)) + bytes > QUOTA_BYTES) {
    return res.status(413).json({ error: "This household's storage is full. Delete some clips or shorten the retention period." });
  }
  const clip: Clip = {
    id: wantedId || randomUUID(), camera, cameraId, label: typeof label === "string" ? label : "Motion detected", mime, iv, ciphertext, wrappedKey,
    capturedAt: typeof capturedAt === "number" ? capturedAt : Date.now(), uploadedBy: req.caller!.username, bytes,
  };
  d.clips.unshift(clip);
  d.clips.sort((a, b) => b.capturedAt - a.capturedAt);
  record(req, restore === true ? "clip.restored" : "clip.uploaded", `${camera}: ${clip.label} (${clip.bytes} bytes ciphertext)${restore === true ? ", restored from a household copy" : ""}`);
  res.status(201).json({ id: clip.id });
});

app.get("/api/clips", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  prune(H(req));
  res.json(db(H(req)).clips.map(({ ciphertext: _c, wrappedKey: _w, iv: _i, ...meta }) => meta));
});

// Deleting footage: owners can delete any clip, other members only what they uploaded. Checked
// against the verified token. Deleting ciphertext gives no one the ability to watch anything.
const mayDelete = (c: Caller, clip: Clip) => c.isRealmAdmin || clip.uploadedBy === c.username;

app.post("/api/clips/delete", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: "ids is required" });
  const d = db(H(req));
  const allowed = new Set<string>();
  const refused: string[] = [];
  for (const id of ids) {
    const clip = d.clips.find((c) => c.id === id);
    if (!clip) continue;
    if (mayDelete(req.caller!, clip)) allowed.add(id); else refused.push(id);
  }
  const removed = removeClips(H(req), allowed, { by: req.caller!.username, reason: "deleted by a household member" });
  if (removed.length) {
    const bytes = removed.reduce((n, c) => n + c.bytes, 0);
    record(req, "clips.deleted", `${removed.length} clip(s), ${Math.round(bytes / 1024)} KB: ${[...new Set(removed.map((c) => c.camera))].join(", ")}`);
  }
  res.json({ deleted: removed.map((c) => c.id), refused });
});

// Deliberate deletions, so a member's device can tell "the household deleted it" from "it vanished".
app.get("/api/clips/tombstones", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  prune(H(req));
  res.json((db(H(req)).tombstones ?? []).map((t) => ({ id: t.id, at: t.at, by: t.by, reason: t.reason })));
});

app.get("/api/storage", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  prune(H(req));
  res.json({ ...storageSummary(H(req)), retentionChoices: RETENTION_CHOICES });
});

// --- household settings -----------------------------------------------------------------------------
// The timezone is display metadata: every time in the app and the stamp on new footage use it.
const validTimezone = (name: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; } };

app.get("/api/settings", requireAuth(), (req, res) => {
  res.json({ timezone: db(H(req)).timezone ?? null });
});

app.put("/api/settings/timezone", requireAuth(isOwner, "Only owners can change the household timezone"), (req, res) => {
  const tz = String(req.body?.timezone ?? "").trim();
  if (!tz || tz.length > 64 || !validTimezone(tz)) return res.status(400).json({ error: `Unknown timezone "${tz}"` });
  const before = db(H(req)).timezone ?? "each device's own";
  db(H(req)).timezone = tz;
  record(req, "settings.timezone", `household timezone changed from ${before} to ${tz}`);
  res.json({ timezone: tz });
});

app.put("/api/storage/retention", requireAuth(isOwner, "Only owners can change retention"), (req, res) => {
  const raw = req.body?.days;
  const days = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (days !== null && !(RETENTION_CHOICES as readonly number[]).includes(days)) {
    return res.status(400).json({ error: `days must be one of ${RETENTION_CHOICES.join(", ")} or null` });
  }
  db(H(req)).retentionDays = days;
  record(req, "retention.changed", days ? `clips older than ${days} days are deleted automatically` : "clips are kept until someone deletes them");
  const pruned = prune(H(req));
  res.json({ retentionDays: days, pruned });
});

app.get("/api/clips/:id", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  const clip = db(H(req)).clips.find((c) => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: "No such clip" });
  res.json(clip);
});

// --- household governance ------------------------------------------------------------------------
// Directory so the approvals screen can show names instead of user ids.
app.get("/api/directory", requireAuth(), wrap(async (req, res) => {
  res.json(await directory(H(req).realm));
}));

// An owner asks for someone to get viewing rights. The server only FILES the change request
// (through TideCloak, as root); it cannot approve it. Owners approve from their own browsers.
app.post("/api/household/request-viewer", requireAuth(isOwner, "Only owners can propose members"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "");
  const out = await fileRealmRoleGrant(H(req).realm, username, VIEW_ROLES);
  record(req, "household.request-viewer", `${username}: ${out.results.map((r) => `${r.role}=${r.status || r.note}`).join(", ")}`);
  res.json(out);
}));

app.post("/api/household/request-owner", requireAuth(isOwner, "Only owners can propose owners"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "");
  const out = await fileOwnerGrant(H(req).realm, username);
  record(req, "household.request-owner", `${username}: tide-realm-admin=${out.results[0].status}`);
  res.json(out);
}));

// Someone leaves: an owner files the removal. Like a grant, it only applies once enough owners
// approve it in the Tide enclave. The vault policy names the role, so taking the role away cuts
// off every clip, old and new, with no re-encryption.
app.post("/api/household/revoke-viewer", requireAuth(isOwner, "Only owners can remove members"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "");
  // Checked against the verified token, not anything the browser claims: an owner can't file
  // their own removal. Another owner has to propose it.
  if (username === req.caller!.username) {
    record(req, "household.revoke-viewer.refused", `${username} tried to remove their own access`);
    return res.status(403).json({ error: "You can't remove your own access. Another owner has to request it." });
  }
  const out = await fileRealmRoleRevoke(H(req).realm, username, VIEW_ROLES);
  record(req, "household.revoke-viewer", `${username}: ${out.results.map((r) => `${r.role}=${r.status || r.note}`).join(", ")}`);
  res.json(out);
}));

// Add a new person to the household. This files CREATE_USER; once owners approve it, an owner
// fetches the person's invite link (below) and sends it to them. They start with no access.
app.post("/api/household/invite", requireAuth(isOwner, "Only owners can invite people"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "").trim().toLowerCase();
  const name = String(req.body?.name ?? "").trim().slice(0, 40) || username;
  if (!/^[a-z][a-z0-9._-]{1,29}$/.test(username)) return res.status(400).json({ error: "Username: 2-30 characters, letters, numbers, . _ - and starting with a letter." });
  if (await userByName(H(req).realm, username)) return res.status(409).json({ error: `${username} is already in this household` });
  const out = await fileCreateUser(H(req).realm, username, name);
  record(req, "household.invite", `${username}: CREATE_USER -> HTTP ${out.status}`);
  res.json(out);
}));

// The Tide account link for someone who hasn't created theirs yet. Owners hand it over themselves.
app.post("/api/household/invite-link", requireAuth(isOwner, "Owners only"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "");
  const user = await userByName(H(req).realm, username);
  if (!user) return res.status(404).json({ error: `No ${username} in this household (is the request to add them approved yet?)` });
  if (user.attributes?.tideUserKey?.[0]) return res.status(409).json({ error: `${username} already has a Tide account` });
  const link = await inviteLink(H(req).realm, username);
  record(req, "household.invite-link", `issued a 12h invite link for ${username}`);
  res.json({ link });
}));

app.get("/api/household/members", requireAuth(isOwner, "Owners only"), wrap(async (req, res) => {
  res.json(await members(H(req).realm, H(req).realm === VENDOR_REALM ? VENDOR_STAFF : []));
}));

// Everything CamCo did that touched this household, plus legal requests about it: transparency.
app.get("/api/household/notices", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  res.json(db(H(req)).audit.filter((a) => a.what.startsWith("vendor.") || a.what.startsWith("legal-request.")).slice(0, 30));
});

app.get("/api/audit", requireAuth((c, h) => isHousehold(c) || isVendor(c, h)), (req, res) => { res.json(db(H(req)).audit.slice(0, 50)); });

// --- vendor console (CamCo staff) ----------------------------------------------------------------
// CamCo owns this database and runs TideCloak, so its console shows every household's raw rows and
// holds root on every realm. That's the honest premise. None of it opens a clip.
const vendorOnly = requireAuth(isVendor, "CamCo staff only");
// Vendor actions are written into the TARGET household's own log, so the family sees them.
const recordIn = (target: Household, req: Request, what: string, detail: string) => { audit(target, `CamCo (${req.caller!.username})`, what, detail); save(target); };
function targetOf(req: Request) {
  const id = String(req.query.household ?? req.body?.household ?? customerHouseholds()[0]?.id ?? VENDOR_REALM);
  const h = household(id);
  if (!h) throw new Error(`No household ${id}`);
  return h;
}

app.get("/api/vendor/households", vendorOnly, (_req, res) => {
  res.json(customerHouseholds().map((h) => ({
    ...publicView(h), realm: h.realm, owner: h.owner, clips: db(h).clips.length, vault: !!db(h).vaultPolicy, ...householdMetadata(h),
  })));
});

app.get("/api/vendor/ops", vendorOnly, wrap(async (_req, res) => { res.json(await serviceHealth()); }));

app.get("/api/vendor/fleet", vendorOnly, wrap(async (req, res) => { res.json(fleet(targetOf(req))); }));

// The threat this demonstrates: CamCo can destroy ciphertext on its own disks (a bug, a rogue
// admin, a breach). It leaves no tombstone and isn't written to the household's log, exactly as
// a quiet deletion wouldn't be. The household's own copies are how footage survives it.
app.post("/api/vendor/clips/:id/destroy", vendorOnly, wrap(async (req, res) => {
  const target = targetOf(req);
  const removed = removeClips(target, new Set([String(req.params.id)]), null);
  if (!removed.length) return res.status(404).json({ error: "No such clip" });
  save(target);
  audit(H(req), req.caller!.username, "vendor.destroyed-ciphertext", `${target.id}: ${removed[0].camera} ${removed[0].id} (no tombstone)`);
  save(H(req));
  res.json({ destroyed: removed[0].id });
}));

// Onboarding support: a customer lost their setup link. Root can issue a fresh one only while the
// owner has not created their Tide account; after that, nobody at CamCo can stand in for them.
app.post("/api/vendor/households/:id/reissue-link", vendorOnly, wrap(async (req, res) => {
  const h = household(String(req.params.id));
  if (!h || isStaffRealm(h)) return res.status(404).json({ error: "No such household" });
  if (h.status !== "awaiting-owner") return res.status(409).json({ error: `Only possible while the household waits for its owner (it is ${h.status}).` });
  const link = await inviteLink(h.realm, h.owner!);
  updateHousehold(h.id, { inviteLink: link });
  recordIn(h, req, "vendor.reissue-link", `issued a fresh setup link for ${h.owner}`);
  res.json({ link });
}));

app.get("/api/vendor/legal-requests", vendorOnly, (_req, res) => { res.json(legalRequests()); });

app.post("/api/vendor/legal-requests", vendorOnly, wrap(async (req, res) => {
  const target = targetOf(req);
  const requester = String(req.body?.requester ?? "").trim();
  const reference = String(req.body?.reference ?? "").trim();
  const scope = String(req.body?.scope ?? "").trim();
  if (!requester || !reference || !scope) return res.status(400).json({ error: "requester, reference and scope are required" });
  res.status(201).json(logLegalRequest(req.caller!.username, target, { requester, reference, scope }));
}));

app.get("/api/vendor/records", vendorOnly, wrap(async (req, res) => {
  const d = db(targetOf(req));
  res.json({ clips: d.clips, vaultPolicy: d.vaultPolicy });
}));

app.get("/api/vendor/change-requests", vendorOnly, wrap(async (req, res) => {
  res.json(await listChangeRequests(targetOf(req).realm, "PENDING"));
}));

// Root tries to give CamCo Support viewing rights in a household. In a customer's realm, CamCo
// staff don't even exist yet, so root first has to file the account itself: also a request.
app.post("/api/vendor/self-grant", vendorOnly, wrap(async (req, res) => {
  const target = targetOf(req);
  const me = req.caller!.username;
  if (!(await userByName(target.realm, me))) {
    const created = await fileCreateUser(target.realm, me, "CamCo Support");
    const changeRequests = (await listChangeRequests(target.realm)).filter((c) => c.actionType === "CREATE_USER").slice(-1);
    recordIn(target, req, "vendor.self-grant", `root filed an account for ${me} in your household (HTTP ${created.status}). It needs your approval.`);
    return res.json({ results: [{ role: `account in ${target.name}`, status: created.status, changeRequestId: changeRequests[0]?.id }], changeRequests });
  }
  const out = await fileRealmRoleGrant(target.realm, me, VIEW_ROLES);
  recordIn(target, req, "vendor.self-grant", `root asked to give ${me} ${out.results.map((r) => `${r.role} (HTTP ${r.status || r.note})`).join(", ")}. It needs your approval.`);
  res.json(out);
}));

// Root tries every approval lane TideCloak has. We report exactly what TideCloak answers.
app.post("/api/vendor/cr/:id/force", vendorOnly, wrap(async (req, res) => {
  const target = targetOf(req);
  const id = encodeURIComponent(String(req.params.id));
  const attempts = [];
  for (const lane of ["approve", "authorize", "commit"] as const) {
    const r = await rootCall(target.realm, "POST", `/iga/change-requests/${id}/${lane}`, lane === "commit" ? undefined : {});
    attempts.push({ lane, status: r.status, body: r.body });
  }
  const after = (await rootCall(target.realm, "GET", `/iga/change-requests/${id}`)).body;
  recordIn(target, req, "vendor.force-approve", `root tried to approve its own request: ${attempts.map((a) => `${a.lane} → HTTP ${a.status}`).join(", ")}`);
  res.json({ attempts, changeRequest: after });
}));

const PORT = Number(process.env.PORT || 4000);
// Express 5 calls this callback on failure too (e.g. port in use), so check the error.
app.listen(PORT, (err?: Error) => {
  if (err) { console.error(`camera-vault server failed to start: ${err.message}`); process.exit(1); }
  console.log(`camera-vault server on http://localhost:${PORT} (${households().length} household(s))`);
  resumeProvisioning();
  startRetentionSweep();
  ensureStaffRealm();
});
