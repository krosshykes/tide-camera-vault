import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ClipMeta, type Clip, type Me } from "../lib/api";
import { encryptClip, decryptClip } from "../lib/crypto";
import { vaultPolicy, signVaultPolicy, wrapKey, unwrapKey, explainTideError, VAULT_ROLE } from "../lib/vault";
import { listPending, approveChangeRequest, denyChangeRequest, describe, tally, type ChangeRequest, type Directory } from "../lib/iga";
import { SCENES, snapshot, recordClip, type Scene } from "../camera/scenes";
import { listCameras, openCamera, liveSnapshot, liveClip } from "../camera/live";
import { watchMotion, thresholdFor, type MotionState } from "../camera/motion";
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
      {me.isOwner && <Members me={me} />}
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

interface Source {
  camera: string;
  label: string;
  live: boolean;
  first?: string; // overrides the first step label (motion clips are already recorded)
  produce: (video: boolean) => Promise<{ bytes: Uint8Array; mime: string }>;
}

function CameraSimulator({ onUploaded }: { onUploaded: () => void }) {
  const { steps, run } = useSteps();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null);
  const [preview, setPreview] = useState<{ bytes: Uint8Array; mime: string } | null>(null);

  // One pipeline for every source: the synthetic scenes and a real camera are treated identically.
  async function capture(src: Source, video: boolean) {
    setBusy(true); setErr(null); setPreview(null);
    const what = src.live ? "real camera" : "synthetic feed";
    try {
      await run([
        src.first ?? (video ? `Camera records a 3-second clip (${what})` : `Camera takes a snapshot (${what})`),
        "Encrypt it in this browser with a fresh AES-256-GCM key",
        "Tide network wraps the AES key under the household vault policy",
        "Upload ciphertext + wrapped key to CamCo cloud",
      ], async (step) => {
        const media = await src.produce(video);
        setPreview(media);
        step(0, `${kb(media.bytes.length)} ${media.mime}, plaintext stays on this device`);
        const enc = await encryptClip(media.bytes);
        step(1, `${kb(enc.ciphertext.length * 0.75)} of ciphertext`);
        const policy = await vaultPolicy();
        const wrappedKey = await wrapKey(enc.rawKey, policy);
        step(2, "no one, including CamCo, holds a key that can unwrap it");
        await api("/api/clips", { method: "POST", body: JSON.stringify({
          camera: src.camera, label: src.label, mime: media.mime, iv: enc.iv, ciphertext: enc.ciphertext, wrappedKey, capturedAt: Date.now(),
        }) });
        step(3, "server stored: ciphertext only");
      });
      onUploaded();
    } catch (e) {
      const x = explainTideError(e);
      setErr({ title: x.refused ? x.summary : `Capture failed: ${e instanceof Error ? e.message : e}`, detail: x.detail });
    } finally { setBusy(false); }
  }

  const sceneSource = (sc: Scene): Source => ({ camera: sc.camera, label: sc.label, live: false, produce: (v) => (v ? recordClip(sc) : snapshot(sc)) });

  return (
    <section className="card">
      <h2>Cameras</h2>
      <LiveCamera busy={busy} onCapture={capture} />
      {/* Progress sits right under the cameras, so a capture visibly does something. */}
      <Steps steps={steps} />
      {err && <ErrorBox {...err} />}
      {preview && <div className="preview"><span className="tag">camera view, before encryption (never uploaded)</span><Media {...preview} /></div>}
      <p className="muted small">Synthetic cameras. Each button creates a motion event, encrypted on this device before upload.</p>
      <div className="scene-list">
        {SCENES.map((sc) => (
          <div className="scene" key={sc.id}>
            <div><b>{sc.camera}</b><div className="muted small">{sc.label}</div></div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => capture(sceneSource(sc), false)}>Snapshot</button>
              <button className="btn" disabled={busy} onClick={() => capture(sceneSource(sc), true)}>3s clip</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Optional real camera: the DroidCam virtual webcam, a laptop webcam, any videoinput device. */
function LiveCamera({ busy, onCapture }: { busy: boolean; onCapture: (src: Source, video: boolean) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [on, setOn] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [gen, setGen] = useState(0); // bumps on every new stream so the attach effect re-runs

  const stopTracks = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  useEffect(() => stopTracks, []);

  // Attach the stream once the <video> exists, start playback explicitly, then confirm frames arrive.
  useEffect(() => {
    const el = videoRef.current;
    const s = streamRef.current;
    if (!on || !el || !s) return;
    el.srcObject = s;
    el.play().catch((e) => setErr(`Video playback failed: ${e instanceof Error ? e.message : e}`));
    setStatus("waiting for picture…");
    const t = setTimeout(() => {
      const track = s.getVideoTracks()[0];
      if (el.videoWidth > 0) setStatus(`receiving frames ${el.videoWidth}×${el.videoHeight} from "${track?.label ?? "camera"}"`);
      else setStatus(`no picture from "${track?.label ?? "camera"}" (track ${track?.readyState ?? "?"}${track?.muted ? ", muted" : ""}). Is the DroidCam client connected and showing the phone's video?`);
    }, 2000);
    return () => clearTimeout(t);
  }, [on, gen]);

  async function start(id?: string) {
    setErr(""); setStatus("opening camera…");
    try {
      stopTracks();
      let s = await openCamera(id);
      // Labels are only readable after permission is granted. Prefer DroidCam when it is there.
      const cams = await listCameras();
      setDevices(cams);
      let active = s.getVideoTracks()[0]?.getSettings().deviceId ?? "";
      const droid = cams.find((d) => /droidcam/i.test(d.label));
      if (!id && droid && droid.deviceId !== active) {
        s.getTracks().forEach((t) => t.stop());
        s = await openCamera(droid.deviceId);
        active = droid.deviceId;
      }
      streamRef.current = s;
      setDeviceId(active);
      setOn(true);
      setGen((g) => g + 1);
    } catch (e) {
      setOn(false); setStatus("");
      setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }
  function stop() { stopTracks(); setOn(false); setStatus(""); }

  const label = devices.find((d) => d.deviceId === deviceId)?.label || "Live camera";
  const name = /droidcam/i.test(label) ? "Phone cam" : "Live cam";
  const src: Source = {
    camera: name, label: "Live capture", live: true,
    produce: async (v) => {
      const el = videoRef.current;
      if (!el || !streamRef.current) throw new Error("Start the camera first.");
      if (el.videoWidth === 0) throw new Error(`The camera "${label}" is not sending a picture yet, so there is nothing to capture.`);
      return v ? liveClip(el, name) : liveSnapshot(el, name);
    },
  };

  return (
    <div className="live-cam">
      <div className="row spread">
        <div><b>Live camera</b> <span className="muted small">(optional: DroidCam or a webcam)</span></div>
        {!on
          ? <button className="btn" onClick={() => start()}>Start camera</button>
          : <button className="btn ghost" onClick={stop}>Stop</button>}
      </div>
      {on && (
        <>
          <label className="muted tiny">Camera:{" "}
            <select className="select" value={deviceId} onChange={(e) => void start(e.target.value)}>
              {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `camera ${i + 1}`}</option>)}
            </select>
          </label>
          <video ref={videoRef} className="media live-preview" autoPlay muted playsInline />
          {status && <div className="muted tiny">{status}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void onCapture(src, false)}>Snapshot</button>
            <button className="btn primary" disabled={busy} onClick={() => void onCapture(src, true)}>Record 3s</button>
            <span className="muted tiny">Point it at something non-personal (a desk, a toy). Never film people for the demo.</span>
          </div>
          <MotionPanel videoRef={videoRef} camera={name} onCapture={onCapture} />
        </>
      )}
      {err && (
        <ErrorBox
          title="Could not open the camera"
          detail={`${err}\n\nAllow camera access for localhost:5173. For DroidCam: start the DroidCam client on Windows and connect it to the phone first, then choose "DroidCam Source" here.`}
        />
      )}
    </div>
  );
}

/** Arm/disarm motion-triggered recording on the live feed. Clips upload one at a time. */
function MotionPanel({ videoRef, camera, onCapture }: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  camera: string;
  onCapture: (src: Source, video: boolean) => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [sensitivity, setSensitivity] = useState(60);
  const sensRef = useRef(sensitivity);
  sensRef.current = sensitivity;
  const [meter, setMeter] = useState({ level: 0, threshold: thresholdFor(60) });
  const [state, setState] = useState<{ s: MotionState; ms?: number }>({ s: "watching" });
  const [count, setCount] = useState(0);
  const [queued, setQueued] = useState(0);
  const [err, setErr] = useState("");
  const queue = useRef<Promise<void>>(Promise.resolve());
  // The parent re-creates onCapture on every render; keep the latest in a ref so the watcher is
  // only re-armed when the user toggles it, not on every progress update.
  const captureRef = useRef(onCapture);
  captureRef.current = onCapture;

  useEffect(() => {
    const el = videoRef.current;
    if (!armed || !el) return;
    setErr("");
    const w = watchMotion(el, camera, () => sensRef.current, {
      onLevel: (level, threshold) => setMeter({ level, threshold }),
      onState: (s, ms) => setState({ s, ms }),
      onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
      onClip: (media, seconds) => {
        setCount((n) => n + 1);
        setQueued((n) => n + 1);
        const src: Source = {
          camera, label: `Motion detected (${seconds}s)`, live: true,
          first: `Motion detected: camera recorded ${seconds}s automatically`,
          produce: async () => media,
        };
        // Serialise uploads so overlapping events don't trample each other's progress.
        queue.current = queue.current.then(() => captureRef.current(src, true)).finally(() => setQueued((n) => n - 1));
      },
    });
    return () => w.stop();
  }, [armed, camera, videoRef]);

  const pct = Math.min(100, (meter.level / Math.max(meter.threshold * 2, 0.01)) * 100);
  const mark = 50; // the threshold sits at the middle of the bar
  const label = !armed ? "Disarmed"
    : state.s === "warming" ? "Warming up…"
    : state.s === "recording" ? `● Recording ${((state.ms ?? 0) / 1000).toFixed(1)}s`
    : state.s === "cooldown" ? "Saving clip…"
    : "Watching for motion";

  return (
    <div className="motion">
      <div className="row spread">
        <label className="row small">
          <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
          <b>Motion detection</b>
        </label>
        <span className={`motion-state ${armed ? state.s : "off"}`}>{label}</span>
      </div>
      {armed && (
        <>
          <div className="meter" title={`motion ${(meter.level * 100).toFixed(1)}% of pixels, trigger at ${(meter.threshold * 100).toFixed(1)}%`}>
            <div className={`meter-fill ${meter.level >= meter.threshold ? "hot" : ""}`} style={{ width: `${pct}%` }} />
            <div className="meter-mark" style={{ left: `${mark}%` }} />
          </div>
          <label className="row tiny muted">
            Sensitivity
            <input type="range" min={1} max={100} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
            {sensitivity}
          </label>
          <div className="muted tiny">
            Starts recording on motion, stops after 2s of stillness (max 15s). Each clip is encrypted on this device before upload.
            {count > 0 && ` ${count} motion event${count > 1 ? "s" : ""} recorded${queued > 0 ? `, ${queued} uploading` : ""}.`}
          </div>
        </>
      )}
      {err && <ErrorBox title="Motion detection error" detail={err} />}
    </div>
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
