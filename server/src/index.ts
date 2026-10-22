// CamCo's cloud backend. It stores what cameras upload and serves the apps.
//
// It only ever holds ciphertext: each clip is AES-GCM encrypted in the browser, and the clip key
// is wrapped by the Tide network under the household's vault policy. Nothing here can unwrap it.
// Every route verifies the Tide JWT and its DPoP proof (src/auth/tide.ts).
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, isHousehold, isOwner, type Caller } from "./auth/tide.ts";
import { db, save, audit, type Clip } from "./db.ts";
import {
  rootCall, listChangeRequests, fileRealmRoleGrant, fileRealmRoleRevoke, members, fileOwnerGrant, adminPolicy, realmState, roleNames, REALM,
} from "./tidecloakAdmin.ts";

const VENDOR_STAFF = (process.env.VENDOR_STAFF || "camco-support").split(",").map((s) => s.trim());
const isVendor = (c: Caller) => VENDOR_STAFF.includes(c.username);
// household-viewer is a composite carrying _tide_decryptor + _tide_encryptor, so joining the
// household is ONE governed grant (IGA allows one pending change request per user).
const VIEW_ROLES = ["household-viewer"];

const app = express();
app.use(express.json({ limit: "15mb" }));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) }));

app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

// --- who am I ------------------------------------------------------------------------------------
app.get("/api/me", requireAuth(), (req, res) => {
  const c = req.caller!;
  res.json({
    username: c.username,
    realmRoles: c.realmRoles,
    isOwner: c.isRealmAdmin,
    isHousehold: isHousehold(c),
    isVendor: isVendor(c),
    canDecrypt: c.realmRoles.includes("_tide_decryptor"),
  });
});

// --- the vault policy (signed once by an owner in the Tide enclave) -----------------------------
app.get("/api/vault/status", requireAuth(), (_req, res) => {
  const p = db().vaultPolicy;
  res.json({ hasPolicy: !!p, recordId: p?.recordId ?? null, signedBy: p?.signedBy ?? null, signedAt: p?.signedAt ?? null });
});

// The policy names a role, so it is useless without that role. Still, only hand it out to
// household members (AP-RA07): who-has-access is metadata.
app.get("/api/vault/policy", requireAuth(isHousehold, "Not a household member"), (_req, res) => {
  const p = db().vaultPolicy;
  if (!p) return res.status(404).json({ error: "The household has not set up its vault yet" });
  res.json(p);
});

// Owners only (AP-RA08). The bytes are only useful if the network signed them.
app.put("/api/vault/policy", requireAuth(isOwner, "Only household owners can set the vault policy"), (req, res) => {
  const { policy, recordId } = req.body ?? {};
  if (typeof policy !== "string" || policy.length < 32 || typeof recordId !== "string" || !recordId) {
    return res.status(400).json({ error: "policy (base64) and recordId are required" });
  }
  const d = db();
  d.vaultPolicy = { policy, recordId, signedBy: req.caller!.username, signedAt: Date.now() };
  audit(req.caller!.username, "vault-policy.signed", `RelationshipAttestation:1 policy for record ${recordId}`);
  save();
  res.json({ ok: true });
});

// The realm's admin policy, needed to authorise signing the vault policy (relationship.ts).
app.get("/api/admin-policy", requireAuth(isOwner, "Owners only"), wrap(async (_req, res) => {
  const r = await adminPolicy();
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
  db().clips.unshift(clip);
  audit(req.caller!.username, "clip.uploaded", `${camera}: ${clip.label} (${clip.bytes} bytes ciphertext)`);
  save();
  res.status(201).json({ id: clip.id });
});

app.get("/api/clips", requireAuth(isHousehold, "Not a household member"), (_req, res) => {
  res.json(db().clips.map(({ ciphertext: _c, wrappedKey: _w, iv: _i, ...meta }) => meta));
});

app.get("/api/clips/:id", requireAuth(isHousehold, "Not a household member"), (req, res) => {
  const clip = db().clips.find((c) => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: "No such clip" });
  res.json(clip);
});

// --- household governance ------------------------------------------------------------------------
// Directory so the approvals screen can show names instead of user ids.
app.get("/api/directory", requireAuth(), wrap(async (_req, res) => {
  const ids = realmState().userIds;
  res.json({ users: Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name])), roles: await roleNames() });
}));

// An owner asks for someone to get viewing rights. The server only FILES the change request
// (through TideCloak, as root); it cannot approve it. Owners approve from their own browsers.
app.post("/api/household/request-viewer", requireAuth(isOwner, "Only owners can propose members"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "");
  const out = await fileRealmRoleGrant(username, VIEW_ROLES);
  audit(req.caller!.username, "household.request-viewer", `${username}: ${out.results.map((r) => `${r.role}=${r.status || r.note}`).join(", ")}`);
  save();
  res.json(out);
}));

app.post("/api/household/request-owner", requireAuth(isOwner, "Only owners can propose owners"), wrap(async (req, res) => {
  const username = String(req.body?.username ?? "");
  const out = await fileOwnerGrant(username);
  audit(req.caller!.username, "household.request-owner", `${username}: tide-realm-admin=${out.results[0].status}`);
  save();
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
    audit(req.caller!.username, "household.revoke-viewer.refused", `${username} tried to remove their own access`);
    save();
    return res.status(403).json({ error: "You can't remove your own access. Another owner has to request it." });
  }
  const out = await fileRealmRoleRevoke(username, VIEW_ROLES);
  audit(req.caller!.username, "household.revoke-viewer", `${username}: ${out.results.map((r) => `${r.role}=${r.status || r.note}`).join(", ")}`);
  save();
  res.json(out);
}));

app.get("/api/household/members", requireAuth(isOwner, "Owners only"), wrap(async (_req, res) => {
  res.json(await members(VENDOR_STAFF));
}));

app.get("/api/audit", requireAuth((c) => isHousehold(c) || isVendor(c)), (_req, res) => { res.json(db().audit.slice(0, 50)); });

// --- vendor console (CamCo staff) ----------------------------------------------------------------
// CamCo owns this database, so its console shows the raw rows. That's the honest premise:
// the vendor has full access to storage and to TideCloak's root account.
app.get("/api/vendor/records", requireAuth(isVendor, "CamCo staff only"), (_req, res) => {
  const d = db();
  res.json({ clips: d.clips, vaultPolicy: d.vaultPolicy });
});

app.get("/api/vendor/change-requests", requireAuth(isVendor, "CamCo staff only"), wrap(async (_req, res) => {
  res.json(await listChangeRequests("PENDING"));
}));

// Root tries to give CamCo Support the viewing roles.
app.post("/api/vendor/self-grant", requireAuth(isVendor, "CamCo staff only"), wrap(async (req, res) => {
  const out = await fileRealmRoleGrant(req.caller!.username, VIEW_ROLES);
  audit(req.caller!.username, "vendor.self-grant", `root grants ${out.results.map((r) => `${r.role}=${r.status || r.note}`).join(", ")} to ${req.caller!.username}`);
  save();
  res.json(out);
}));

// Root tries every approval lane TideCloak has. We report exactly what TideCloak answers.
app.post("/api/vendor/cr/:id/force", requireAuth(isVendor, "CamCo staff only"), wrap(async (req, res) => {
  const id = encodeURIComponent(String(req.params.id));
  const attempts = [];
  for (const [lane, path] of [["approve", "approve"], ["authorize", "authorize"], ["commit", "commit"]] as const) {
    const r = await rootCall("POST", `/iga/change-requests/${id}/${path}`, lane === "commit" ? undefined : {});
    attempts.push({ lane, status: r.status, body: r.body });
  }
  const after = (await rootCall("GET", `/iga/change-requests/${id}`)).body;
  audit(req.caller!.username, "vendor.force-approve", attempts.map((a) => `${a.lane}=${a.status}`).join(", "));
  save();
  res.json({ attempts, changeRequest: after });
}));

const PORT = Number(process.env.PORT || 4000);
// Express 5 calls this callback on failure too (e.g. port in use), so check the error.
app.listen(PORT, (err?: Error) => {
  if (err) { console.error(`camera-vault server failed to start: ${err.message}`); process.exit(1); }
  console.log(`camera-vault server on http://localhost:${PORT} (realm ${REALM})`);
});
