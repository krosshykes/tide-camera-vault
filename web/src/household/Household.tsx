import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ClipMeta, type Clip, type Me } from "../lib/api";
import { encryptClip, decryptClip } from "../lib/crypto";
import { vaultPolicy, signVaultPolicy, wrapKey, unwrapKey, explainTideError, VAULT_ROLE } from "../lib/vault";
import { listPending, approveChangeRequest, denyChangeRequest, describe, tally, type ChangeRequest, type Directory } from "../lib/iga";
import { SCENES, snapshot, recordClip, type Scene } from "../camera/scenes";
import { Steps, useSteps, Media, ErrorBox, kb, when } from "../components";

export function Household({ me }: { me: Me }) {
  const [vault, setVault] = useState<{ hasPolicy: boolean; signedBy: string | null } | null>(null);
  const [clips, setClips] = useState<ClipMeta[] | null>(null);
  const [clipsError, setClipsError] = useState<string>("");

  const refreshVault = useCallback(() => api<{ hasPolicy: boolean; signedBy: string | null }>("/api/vault/status").then(setVault), []);
  const refreshClips = useCallback(() => {
    api<ClipMeta[]>("/api/clips").then((c) => { setClips(c); setClipsError(""); })
      .catch((e) => setClipsError(e instanceof ApiError && e.status === 403 ? "forbidden" : String(e.message)));
  }, []);

  useEffect(() => { refreshVault(); refreshClips(); }, [refreshVault, refreshClips]);

  return (
    <div className="grid">
      {!me.isHousehold && <NoAccess me={me} />}
      {me.isOwner && vault && !vault.hasPolicy && <VaultSetup onDone={refreshVault} />}
      {me.isHousehold && vault?.hasPolicy && <CameraSimulator onUploaded={refreshClips} />}
      {me.isHousehold && <Gallery clips={clips} error={clipsError} />}
      {me.isOwner && <Approvals me={me} />}
      {me.isOwner && <Members />}
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

function CameraSimulator({ onUploaded }: { onUploaded: () => void }) {
  const { steps, run } = useSteps();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null);
  const [preview, setPreview] = useState<{ bytes: Uint8Array; mime: string } | null>(null);

  async function capture(scene: Scene, video: boolean) {
    setBusy(true); setErr(null); setPreview(null);
    try {
      await run([
        video ? "Camera records a 3-second clip (synthetic feed)" : "Camera takes a snapshot (synthetic feed)",
        "Encrypt it in this browser with a fresh AES-256-GCM key",
        "Tide network wraps the AES key under the household vault policy",
        "Upload ciphertext + wrapped key to CamCo cloud",
      ], async (step) => {
        const media = video ? await recordClip(scene) : await snapshot(scene);
        setPreview(media);
        step(0, `${kb(media.bytes.length)} ${media.mime}, plaintext stays on this device`);
        const enc = await encryptClip(media.bytes);
        step(1, `${kb(enc.ciphertext.length * 0.75)} of ciphertext`);
        const policy = await vaultPolicy();
        const wrappedKey = await wrapKey(enc.rawKey, policy);
        step(2, "no one, including CamCo, holds a key that can unwrap it");
        await api("/api/clips", { method: "POST", body: JSON.stringify({
          camera: scene.camera, label: scene.label, mime: media.mime, iv: enc.iv, ciphertext: enc.ciphertext, wrappedKey, capturedAt: Date.now(),
        }) });
        step(3, "server stored: ciphertext only");
      });
      onUploaded();
    } catch (e) {
      const x = explainTideError(e);
      setErr({ title: x.refused ? x.summary : `Capture failed: ${e instanceof Error ? e.message : e}`, detail: x.detail });
    } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2>Camera simulator</h2>
      <p className="muted small">Synthetic cameras. Pressing a button creates a motion event, encrypted on this device before upload.</p>
      <div className="scene-list">
        {SCENES.map((s) => (
          <div className="scene" key={s.id}>
            <div><b>{s.camera}</b><div className="muted small">{s.label}</div></div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => capture(s, false)}>Snapshot</button>
              <button className="btn" disabled={busy} onClick={() => capture(s, true)}>3s clip</button>
            </div>
          </div>
        ))}
      </div>
      <Steps steps={steps} />
      {preview && <div className="preview"><span className="tag">camera view, before encryption (never uploaded)</span><Media {...preview} /></div>}
      {err && <ErrorBox {...err} />}
    </section>
  );
}

function Gallery({ clips, error }: { clips: ClipMeta[] | null; error: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Motion events</h2>
      {error === "forbidden" && <p className="muted">The server refused (403): you're not a household member.</p>}
      {error && error !== "forbidden" && <ErrorBox title="Could not load events" detail={error} />}
      {clips && clips.length === 0 && <p className="muted">No events yet. Use the camera simulator.</p>}
      <div className="gallery">
        {clips?.map((c) => (
          <button key={c.id} className={`event ${open === c.id ? "selected" : ""}`} onClick={() => setOpen(c.id)}>
            <div className="thumb locked">
              <span className="lock">🔒</span>
              <span className="tiny">{c.mime.startsWith("video") ? "VIDEO" : "SNAPSHOT"} · {kb(c.bytes)}</span>
            </div>
            <div className="event-meta">
              <b>{c.camera}</b>
              <span className="muted small">{c.label}</span>
              <span className="muted tiny">{when(c.capturedAt)}</span>
            </div>
          </button>
        ))}
      </div>
      {open && <Viewer id={open} key={open} />}
    </section>
  );
}

function Viewer({ id }: { id: string }) {
  const { steps, run } = useSteps();
  const [media, setMedia] = useState<{ bytes: Uint8Array; mime: string } | null>(null);
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null);
  async function play() {
    setErr(null); setMedia(null);
    try {
      await run(["Download ciphertext + wrapped key from CamCo cloud", "Ask the Tide network to unwrap the clip key (it checks your roles against the vault policy)", "Decrypt the clip locally with AES-GCM"], async (step) => {
        const clip = await api<Clip>(`/api/clips/${id}`);
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
  useEffect(() => { void play(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="viewer">
      <Steps steps={steps} />
      {media && <Media {...media} />}
      {err && <ErrorBox {...err} />}
    </div>
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

function Members() {
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);
  async function request(path: string, username: string, what: string) {
    setBusy(true);
    try {
      const r = await api<{ results: { role: string; status: number; note?: string }[] }>(path, { method: "POST", body: JSON.stringify({ username }) });
      setOut(`${what}: ${r.results.map((x) => `${x.role} → ${`HTTP ${x.status}${x.note ? `: ${x.note}` : " (waiting for owner approval)"}`}`).join("; ")}.`);
    } catch (e) { setOut(`${what} failed: ${e instanceof Error ? e.message : e}`); }
    finally { setBusy(false); }
  }
  return (
    <section className="card">
      <h2>Household members</h2>
      <table className="members">
        <tbody>
          <tr><td>Alex, Sam, Riley</td><td><span className="badge ok">owners</span></td><td className="muted small">view footage · approve changes in the Tide enclave (2 of 3 once all are owners)</td></tr>
          <tr><td>Jordan</td><td><span className="badge warn">housemate</span></td><td><button className="btn" disabled={busy} onClick={() => request("/api/household/request-viewer", "jordan", "Request viewing access for Jordan")}>Request viewing access</button></td></tr>
        </tbody>
      </table>
      <details className="setup">
        <summary className="muted small">Setup: make Sam and Riley approvers (one-time)</summary>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => request("/api/household/request-owner", "sam", "Make Sam an owner")}>Make Sam an owner</button>
          <button className="btn" disabled={busy} onClick={() => request("/api/household/request-owner", "riley", "Make Riley an owner")}>Make Riley an owner</button>
        </div>
      </details>
      {out && <p className="small">{out}</p>}
    </section>
  );
}
