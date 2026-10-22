// The household's cameras. Owners register cameras (a name and where it is); each camera is then
// fed by a video device on some household member's computer: a phone camera, a laptop webcam,
// any capture device. Every camera tile runs its own preview, snapshot/record and motion
// detection, and every capture goes through the same pipeline: encrypted on this device with a
// fresh AES key, the key wrapped by the Tide network under the household's vault policy, and only
// ciphertext uploaded.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Me } from "../lib/api";
import { encryptClip } from "../lib/crypto";
import { vaultPolicy, wrapKey, explainTideError } from "../lib/vault";
import { tenant } from "../lib/tenant";
import { listCameras, openCamera, liveSnapshot, liveClip } from "../camera/live";
import { watchMotion, thresholdFor, type MotionState } from "../camera/motion";
import { Steps, useSteps, Media, ErrorBox, kb, when } from "../components";
import { saveHouseholdCopy, markInCloud, type LocalClip } from "../lib/localVault";

export interface CameraRec { id: string; name: string; location: string; addedBy: string; addedAt: number }

interface Source {
  label: string;
  first?: string; // overrides the first step label (motion clips are already recorded)
  produce: (video: boolean) => Promise<{ bytes: Uint8Array; mime: string }>;
}

export function Cameras({ me, onUploaded }: { me: Me; onUploaded: () => void }) {
  const [cams, setCams] = useState<CameraRec[] | null>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", location: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<CameraRec[]>("/api/cameras").then((c) => { setCams(c); setErr(""); }).catch((e) => setErr(String(e.message ?? e))), []);
  useEffect(() => { void load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await api("/api/cameras", { method: "POST", body: JSON.stringify(form) }); setForm({ name: "", location: "" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function remove(c: CameraRec) {
    if (!window.confirm(`Remove "${c.name}"? Its recorded clips stay in Motion events.`)) return;
    try { await api(`/api/cameras/${encodeURIComponent(c.id)}`, { method: "DELETE" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <section className="card span-all">
      <div className="row spread">
        <h2>Cameras</h2>
        <span className="muted tiny">{cams ? `${cams.length} camera${cams.length === 1 ? "" : "s"}` : ""}</span>
      </div>
      <p className="muted small">Each camera is fed by a video device on this computer: a phone camera, a webcam, any capture device. Everything it records is encrypted here before upload. Point cameras at something non-personal for the demo.</p>
      {err && <ErrorBox title="Cameras" detail={err} />}
      {cams && cams.length === 0 && (
        <p className="muted">{me.isOwner ? "No cameras yet. Add the first one below." : "No cameras yet. Ask an owner to add one."}</p>
      )}
      <div className="camera-grid">
        {cams?.map((c) => <CameraTile key={c.id} me={me} cam={c} canRemove={me.isOwner} onRemove={() => remove(c)} onUploaded={onUploaded} />)}
      </div>
      {me.isOwner && (
        <form className="invite-form" onSubmit={add}>
          <input required maxLength={40} placeholder="Camera name, e.g. Front door" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input maxLength={40} placeholder="Where it is, e.g. Entrance" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <button className="btn" disabled={busy}>Add camera</button>
        </form>
      )}
    </section>
  );
}

// Which physical device feeds which camera is a property of this computer, so it's remembered here.
const deviceKey = (camId: string) => `camvault.device.${tenant().info.id}.${camId}`;
const savedDevice = (camId: string) => { try { return localStorage.getItem(deviceKey(camId)) ?? ""; } catch { return ""; } };
const saveDevice = (camId: string, id: string) => { try { localStorage.setItem(deviceKey(camId), id); } catch { /* ignore */ } };
// Show the device the way the system names it, or a numbered fallback before permission is granted.
const deviceName = (label: string | undefined, fallback: string) => label || fallback;

function CameraTile({ me, cam, canRemove, onRemove, onUploaded }: { me: Me; cam: CameraRec; canRemove: boolean; onRemove: () => void; onUploaded: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [on, setOn] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => savedDevice(cam.id));
  const [status, setStatus] = useState("");
  const [camErr, setCamErr] = useState("");
  const [gen, setGen] = useState(0); // bumps on every new stream so the attach effect re-runs

  // --- this tile's own capture pipeline ---------------------------------------------------------
  const { steps, run } = useSteps();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null);
  const [preview, setPreview] = useState<{ bytes: Uint8Array; mime: string } | null>(null);

  const capture = useCallback(async (src: Source, video: boolean) => {
    setBusy(true); setErr(null); setPreview(null);
    try {
      await run([
        src.first ?? (video ? `${cam.name} records a 3-second clip` : `${cam.name} takes a snapshot`),
        "Encrypt it in this browser with a fresh AES-256-GCM key",
        "Tide network wraps the AES key under the household vault policy",
        "Keep the household's own encrypted copy",
        "Upload ciphertext + wrapped key to CamCo cloud",
      ], async (step) => {
        const media = await src.produce(video);
        setPreview(media);
        step(0, `${kb(media.bytes.length)} ${media.mime}, plaintext stays on this device`);
        const enc = await encryptClip(media.bytes);
        step(1, `${kb(enc.ciphertext.length * 0.75)} of ciphertext`);
        const wrappedKey = await wrapKey(enc.rawKey, await vaultPolicy());
        step(2, "no one, including CamCo, holds a key that can unwrap it");
        // The household's copy is written first, under the id both copies will share, so neither
        // an upload failure nor CamCo later deleting its copy can lose the clip.
        const copy: LocalClip = {
          id: crypto.randomUUID(), household: tenant().info.id, cameraId: cam.id, camera: cam.name, label: src.label,
          mime: media.mime, capturedAt: Date.now(), uploadedBy: me.username, bytes: Math.floor(enc.ciphertext.length * 0.75),
          iv: enc.iv, ciphertext: enc.ciphertext, wrappedKey, savedAt: Date.now(), inCloud: false,
        };
        const saved = await saveHouseholdCopy(copy);
        step(3, [saved.device ? "on this device" : "", saved.folder === "written" ? "in the backup folder" : "", saved.folder === "needs-permission" ? "(backup folder needs permission again)" : ""].filter(Boolean).join(", ") || "off on this device");
        await api("/api/clips", { method: "POST", body: JSON.stringify({
          id: copy.id, cameraId: cam.id, label: src.label, mime: media.mime, iv: enc.iv, ciphertext: enc.ciphertext, wrappedKey, capturedAt: copy.capturedAt,
        }) });
        if (saved.device) await markInCloud(copy.id, true);
        step(4, "server stored: ciphertext only");
      });
      onUploaded();
    } catch (e) {
      const x = explainTideError(e);
      // If it failed at upload, the household copy is already saved: say so instead of implying loss.
      setErr({ title: x.refused ? x.summary : `Capture failed: ${e instanceof Error ? e.message : e}`, detail: `${x.detail}

If the encrypted copy was already kept on this device, it is safe: Household copy → Restore to cloud uploads it later.` });
      onUploaded();
    } finally { setBusy(false); }
  }, [cam.id, cam.name, me.username, onUploaded, run]);

  // --- the video device -------------------------------------------------------------------------
  const stopTracks = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  useEffect(() => stopTracks, []);

  useEffect(() => {
    const el = videoRef.current;
    const s = streamRef.current;
    if (!on || !el || !s) return;
    el.srcObject = s;
    el.play().catch((e) => setCamErr(`Video playback failed: ${e instanceof Error ? e.message : e}`));
    setStatus("waiting for picture…");
    const t = setTimeout(() => {
      const track = s.getVideoTracks()[0];
      if (el.videoWidth > 0) setStatus(`receiving ${el.videoWidth}×${el.videoHeight} from "${deviceName(track?.label, "camera")}"`);
      else setStatus(`no picture from "${deviceName(track?.label, "camera")}" (track ${track?.readyState ?? "?"}${track?.muted ? ", muted" : ""}). Is the device connected?`);
    }, 2000);
    return () => clearTimeout(t);
  }, [on, gen]);

  async function start(id = deviceId) {
    setCamErr(""); setStatus("opening camera…");
    try {
      stopTracks();
      let s: MediaStream;
      try { s = await openCamera(id || undefined); }
      catch (e) {
        // The remembered device may be gone (unplugged, different computer): fall back to default.
        if (!id) throw e;
        s = await openCamera(undefined);
      }
      setDevices(await listCameras()); // labels are only readable after permission is granted
      const active = s.getVideoTracks()[0]?.getSettings().deviceId ?? "";
      streamRef.current = s;
      setDeviceId(active);
      saveDevice(cam.id, active);
      setOn(true);
      setGen((g) => g + 1);
    } catch (e) {
      setOn(false); setStatus("");
      setCamErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }
  function stop() { stopTracks(); setOn(false); setStatus(""); }

  const live: Source = {
    label: "Live capture",
    produce: async (v) => {
      const el = videoRef.current;
      if (!el || !streamRef.current) throw new Error("Start the camera first.");
      if (el.videoWidth === 0) throw new Error(`"${cam.name}" is not sending a picture yet, so there is nothing to capture.`);
      return v ? liveClip(el, cam.name) : liveSnapshot(el, cam.name);
    },
  };

  return (
    <div className="camera-tile">
      <div className="row spread">
        <div>
          <b>{cam.name}</b>
          <div className="muted tiny">{cam.location || "no location"} · added by {cam.addedBy} {when(cam.addedAt)}</div>
        </div>
        <div className="row">
          {!on
            ? <button className="btn" onClick={() => start()}>Start</button>
            : <button className="btn ghost" onClick={stop}>Stop</button>}
          {canRemove && <button className="btn ghost" title="Remove camera" onClick={onRemove}>✕</button>}
        </div>
      </div>
      {on && (
        <>
          <label className="muted tiny">Video device:{" "}
            <select className="select" value={deviceId} onChange={(e) => void start(e.target.value)}>
              {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{deviceName(d.label, `camera ${i + 1}`)}</option>)}
            </select>
          </label>
          <video ref={videoRef} className="media live-preview" autoPlay muted playsInline />
          {status && <div className="muted tiny">{status}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void capture(live, false)}>Snapshot</button>
            <button className="btn primary" disabled={busy} onClick={() => void capture(live, true)}>Record 3s</button>
          </div>
          <MotionPanel videoRef={videoRef} camera={cam.name} onCapture={capture} />
        </>
      )}
      {camErr && (
        <ErrorBox title="Could not open the camera"
          detail={`${camErr}\n\nAllow camera access for this site. For a phone camera: connect the phone to this computer first, then choose its device here.`} />
      )}
      <Steps steps={steps} />
      {err && <ErrorBox {...err} />}
      {preview && <div className="preview"><span className="tag">camera view, before encryption (never uploaded)</span><Media {...preview} /></div>}
    </div>
  );
}

/** Arm/disarm motion-triggered recording on one camera. Its clips upload one at a time. */
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
  // Keep the latest capture function in a ref so the watcher is only re-armed when the user
  // toggles it, not on every progress update.
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
          label: `Motion detected (${seconds}s)`,
          first: `Motion detected: ${camera} recorded ${seconds}s automatically`,
          produce: async () => media,
        };
        // Serialise this camera's uploads so overlapping events don't trample each other.
        queue.current = queue.current.then(() => captureRef.current(src, true)).finally(() => setQueued((n) => n - 1));
      },
    });
    return () => w.stop();
  }, [armed, camera, videoRef]);

  const pct = Math.min(100, (meter.level / Math.max(meter.threshold * 2, 0.01)) * 100);
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
            <div className="meter-mark" style={{ left: "50%" }} />
          </div>
          <label className="row tiny muted">
            Sensitivity
            <input type="range" min={1} max={100} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
            {sensitivity}
          </label>
          <div className="muted tiny">
            Records on motion, stops after 2s of stillness (max 15s).
            {count > 0 && ` ${count} motion event${count > 1 ? "s" : ""} recorded${queued > 0 ? `, ${queued} uploading` : ""}.`}
          </div>
        </>
      )}
      {err && <ErrorBox title="Motion detection error" detail={err} />}
    </div>
  );
}
