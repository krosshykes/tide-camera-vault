import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ClipMeta, type Clip, type Me } from "../lib/api";
import { decryptClip } from "../lib/crypto";
import { vaultPolicy, signVaultPolicy, unwrapKey, explainTideError, VAULT_ROLE } from "../lib/vault";
import { listPending, approveChangeRequest, denyChangeRequest, describe, tally, type ChangeRequest, type Directory } from "../lib/iga";
import { Cameras } from "./Cameras";
import { tenant } from "../lib/tenant";
import {
  listClips, putClip, deleteClips as deleteLocal, markInCloud, localCopyEnabled, setLocalCopyEnabled,
  folderSupported, getFolder, chooseFolder, forgetFolder, folderReady, writeToFolder, type LocalClip,
} from "../lib/localVault";
import { Steps, useSteps, Media, ErrorBox, kb, when } from "../components";

export function Household({ me }: { me: Me }) {
  const [vault, setVault] = useState<{ hasPolicy: boolean; signedBy: string | null } | null>(null);
  const [clips, setClips] = useState<ClipMeta[] | null>(null);
  const [clipsError, setClipsError] = useState<string>("");
  const [version, setVersion] = useState(0); // bumps whenever clips change, so Storage reloads

  const refreshVault = useCallback(() => api<{ hasPolicy: boolean; signedBy: string | null }>("/api/vault/status").then(setVault), []);
  const refreshClips = useCallback(() => {
    setVersion((v) => v + 1);
    api<ClipMeta[]>("/api/clips").then((c) => { setClips(c); setClipsError(""); })
      .catch((e) => setClipsError(e instanceof ApiError && e.status === 403 ? "forbidden" : String(e.message)));
  }, []);

  useEffect(() => { refreshVault(); refreshClips(); }, [refreshVault, refreshClips]);

  return (
    <div className="grid">
      {!me.isHousehold && <NoAccess me={me} />}
      {me.isOwner && vault && !vault.hasPolicy && <VaultSetup onDone={refreshVault} />}
      {me.isHousehold && vault?.hasPolicy && <Cameras me={me} onUploaded={refreshClips} />}
      {me.isHousehold && <Gallery me={me} clips={clips} error={clipsError} onChanged={refreshClips} />}
      {me.isHousehold && <StoragePanel me={me} version={version} />}
      {me.isHousehold && <HouseholdCopy clips={clips} onChanged={refreshClips} />}
      {me.isOwner && <Approvals me={me} />}
      {me.isOwner && <Members me={me} />}
      {me.isHousehold && <Notices />}
      {vault?.hasPolicy && (
        <p className="muted small span-all">
          Vault policy <code>RelationshipAttestation:1</code> (subject: role <code>{VAULT_ROLE}</code>) signed by {vault.signedBy} in the Tide enclave.
        </p>
      )}
    </div>
  );
}

function NoAccess({ me }: { me: Me }) {
  return (
    <section className="card span-all warn-card">
      <h2>You can't view this household's cameras yet</h2>
      <p>Signed in as <b>{me.username}</b>. You don't hold <code>{VAULT_ROLE}</code> + <code>_tide_decryptor</code>, so the Tide network won't release any clip key to you, whatever this app or its server says.</p>
      <p>Only the household's owners can give you access, and only once enough of them approve it in the Tide enclave. Ask an owner to request it, then sign out and back in once it's approved.</p>
    </section>
  );
}

function VaultSetup({ onDone }: { onDone: () => void }) {
  const { steps, run } = useSteps();
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null);
  async function go() {
    setErr(null);
    try {
      await run(["Fetch the realm's admin policy", "Build a vault policy: role household-viewer may read + write record household-vault", "Approve it in the Tide enclave and have the network sign it", "Store the signed policy (it's public; it holds no key)"], async (step) => {
        step(0); step(1);
        await signVaultPolicy();
        step(2); step(3);
      });
      onDone();
    } catch (e) {
      const x = explainTideError(e);
      setErr({ title: x.summary, detail: x.detail });
    }
  }
  return (
    <section className="card span-all accent-card">
      <h2>One-time: create the household vault</h2>
      <p>As an owner, you approve <b>one policy</b> in the Tide enclave: <i>anyone holding <code>{VAULT_ROLE}</code> may open this household's footage keys.</i> The Tide network then enforces it on every decrypt. After that, adding a member means granting the role, and that needs a quorum of owners.</p>
      <button className="btn primary" onClick={go}>Create vault (opens Tide approval)</button>
      <Steps steps={steps} />
      {err && <ErrorBox {...err} />}
    </section>
  );
}

// Owners can delete any clip; other members only their own. The server enforces the same rule.
const canDelete = (me: Me, c: ClipMeta) => me.isOwner || c.uploadedBy === me.username;

async function deleteClips(ids: string[]) {
  const r = await api<{ deleted: string[]; refused: string[] }>("/api/clips/delete", { method: "POST", body: JSON.stringify({ ids }) });
  // A household deletion removes this device's copy too (other devices follow the tombstone).
  await deleteLocal(r.deleted).catch(() => {});
  return r;
}

function Gallery({ me, clips, error, onChanged }: { me: Me; clips: ClipMeta[] | null; error: string; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [camera, setCamera] = useState("all");
  const [kind, setKind] = useState<"all" | "video" | "snapshot">("all");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const cameras = [...new Set((clips ?? []).map((c) => c.camera))].sort();
  const shown = (clips ?? []).filter((c) =>
    (camera === "all" || c.camera === camera) &&
    (kind === "all" || (kind === "video") === c.mime.startsWith("video/")));
  const deletable = shown.filter((c) => canDelete(me, c));

  function toggle(id: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  async function removePicked() {
    const ids = [...picked];
    if (!ids.length || !window.confirm(`Delete ${ids.length} clip${ids.length === 1 ? "" : "s"} permanently? This can't be undone.`)) return;
    setBusy(true);
    try {
      const r = await deleteClips(ids);
      setMsg(`Deleted ${r.deleted.length}${r.refused.length ? `; ${r.refused.length} not yours to delete` : ""}.`);
      setPicked(new Set()); setSelecting(false);
      if (open && r.deleted.includes(open)) setOpen(null);
      onChanged();
    } catch (e) { setMsg(`Delete failed: ${e instanceof Error ? e.message : e}`); }
    finally { setBusy(false); }
  }

  const openClip = clips?.find((c) => c.id === open) ?? null;

  return (
    <section className="card">
      <div className="row spread">
        <h2>Motion events</h2>
        {clips && clips.length > 0 && (
          <button className="btn ghost" onClick={() => { setSelecting((s) => !s); setPicked(new Set()); }}>{selecting ? "Cancel" : "Select"}</button>
        )}
      </div>
      {error === "forbidden" && <p className="muted">The server refused (403): you're not a household member.</p>}
      {error && error !== "forbidden" && <ErrorBox title="Could not load events" detail={error} />}
      {clips && clips.length === 0 && <p className="muted">No events yet. Start a camera above and take a snapshot, or turn on motion detection.</p>}
      {clips && clips.length > 0 && (
        <div className="row filters">
          <select className="select" value={camera} onChange={(e) => setCamera(e.target.value)}>
            <option value="all">All cameras</option>
            {cameras.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">Snapshots and videos</option>
            <option value="video">Videos only</option>
            <option value="snapshot">Snapshots only</option>
          </select>
          <span className="muted tiny">{shown.length} of {clips.length}</span>
        </div>
      )}
      {selecting && (
        <div className="row select-bar">
          <button className="btn ghost" onClick={() => setPicked(new Set(deletable.map((c) => c.id)))}>Select all{deletable.length < shown.length ? " mine" : ""} ({deletable.length})</button>
          <button className="btn danger" disabled={busy || picked.size === 0} onClick={removePicked}>Delete selected ({picked.size})</button>
        </div>
      )}
      <div className="gallery">
        {shown.map((c) => {
          const sel = picked.has(c.id);
          const may = canDelete(me, c);
          return (
            <button key={c.id} className={`event ${open === c.id && !selecting ? "selected" : ""} ${sel ? "picked" : ""}`}
              disabled={selecting && !may} title={selecting && !may ? "Only owners or the uploader can delete this" : undefined}
              onClick={() => (selecting ? toggle(c.id) : setOpen(c.id))}>
              <div className="thumb locked">
                {selecting && <span className="pick">{sel ? "☑" : "☐"}</span>}
                <span className="lock">🔒</span>
                <span className="tiny">{c.mime.startsWith("video") ? "VIDEO" : "SNAPSHOT"} · {kb(c.bytes)}</span>
              </div>
              <div className="event-meta">
                <b>{c.camera}</b>
                <span className="muted small">{c.label}</span>
                <span className="muted tiny">{when(c.capturedAt)} · {c.uploadedBy}</span>
              </div>
            </button>
          );
        })}
      </div>
      {msg && <p className="small">{msg}</p>}
      {openClip && !selecting && (
        <Viewer key={openClip.id} clip={openClip} canDelete={canDelete(me, openClip)}
          onDeleted={() => { setOpen(null); setMsg("Clip deleted."); onChanged(); }} />
      )}
    </section>
  );
}

// `local`: play the household's own copy instead of CamCo's (e.g. CamCo no longer has it).
function Viewer({ clip: meta, canDelete, onDeleted, local }: { clip: ClipMeta; canDelete: boolean; onDeleted: () => void; local?: LocalClip }) {
  const { steps, run } = useSteps();
  const [media, setMedia] = useState<{ bytes: Uint8Array; mime: string } | null>(null);
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null);
  // One object URL per decrypted clip, released when it changes or the viewer closes.
  const [saveUrl, setSaveUrl] = useState("");
  useEffect(() => {
    if (!media) return;
    const u = URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.mime }));
    setSaveUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [media]);
  async function play() {
    setErr(null); setMedia(null);
    try {
      await run([local ? "Read the household's own encrypted copy (not CamCo's)" : "Download ciphertext + wrapped key from CamCo cloud", "Ask the Tide network to unwrap the clip key (it checks your roles against the vault policy)", "Decrypt the clip locally with AES-GCM"], async (step) => {
        const clip: Clip = local ?? await api<Clip>(`/api/clips/${meta.id}`);
        step(0, kb(clip.bytes));
        const rawKey = await unwrapKey(clip.wrappedKey, await vaultPolicy());
        step(1, "policy check passed on the Tide network");
        const bytes = await decryptClip(clip.ciphertext, clip.iv, rawKey);
        step(2, "plaintext exists only in this browser tab");
        setMedia({ bytes, mime: clip.mime });
      });
    } catch (e) {
      const x = explainTideError(e);
      setErr({ title: x.summary, detail: x.detail });
    }
  }
  async function remove() {
    if (!window.confirm(`Delete this ${meta.mime.startsWith("video") ? "video" : "snapshot"} from ${meta.camera} permanently?`)) return;
    try {
      const r = await deleteClips([meta.id]);
      if (r.deleted.includes(meta.id)) onDeleted();
      else setErr({ title: "Not deleted: only owners or the person who recorded it can delete it." });
    } catch (e) { setErr({ title: `Delete failed: ${e instanceof Error ? e.message : e}` }); }
  }
  useEffect(() => { void play(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="viewer">
      <div className="row spread">
        <span className="small"><b>{meta.camera}</b> · {meta.label} · <span className="muted">{when(meta.capturedAt)} by {meta.uploadedBy}</span></span>
        {canDelete && <button className="btn danger" onClick={remove}>Delete</button>}
      </div>
      <Steps steps={steps} />
      {media && <Media {...media} />}
      {media && saveUrl && (
        <a className="btn ghost" download={`${meta.camera}-${new Date(meta.capturedAt).toISOString().replace(/[:.]/g, "-")}.${meta.mime.startsWith("video") ? "webm" : meta.mime.includes("png") ? "png" : "jpg"}`}
          href={saveUrl} title="A saved copy is no longer protected by the vault">Save decrypted copy</a>
      )}
      {err && <ErrorBox {...err} />}
    </div>
  );
}

interface Storage {
  quotaBytes: number; usedBytes: number; clips: number; snapshots: number; videos: number;
  oldest: number | null; newest: number | null; retentionDays: number | null; retentionChoices: number[];
  perCamera: { camera: string; clips: number; bytes: number; snapshots: number; videos: number; newest: number }[];
}

const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : kb(b));

function StoragePanel({ me, version }: { me: Me; version: number }) {
  const [s, setS] = useState<Storage | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api<Storage>("/api/storage").then(setS).catch((e) => setMsg(String(e.message ?? e))), []);
  useEffect(() => { void load(); }, [load, version]);

  async function setRetention(v: string) {
    const days = v === "" ? null : Number(v);
    if (days && !window.confirm(`Automatically delete clips older than ${days} days, starting now?`)) return;
    try {
      const r = await api<{ retentionDays: number | null; pruned: number }>("/api/storage/retention", { method: "PUT", body: JSON.stringify({ days }) });
      setMsg(r.pruned ? `Retention updated. ${r.pruned} older clip(s) deleted.` : "Retention updated.");
      void load();
    } catch (e) { setMsg(`Could not change retention: ${e instanceof Error ? e.message : e}`); }
  }

  if (!s) return <section className="card"><h2>Storage</h2><p className="muted">{msg || "Loading…"}</p></section>;
  const pct = Math.min(100, (s.usedBytes / s.quotaBytes) * 100);
  return (
    <section className="card">
      <h2>Storage</h2>
      <div className="usage">
        <div className="row spread small"><b>{size(s.usedBytes)} used</b><span className="muted">of {size(s.quotaBytes)}</span></div>
        <div className="meter"><div className={`meter-fill ${pct > 90 ? "hot" : ""}`} style={{ width: `${Math.max(pct, s.usedBytes ? 1 : 0)}%` }} /></div>
        <div className="muted tiny">
          {s.clips} clip{s.clips === 1 ? "" : "s"} ({s.snapshots} snapshot{s.snapshots === 1 ? "" : "s"}, {s.videos} video{s.videos === 1 ? "" : "s"})
          {s.oldest && ` · oldest ${when(s.oldest)}`}
        </div>
      </div>
      {s.perCamera.length > 0 && (
        <table className="raw">
          <thead><tr><th>camera</th><th>clips</th><th>stored</th><th>latest</th></tr></thead>
          <tbody>
            {s.perCamera.map((c) => (
              <tr key={c.camera}><td>{c.camera}</td><td>{c.clips}<span className="muted tiny"> ({c.videos} video)</span></td><td>{size(c.bytes)}</td><td className="tiny">{when(c.newest)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <label className="small retention">Keep clips
        <select className="select" value={s.retentionDays ?? ""} disabled={!me.isOwner} onChange={(e) => void setRetention(e.target.value)}>
          <option value="">until someone deletes them</option>
          {s.retentionChoices.map((d) => <option key={d} value={d}>for {d} days</option>)}
        </select>
      </label>
      {!me.isOwner && <span className="muted tiny">Only owners can change retention.</span>}
      <p className="muted tiny">Sizes are of the encrypted copies CamCo stores. CamCo can delete ciphertext (to enforce your retention rule) but never open it.</p>
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

function Approvals({ me }: { me: Me }) {
  const [crs, setCrs] = useState<ChangeRequest[] | null>(null);
  const [dir, setDir] = useState<Directory>({ users: {}, roles: {} });
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, d] = await Promise.all([listPending(), api<Directory>("/api/directory")]);
      setCrs(list); setDir(d); setErr("");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  async function approve(cr: ChangeRequest) {
    setBusy(cr.id);
    try {
      const r = await approveChangeRequest(cr.id);
      setMsg((m) => ({ ...m, [cr.id]: r.cancelled ? "You closed the Tide approval without signing." : r.committed ? "Quorum reached: change applied." : "Your approval is recorded. Waiting for another owner." }));
    } catch (e) {
      setMsg((m) => ({ ...m, [cr.id]: `Approval failed: ${e instanceof Error ? e.message : e}` }));
    } finally { setBusy(null); void load(); }
  }
  async function deny(cr: ChangeRequest) {
    setBusy(cr.id);
    try { await denyChangeRequest(cr.id); } catch (e) { setMsg((m) => ({ ...m, [cr.id]: `Deny failed: ${e instanceof Error ? e.message : e}` })); }
    finally { setBusy(null); void load(); }
  }

  return (
    <section className="card span-all">
      <h2>Pending household approvals</h2>
      <p className="muted small">Every change to who can see your cameras lands here: from an owner, from the CamCo cloud, even from CamCo's root admin. It takes effect only once enough owners sign it in the Tide enclave.</p>
      {err && <ErrorBox title="Could not load change requests from TideCloak" detail={err} />}
      {crs && crs.length === 0 && <p className="muted">Nothing pending.</p>}
      <div className="cr-list">
        {crs?.map((cr) => {
          const t = tally(cr);
          const signedByMe = cr.authorizers?.some((a) => a.username === me.username);
          const fromVendor = dir.users[cr.entityId] === "camco-support";
          return (
            <div key={cr.id} className={`cr ${fromVendor ? "cr-vendor" : ""}`}>
              <div className="cr-main">
                <div className="cr-title">{describe(cr, dir)}</div>
                <div className="muted tiny">{cr.actionType} · {cr.id.slice(0, 8)} · requested by {cr.requestedBy ?? "?"}{cr.createdAt ? ` · ${when(cr.createdAt)}` : ""}</div>
                {fromVendor && <div className="badge vendor">CamCo is asking to watch your cameras</div>}
                <div className="tally">
                  <span className="pill">Pending household approval: {t.have ?? "?"} of {t.need}</span>
                  {cr.authorizers?.length ? <span className="muted tiny">signed: {cr.authorizers.map((a) => a.username).join(", ")}</span> : null}
                </div>
                {msg[cr.id] && <div className="small">{msg[cr.id]}</div>}
              </div>
              <div className="row">
                {/* Quorum met but not applied (an auto-commit that didn't run): approving again as a
                    signer re-runs TideCloak's commit gates instead of asking for a new signature. */}
                {signedByMe && cr.readyToCommit
                  ? <button className="btn primary" disabled={busy === cr.id} onClick={() => approve(cr)}>Apply now (quorum reached)</button>
                  : <button className="btn primary" disabled={busy === cr.id || signedByMe} onClick={() => approve(cr)}>{signedByMe ? "You approved" : "Approve"}</button>}
                <button className="btn danger" disabled={busy === cr.id} onClick={() => deny(cr)}>Deny</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface Member { username: string; linked: boolean; viewer: boolean; owner: boolean; pending: string[] }

const PENDING_TEXT: Record<string, string> = {
  GRANT_ROLES: "grant pending approval",
  REVOKE_ROLES: "removal pending approval",
  DELETE_USER: "deletion pending approval",
  CREATE_USER: "creation pending approval",
};

/** Who can see the cameras right now, as TideCloak records it, with the actions owners can file. */
function Members({ me }: { me: Me }) {
  const [list, setList] = useState<Member[] | null>(null);
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try { setList(await api<Member[]>("/api/household/members")); setErr(""); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  async function request(path: string, username: string, what: string) {
    if (path.endsWith("revoke-viewer") && !window.confirm(`File a request to remove ${username}'s access to the cameras? It applies only once enough owners approve it.`)) return;
    setBusy(true);
    try {
      const r = await api<{ results: { role: string; status: number; note?: string }[] }>(path, { method: "POST", body: JSON.stringify({ username }) });
      setOut(`${what}: ${r.results.map((x) => `${x.role} → ${x.note ?? `HTTP ${x.status}, waiting for owner approval`}`).join("; ")}.`);
    } catch (e) { setOut(`${what} failed: ${e instanceof Error ? e.message : e}`); }
    finally { setBusy(false); void load(); }
  }

  const name = (u: string) => u.charAt(0).toUpperCase() + u.slice(1);

  // Adding a person files CREATE_USER. Once owners approve it they appear in the list without a
  // Tide account, and an owner fetches their invite link to send them.
  const [invite, setInvite] = useState({ username: "", name: "" });
  const [link, setLink] = useState<{ username: string; link: string } | null>(null);
  async function addPerson(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ status: number }>("/api/household/invite", { method: "POST", body: JSON.stringify(invite) });
      setOut(`Add ${invite.name || invite.username}: HTTP ${r.status}, waiting for owner approval. Once it's approved, fetch their invite link here.`);
      setInvite({ username: "", name: "" });
    } catch (e) { setOut(`Add person failed: ${e instanceof Error ? e.message : e}`); }
    finally { setBusy(false); void load(); }
  }
  async function getLink(username: string) {
    setBusy(true);
    try { setLink({ username, link: (await api<{ link: string }>("/api/household/invite-link", { method: "POST", body: JSON.stringify({ username }) })).link }); }
    catch (e) { setOut(`Invite link failed: ${e instanceof Error ? e.message : e}`); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2>Household members</h2>
      <p className="muted small">Adding or removing anyone, or making them an owner, files a request. Nothing changes until enough owners approve it in the Tide enclave.</p>
      {err && <ErrorBox title="Could not load members" detail={err} />}
      <table className="members">
        <tbody>
          {list?.map((m) => {
            const pending = m.pending.length > 0;
            return (
              <tr key={m.username}>
                <td>
                  <b>{name(m.username)}</b>{m.username === me.username && <span className="muted tiny"> (you)</span>}
                  {!m.linked && <div className="muted tiny">no Tide account yet</div>}
                </td>
                <td>
                  {m.owner && <span className="badge ok">owner</span>}
                  {m.viewer && !m.owner && <span className="badge ok">can view</span>}
                  {!m.viewer && <span className="badge warn">no access</span>}
                  {pending && <div className="muted tiny">{m.pending.map((p) => PENDING_TEXT[p] ?? `${p} pending`).join(", ")}</div>}
                </td>
                <td>
                  <div className="row">
                    {!m.linked && <button className="btn primary" disabled={busy} onClick={() => getLink(m.username)}>Get invite link</button>}
                    {!m.viewer && <button className="btn" disabled={busy || pending} onClick={() => request("/api/household/request-viewer", m.username, `Give ${name(m.username)} access`)}>Request viewing access</button>}
                    {/* No self-removal: the server refuses it too (403); this just doesn't offer it. */}
                    {m.viewer && m.username !== me.username && <button className="btn danger" disabled={busy || pending} onClick={() => request("/api/household/revoke-viewer", m.username, `Remove ${name(m.username)}'s access`)}>Remove access</button>}
                    {m.viewer && m.username === me.username && <span className="muted tiny">another owner must remove you</span>}
                    {m.viewer && !m.owner && m.linked && <button className="btn ghost" disabled={busy || pending} onClick={() => request("/api/household/request-owner", m.username, `Make ${name(m.username)} an owner`)}>Make owner</button>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {link && (
        <div className="invite-link">
          <b className="small">Invite link for {name(link.username)} (valid 12 hours)</b>
          <code>{link.link}</code>
          <div className="row">
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(link.link)}>Copy</button>
            <button className="btn ghost" onClick={() => setLink(null)}>Done</button>
          </div>
          <span className="muted tiny">Send it to them privately. They open it and create their own Tide account; nobody else ever sees their password.</span>
        </div>
      )}
      <form className="invite-form" onSubmit={addPerson}>
        <input placeholder="Name, e.g. Jordan" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
        <input required placeholder="username, e.g. jordan" pattern="[a-z][a-z0-9._\-]{1,29}" title="2-30 characters: letters, numbers, . _ -"
          value={invite.username} onChange={(e) => setInvite({ ...invite, username: e.target.value.toLowerCase() })} />
        <button className="btn" disabled={busy}>Add a person</button>
      </form>
      <p className="muted tiny">New people start with no access. Removal takes effect at that person's next sign-in, or within about 10 minutes when their login refreshes. Anything they already saved from the screen can't be clawed back.</p>
      {out && <p className="small">{out}</p>}
    </section>
  );
}

interface Notice { at: number; who: string; what: string; detail: string }

/** What CamCo did that touched this household, and any legal requests about it. */
function Notices() {
  const [list, setList] = useState<Notice[] | null>(null);
  useEffect(() => {
    const load = () => api<Notice[]>("/api/household/notices").then(setList).catch(() => setList([]));
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="card span-all">
      <h2>CamCo activity on your household</h2>
      <p className="muted small">Every time CamCo touches your household (asking for access, trying to force an approval, issuing a setup link, receiving a legal request), it shows up here.</p>
      {list && list.length === 0 && <p className="muted">Nothing yet.</p>}
      <div className="cr-list">
        {list?.map((n, i) => (
          <div key={i} className="notice">
            <div className="row spread"><b className="small">{n.what.startsWith("legal-request") ? "⚖️ Legal request" : "CamCo"} · {n.who}</b><span className="muted tiny">{when(n.at)}</span></div>
            <span className="small">{n.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface Tombstone { id: string; at: number; by: string; reason: string }

/**
 * The household's own copy of its footage, and the check that CamCo still holds everything.
 * A clip this device has but CamCo's cloud doesn't, with no household deletion recorded, was lost
 * or deleted on CamCo's side: it's flagged, can be played from the household copy, and restored.
 */
function HouseholdCopy({ clips, onChanged }: { clips: ClipMeta[] | null; onChanged: () => void }) {
  const hh = tenant().info.id;
  const [local, setLocal] = useState<LocalClip[] | null>(null);
  const [tombs, setTombs] = useState<Map<string, Tombstone>>(new Map());
  const [enabled, setEnabled] = useState(() => localCopyEnabled(hh));
  const [folder, setFolder] = useState<{ name: string; ready: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [view, setView] = useState<LocalClip | null>(null);

  const load = useCallback(async () => {
    try {
      const [mine, t] = await Promise.all([listClips(hh), api<Tombstone[]>("/api/clips/tombstones")]);
      const tmap = new Map(t.map((x) => [x.id, x]));
      // The household deleted these (perhaps on another device): honour it here too.
      const deleted = mine.filter((c) => tmap.has(c.id)).map((c) => c.id);
      if (deleted.length) await deleteLocal(deleted);
      setTombs(tmap);
      setLocal(mine.filter((c) => !tmap.has(c.id)));
      const h = await getFolder(hh);
      setFolder(h ? { name: h.name, ready: await folderReady(h, false) } : null);
    } catch (e) { setMsg(`Household copy unavailable: ${e instanceof Error ? e.message : e}`); }
  }, [hh]);
  useEffect(() => { void load(); }, [load, clips]);

  const cloud = new Set((clips ?? []).map((c) => c.id));
  const known = clips !== null && local !== null;
  const missing = known ? local!.filter((c) => !cloud.has(c.id)) : [];
  const notLocal = known ? clips!.filter((c) => !local!.some((l) => l.id === c.id)) : [];
  const localBytes = (local ?? []).reduce((n, c) => n + c.bytes, 0);

  async function restore(list: LocalClip[]) {
    setBusy("restore"); setMsg("");
    let ok = 0, failed = 0;
    for (const c of list) {
      try {
        await api("/api/clips", { method: "POST", body: JSON.stringify({
          id: c.id, cameraId: c.cameraId, camera: c.camera, label: c.label, mime: c.mime, iv: c.iv, ciphertext: c.ciphertext,
          wrappedKey: c.wrappedKey, capturedAt: c.capturedAt, restore: true,
        }) });
        await markInCloud(c.id, true); ok++;
      } catch { failed++; }
    }
    setMsg(`Restored ${ok} clip${ok === 1 ? "" : "s"} to CamCo's cloud${failed ? `; ${failed} failed` : ""}.`);
    setBusy(""); onChanged(); void load();
  }

  async function backUpExisting() {
    setBusy("backup"); setMsg("");
    const h = await getFolder(hh).catch(() => undefined);
    const toFolder = h ? await folderReady(h, true) : false;
    let n = 0;
    for (const m of notLocal) {
      try {
        const c = await api<Clip>(`/api/clips/${m.id}`);
        const rec: LocalClip = { ...c, household: hh, savedAt: Date.now(), inCloud: true };
        await putClip(rec);
        if (h && toFolder) await writeToFolder(h, rec);
        n++;
      } catch { /* keep going */ }
    }
    setMsg(`Copied ${n} clip${n === 1 ? "" : "s"} from CamCo's cloud to this device${h && toFolder ? " and the backup folder" : ""}.`);
    setBusy(""); void load();
  }

  async function pickFolder() {
    setMsg("");
    try {
      const h = await chooseFolder(hh);
      setBusy("folder");
      const all = await listClips(hh);
      for (const c of all) await writeToFolder(h, c);
      setMsg(`Backup folder set to "${h.name}". ${all.length} encrypted clip file${all.length === 1 ? "" : "s"} written; new clips are added automatically.`);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setMsg(`Could not use that folder: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(""); void load(); }
  }

  async function regrant() {
    const h = await getFolder(hh);
    if (h && (await folderReady(h, true))) setMsg("Backup folder permission granted again.");
    void load();
  }

  function toggle(on: boolean) {
    setLocalCopyEnabled(hh, on);
    setEnabled(on);
  }

  return (
    <section className="card span-all">
      <div className="row spread">
        <h2>Household copy</h2>
        <label className="row small"><input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} /> Keep encrypted copies on this device</label>
      </div>
      <p className="muted small">CamCo's cloud shouldn't be the only copy of your footage. This device keeps its own encrypted copy of every clip it records (still unreadable without your household's Tide-governed key), and checks that CamCo still holds everything.</p>

      {known && missing.length > 0 && (
        <div className="big-status bad">
          ⚠ {missing.length} clip{missing.length === 1 ? " is" : "s are"} missing from CamCo's cloud: not deleted by your household
          <div className="tiny">No deletion by your household is recorded. Your household copy is intact.</div>
          <div className="cr-list">
            {missing.map((c) => (
              <div key={c.id} className="row spread missing-row">
                <span className="small"><b>{c.camera}</b> · {c.label} · {when(c.capturedAt)} · <i>{c.inCloud ? "CamCo removed or lost its copy" : "its upload never finished"}</i></span>
                <button className="btn ghost" onClick={() => setView(c)}>View household copy</button>
              </div>
            ))}
          </div>
          <button className="btn primary" disabled={!!busy} onClick={() => restore(missing)}>{busy === "restore" ? "Restoring…" : `Restore ${missing.length} to CamCo's cloud`}</button>
        </div>
      )}
      {known && missing.length === 0 && local!.length > 0 && <div className="big-status ok">✓ CamCo's cloud holds every clip this device has a copy of.</div>}

      <div className="tiles">
        <div className="tile"><span className="tile-label">On this device</span><b>{local?.length ?? "…"} clips</b><span className="tiny muted">{(localBytes / 1024 / 1024).toFixed(1)} MB encrypted</span></div>
        <div className="tile"><span className="tile-label">Not yet copied here</span><b>{known ? notLocal.length : "…"}</b><span className="tiny muted">older, or from other devices</span></div>
        <div className={`tile ${folder && !folder.ready ? "bad" : ""}`}><span className="tile-label">Backup folder</span><b>{folder ? folder.name : "none"}</b><span className="tiny muted">{folder ? (folder.ready ? "new clips written automatically" : "needs permission again") : folderSupported() ? "USB drive or NAS share" : "needs Chrome or Edge"}</span></div>
        <div className="tile"><span className="tile-label">Deleted by household</span><b>{tombs.size}</b><span className="tiny muted">recorded deletions</span></div>
      </div>

      <div className="row copy-actions">
        <button className="btn" disabled={!!busy || !known || notLocal.length === 0} onClick={backUpExisting}>{busy === "backup" ? "Copying…" : `Copy ${notLocal.length} cloud clip${notLocal.length === 1 ? "" : "s"} to this device`}</button>
        {folderSupported() && <button className="btn" disabled={!!busy} onClick={pickFolder}>{folder ? "Change backup folder" : "Choose backup folder…"}</button>}
        {folder && !folder.ready && <button className="btn primary" onClick={regrant}>Allow folder access</button>}
        {folder && <button className="btn ghost" onClick={async () => { await forgetFolder(hh); void load(); }}>Stop using folder</button>}
      </div>
      <p className="muted tiny">Deleting a clip in Motion events deletes it everywhere: CamCo's cloud, this device, and other members' devices next time they open the app. Files already in a backup folder are left for you to manage.</p>
      {msg && <p className="small">{msg}</p>}
      {view && <Viewer key={view.id} clip={view} local={view} canDelete={false} onDeleted={() => {}} />}
    </section>
  );
}
