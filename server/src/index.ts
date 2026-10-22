// CamCo's cloud backend. It stores what cameras upload and serves the apps, for every household.
//
// It only ever holds ciphertext: each clip is AES-GCM encrypted in the browser, and the clip key
// is wrapped by the Tide network under that household's vault policy. Nothing here can unwrap it.
// Every authenticated route verifies the Tide JWT and its DPoP proof (src/auth/tide.ts); the
// token's issuer decides which household (realm) the request belongs to.
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, isHousehold, isOwner, type Caller } from "./auth/tide.ts";
import { db, save, audit, type Clip } from "./db.ts";
import {
  rootCall, listChangeRequests, fileRealmRoleGrant, fileRealmRoleRevoke, fileOwnerGrant, fileCreateUser,
  inviteLink, members, directory, adminPolicy, userByName,
} from "./tidecloakAdmin.ts";
import { households, household, adapterOf, publicView, VENDOR_REALM, type Household } from "./households.ts";
import { startSignup, validateSignup, resumeProvisioning } from "./provision.ts";

const VENDOR_STAFF = (process.env.VENDOR_STAFF || "camco-support").split(",").map((s) => s.trim());
// CamCo staff sign in to CamCo's own realm. Their username alone means nothing in a customer realm.
const isVendor = (c: Caller, h: Household) => h.realm === VENDOR_REALM && VENDOR_STAFF.includes(c.username);
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

// --- clips ---------------------------------------------------------------------------------------
app.post("/api/clips", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  const { camera, label, mime, iv, ciphertext, wrappedKey, capturedAt } = req.body ?? {};
  for (const [k, v] of Object.entries({ camera, mime, iv, ciphertext, wrappedKey })) {
    if (typeof v !== "string" || !v) return res.status(400).json({ error: `${k} is required` });
  }
  const clip: Clip = {
    id: randomUUID(), camera, label: typeof label === "string" ? label : "Motion detected", mime, iv, ciphertext, wrappedKey,
    capturedAt: typeof capturedAt === "number" ? capturedAt : Date.now(), uploadedBy: req.caller!.username,
    bytes: Math.floor((ciphertext.length * 3) / 4),
  };
  db(H(req)).clips.unshift(clip);
  record(req, "clip.uploaded", `${camera}: ${clip.label} (${clip.bytes} bytes ciphertext)`);
  res.status(201).json({ id: clip.id });
});

app.get("/api/clips", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  res.json(db(H(req)).clips.map(({ ciphertext: _c, wrappedKey: _w, iv: _i, ...meta }) => meta));
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

app.get("/api/audit", requireAuth((c, h) => isHousehold(c) || isVendor(c, h)), (req, res) => { res.json(db(H(req)).audit.slice(0, 50)); });

// --- vendor console (CamCo staff) ----------------------------------------------------------------
// CamCo owns this database and runs TideCloak, so its console shows every household's raw rows and
// holds root on every realm. That's the honest premise. None of it opens a clip.
const vendorOnly = requireAuth(isVendor, "CamCo staff only");
function targetOf(req: Request) {
  const id = String(req.query.household ?? req.body?.household ?? VENDOR_REALM);
  const h = household(id);
  if (!h) throw new Error(`No household ${id}`);
  return h;
}

app.get("/api/vendor/households", vendorOnly, (_req, res) => {
  res.json(households().map((h) => ({ ...publicView(h), realm: h.realm, clips: db(h).clips.length, vault: !!db(h).vaultPolicy })));
});

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
    record(req, "vendor.self-grant", `root files CREATE_USER ${me} in ${target.id} -> HTTP ${created.status}`);
    return res.json({ results: [{ role: `account in ${target.name}`, status: created.status, changeRequestId: changeRequests[0]?.id }], changeRequests });
  }
  const out = await fileRealmRoleGrant(target.realm, me, VIEW_ROLES);
  record(req, "vendor.self-grant", `root grants ${out.results.map((r) => `${r.role}=${r.status || r.note}`).join(", ")} to ${me} in ${target.id}`);
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
  record(req, "vendor.force-approve", `${target.id}: ${attempts.map((a) => `${a.lane}=${a.status}`).join(", ")}`);
  res.json({ attempts, changeRequest: after });
}));

const PORT = Number(process.env.PORT || 4000);
// Express 5 calls this callback on failure too (e.g. port in use), so check the error.
app.listen(PORT, (err?: Error) => {
  if (err) { console.error(`camera-vault server failed to start: ${err.message}`); process.exit(1); }
  console.log(`camera-vault server on http://localhost:${PORT} (${households().length} household(s))`);
  resumeProvisioning();
});
