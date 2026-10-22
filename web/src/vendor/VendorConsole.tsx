import { useCallback, useEffect, useState } from "react";
import { api, type Clip, type Me, type VaultPolicy } from "../lib/api";
import { unb64 } from "../lib/crypto";
import { unwrapKey, explainTideError } from "../lib/vault";
import { tally, type ChangeRequest } from "../lib/iga";
import { Steps, useSteps, ErrorBox, short, kb, when } from "../components";

interface Records { clips: Clip[]; vaultPolicy: VaultPolicy | null }
interface HouseholdRow {
  id: string; name: string; status: string; realm: string; owner?: string; createdAt: number;
  clips: number; vault: boolean; storageBytes: number; lastUpload: number | null; cameras: number;
}
interface Health {
  checkedAt: number;
  tidecloak: { ok: boolean; ms: number };
  orks: { reachable: number; total: number; threshold: number; healthy: boolean; slowestMs: number };
  households: { total: number; byStatus: Record<string, number> };
  storage: { clips: number; bytes: number };
}
interface Camera { camera: string; location: string; registered: boolean; events: number; bytes: number; lastSeen: number; videos: number; status: string }
interface LegalRequest { id: string; receivedAt: number; loggedBy: string; household: string; householdName: string; requester: string; reference: string; scope: string; outcome: string }

const ago = (t: number | null) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const mb = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : kb(b));

export function VendorConsole({ me }: { me: Me }) {
  const [records, setRecords] = useState<Records | null>(null);
  const [err, setErr] = useState("");
  const [list, setList] = useState<HouseholdRow[]>([]);
  const [target, setTarget] = useState("");
  const [tab, setTab] = useState<"ops" | "trust">("ops");

  const loadList = useCallback(() => api<HouseholdRow[]>("/api/vendor/households").then((l) => {
    setList(l);
    setTarget((t) => t || l.find((h) => h.status === "ready")?.id || l[0]?.id || "");
  }).catch((e) => setErr(String(e.message ?? e))), []);
  useEffect(() => { void loadList(); const t = setInterval(loadList, 10000); return () => clearInterval(t); }, [loadList]);

  const loadRecords = useCallback(() => {
    if (!target) return;
    api<Records>(`/api/vendor/records?household=${encodeURIComponent(target)}`).then(setRecords).catch((e) => setErr(String(e.message ?? e)));
  }, [target]);
  useEffect(() => { setRecords(null); void loadRecords(); }, [loadRecords]);
  const current = list.find((h) => h.id === target);

  return (
    <div className="grid">
      <section className="card span-all vendor-banner">
        <h2>CamCo operations</h2>
        <p>Signed in as <b>{me.username}</b>. You run the whole service: servers, storage, TideCloak, every customer's realm. You can do all of it from metadata. You can't watch a household's footage, or give anyone (including yourself) the right to.</p>
        <div className="row">
          <button className={`btn ${tab === "ops" ? "primary" : "ghost"}`} onClick={() => setTab("ops")}>Run the service</button>
          <button className={`btn ${tab === "trust" ? "primary" : "ghost"}`} onClick={() => setTab("trust")}>Try to look inside</button>
        </div>
      </section>

      {tab === "ops" && <ServiceHealth />}

      <section className="card span-all">
        <h2>Customers</h2>
        <p className="muted small">Each household is its own TideCloak realm, with its own keys on the Tide network and its own owners. CamCo holds root on all of them.</p>
        {err && <ErrorBox title="Could not load" detail={err} />}
        <div className="table-wrap">
          <table className="raw">
            <thead><tr><th>household</th><th>status</th><th>cameras</th><th>clips</th><th>storage</th><th>last upload</th><th>vault</th><th /></tr></thead>
            <tbody>
              {list.map((h) => (
                <tr key={h.id} className={h.id === target ? "selected-row" : ""}>
                  <td>{h.name}<div className="muted tiny mono">{h.id} · owner {h.owner ?? "?"}</div></td>
                  <td>
                    <span className={`badge ${h.status === "ready" ? "ok" : h.status === "failed" ? "vendor" : "warn"}`}>{h.status}</span>
                    {h.status !== "ready" && <div className="muted tiny">since {ago(h.createdAt)}</div>}
                  </td>
                  <td>{h.cameras}</td>
                  <td>{h.clips}</td>
                  <td>{mb(h.storageBytes)}</td>
                  <td className="tiny">{ago(h.lastUpload)}</td>
                  <td>{h.vault ? "✓" : "—"}</td>
                  <td className="row">
                    <button className="btn ghost" disabled={h.id === target} onClick={() => setTarget(h.id)}>{h.id === target ? "Selected" : "Select"}</button>
                    {h.status === "awaiting-owner" && <ReissueLink id={h.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {tab === "ops" && current && <Fleet target={target} name={current.name} />}
      {tab === "ops" && <LegalRequests households={list} target={target} />}

      {tab === "trust" && (
        <>
          <section className="card span-all">
            <div className="row spread">
              <h2>Raw storage: <code>clips</code> table{current ? ` · ${current.name}` : ""}</h2>
              <button className="btn ghost" onClick={loadRecords}>Refresh</button>
            </div>
            {records && records.clips.length === 0 && <p className="muted">No clips stored yet.</p>}
            {records && records.clips.length > 0 && (
              <div className="table-wrap">
                <table className="raw">
                  <thead><tr><th>id</th><th>camera</th><th>captured</th><th>ciphertext</th><th>wrapped key</th><th /></tr></thead>
                  <tbody>
                    {records.clips.map((c) => (
                      <ClipRow key={c.id} clip={c} policy={records.vaultPolicy} target={target} onDestroyed={loadRecords} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted tiny">Metadata (camera, time, size) is visible to CamCo. The footage and its keys are not.</p>
          </section>
          {target && <SelfGrant me={me} target={target} targetName={current?.name ?? target} key={target} />}
        </>
      )}
    </div>
  );
}

function ServiceHealth() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api<Health>("/api/vendor/ops").then(setH).catch((e) => setErr(String(e.message ?? e))), []);
  useEffect(() => { void load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  if (err) return <section className="card span-all"><ErrorBox title="Health check failed" detail={err} /></section>;
  if (!h) return <section className="card span-all"><p className="muted">Checking the service…</p></section>;
  return (
    <section className="card span-all">
      <div className="row spread"><h2>Service health</h2><span className="muted tiny">checked {ago(h.checkedAt)}</span></div>
      <div className="tiles">
        <div className={`tile ${h.tidecloak.ok ? "good" : "bad"}`}><span className="tile-label">TideCloak</span><b>{h.tidecloak.ok ? "Up" : "Down"}</b><span className="tiny muted">{h.tidecloak.ms} ms</span></div>
        <div className={`tile ${h.orks.healthy ? "good" : "bad"}`}><span className="tile-label">Tide network</span><b>{h.orks.reachable}/{h.orks.total} ORKs</b><span className="tiny muted">needs {h.orks.threshold} · slowest {h.orks.slowestMs} ms</span></div>
        <div className="tile"><span className="tile-label">Households</span><b>{h.households.total}</b><span className="tiny muted">{Object.entries(h.households.byStatus).map(([k, v]) => `${v} ${k}`).join(" · ")}</span></div>
        <div className="tile"><span className="tile-label">Stored</span><b>{mb(h.storage.bytes)}</b><span className="tiny muted">{h.storage.clips} encrypted clips</span></div>
      </div>
    </section>
  );
}

function ReissueLink({ id }: { id: string }) {
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  async function go() {
    setErr("");
    try { setLink((await api<{ link: string }>(`/api/vendor/households/${encodeURIComponent(id)}/reissue-link`, { method: "POST" })).link); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <>
      <button className="btn" onClick={go}>Re-issue setup link</button>
      {link && <button className="btn ghost" onClick={() => void navigator.clipboard?.writeText(link)} title={link}>Copy link</button>}
      {err && <span className="tiny warn-text">{err}</span>}
    </>
  );
}

function Fleet({ target, name }: { target: string; name: string }) {
  const [cams, setCams] = useState<Camera[] | null>(null);
  useEffect(() => { setCams(null); api<Camera[]>(`/api/vendor/fleet?household=${encodeURIComponent(target)}`).then(setCams).catch(() => setCams([])); }, [target]);
  return (
    <section className="card span-all">
      <h2>Camera fleet · {name}</h2>
      <p className="muted small">Support work like "my camera stopped recording" is answered from upload metadata alone.</p>
      {cams && cams.length === 0 && <p className="muted">This household has no cameras yet.</p>}
      {cams && cams.length > 0 && (
        <table className="raw">
          <thead><tr><th>camera</th><th>status</th><th>last seen</th><th>events</th><th>of which video</th><th>stored</th></tr></thead>
          <tbody>
            {cams.map((c) => (
              <tr key={c.camera}>
                <td>{c.camera}{c.location && <div className="muted tiny">{c.location}</div>}</td>
                <td><span className={`badge ${c.status === "active" ? "ok" : "warn"}`}>{c.status}</span></td>
                <td className="tiny">{ago(c.lastSeen)}</td>
                <td>{c.events}</td>
                <td>{c.videos}</td>
                <td>{mb(c.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LegalRequests({ households, target }: { households: HouseholdRow[]; target: string }) {
  const [list, setList] = useState<LegalRequest[]>([]);
  const [form, setForm] = useState({ household: target, requester: "", reference: "", scope: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => api<LegalRequest[]>("/api/vendor/legal-requests").then(setList).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setForm((f) => ({ ...f, household: f.household || target })); }, [target]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api(`/api/vendor/legal-requests?household=${encodeURIComponent(form.household || target)}`, { method: "POST", body: JSON.stringify(form) });
      setForm({ household: form.household, requester: "", reference: "", scope: "" });
      void load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="card span-all">
      <h2>Legal &amp; police requests</h2>
      <p className="muted small">Log every request for footage. CamCo can't comply with disclosure: it holds ciphertext and no key. The requester is referred to the household, and the household is told the request arrived.</p>
      <form className="legal-form" onSubmit={submit}>
        <select className="select" value={form.household || target} onChange={(e) => setForm({ ...form, household: e.target.value })}>
          {households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
        <input required placeholder="Requester, e.g. Victoria Police" value={form.requester} onChange={(e) => setForm({ ...form, requester: e.target.value })} />
        <input required placeholder="Reference / warrant no." value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        <input required placeholder="What they asked for, e.g. front door footage 21 Oct 8-9pm" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
        <button className="btn" disabled={busy}>Log request</button>
      </form>
      {err && <ErrorBox title="Could not log the request" detail={err} />}
      {list.length > 0 && (
        <div className="legal-list">
          {list.map((r) => (
            <div key={r.id} className="legal-item">
              <div className="row spread"><b>{r.requester} · ref {r.reference}</b><span className="muted tiny">{when(r.receivedAt)} · logged by {r.loggedBy}</span></div>
              <div className="small">{r.householdName}: {r.scope}</div>
              <div className="tiny legal-outcome">Outcome: {r.outcome}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ClipRow({ clip, policy, target, onDestroyed }: { clip: Clip; policy: VaultPolicy | null; target: string; onDestroyed: () => void }) {
  // The availability threat: CamCo can destroy ciphertext on its own disks. It leaves no tombstone,
  // so the household's devices notice, play their own copy, and restore it.
  async function destroy() {
    if (!window.confirm("Delete this clip's ciphertext from CamCo storage, without the household asking? (Demonstrates a rogue or accidental vendor deletion.)")) return;
    try { await api(`/api/vendor/clips/${encodeURIComponent(clip.id)}/destroy?household=${encodeURIComponent(target)}`, { method: "POST" }); onDestroyed(); }
    catch (e) { alert(`Could not delete: ${e instanceof Error ? e.message : e}`); }
  }
  const { steps, run } = useSteps();
  const [result, setResult] = useState<{ title: string; detail?: string } | null>(null);
  const [hex, setHex] = useState("");
  const [open, setOpen] = useState(false);

  async function view() {
    setOpen(true); setResult(null);
    const bytes = unb64(clip.ciphertext).slice(0, 96);
    setHex(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" "));
    try {
      await run([
        "Read ciphertext straight from the database (no API check, CamCo owns the DB)",
        "Try to render it as a picture: it's just noise",
        "Ask the Tide network to unwrap the clip key with the vault policy",
      ], async (step) => {
        step(0, kb(clip.bytes)); step(1, `${clip.mime}? no valid header, AES-GCM output`);
        if (!policy) throw new Error("no vault policy stored");
        await unwrapKey(clip.wrappedKey, policy);
        step(2);
      });
      setResult({ title: "Unexpected: the network released the key. This should never happen for CamCo." });
    } catch (e) {
      const x = explainTideError(e);
      setResult({ title: x.refused ? "Refused by the Tide network: CamCo Support doesn't hold the household's viewing role." : x.summary, detail: x.detail });
    }
  }

  return (
    <>
      <tr>
        <td className="mono tiny">{clip.id.slice(0, 8)}</td>
        <td>{clip.camera}<div className="muted tiny">{clip.label}</div></td>
        <td className="tiny">{when(clip.capturedAt)}</td>
        <td className="mono tiny cipher">{short(clip.ciphertext, 40)}<span className="badge ok">stored as ciphertext</span></td>
        <td className="mono tiny cipher">{short(clip.wrappedKey, 28)}</td>
        <td className="row"><button className="btn danger" onClick={view}>View clip</button><button className="btn ghost" title="Delete the ciphertext from CamCo storage" onClick={destroy}>Delete ciphertext</button></td>
      </tr>
      {open && (
        <tr className="detail-row"><td colSpan={6}>
          <Steps steps={steps} />
          {hex && <pre className="hexdump">{hex} …</pre>}
          {result && <ErrorBox {...result} />}
        </td></tr>
      )}
    </>
  );
}

interface GrantReply { results: { role: string; status: number; changeRequestId?: string; note?: string }[]; changeRequests: ChangeRequest[] }
interface ForceReply { attempts: { lane: string; status: number; body: unknown }[]; changeRequest: ChangeRequest }

function SelfGrant({ me, target, targetName }: { me: Me; target: string; targetName: string }) {
  const q = `household=${encodeURIComponent(target)}`;
  const [grant, setGrant] = useState<GrantReply | null>(null);
  const [force, setForce] = useState<ForceReply | null>(null);
  const [pending, setPending] = useState<ChangeRequest[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const loadPending = useCallback(() => api<ChangeRequest[]>(`/api/vendor/change-requests?${q}`).then(setPending).catch(() => {}), [q]);
  useEffect(() => { void loadPending(); const t = setInterval(loadPending, 5000); return () => clearInterval(t); }, [loadPending]);

  async function selfGrant() {
    setBusy(true); setErr(""); setForce(null);
    try { setGrant(await api<GrantReply>(`/api/vendor/self-grant?${q}`, { method: "POST" })); await loadPending(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function forceApprove(id: string) {
    setBusy(true); setErr("");
    try { setForce(await api<ForceReply>(`/api/vendor/cr/${id}/force?${q}`, { method: "POST" })); await loadPending(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Live status of each request we filed: still pending (in the list), or resolved.
  const filed = (grant?.results ?? []).filter((r) => r.changeRequestId).map((r) => {
    const live = pending.find((p) => p.id === r.changeRequestId);
    const first = grant!.changeRequests.find((c) => c.id === r.changeRequestId);
    return { role: r.role, id: r.changeRequestId!, cr: live ?? first ?? null, stillPending: !!live };
  });
  const anyApplied = grant?.results.some((r) => r.status >= 200 && r.status < 300 && !r.changeRequestId);

  return (
    <section className="card span-all">
      <h2>Escalate: grant myself viewing access to {targetName}</h2>
      <p className="muted small">Uses TideCloak's <b>master admin</b> (root) to give <code>{me.username}</code> the role <code>household-viewer</code>, which carries the decrypt capability <code>_tide_decryptor</code>. In a customer's realm CamCo staff don't even have an account, so root first has to file one. On an ordinary system this is one click and you'd be in.</p>
      <button className="btn danger big" disabled={busy} onClick={selfGrant}>Grant myself access to {targetName} (as root)</button>
      {err && <ErrorBox title="Request failed" detail={err} />}
      {grant && (
        <div className="result">
          {grant.results.map((r) => (
            <div className="result-line" key={r.role}>
              <span className="mono">POST /users/{me.username}/role-mappings/realm [{r.role}]</span> →{" "}
              <b className="warn-text">HTTP {r.status}{r.changeRequestId && r.status < 300 ? ": captured as a change request, not applied" : ""}{r.note ? `: ${r.note}` : ""}</b>
            </div>
          ))}
          {anyApplied && <div className="big-status bad">A role was applied directly. IGA did not capture it.</div>}
          {filed.map(({ role, id, cr, stillPending }) => {
            const t = cr ? tally(cr) : null;
            return (
              <div key={id} className={`big-status ${stillPending ? "pending" : "ok"}`}>
                {stillPending
                  ? <>⏳ <code>{role}</code> not applied. Pending household approval: {t?.have ?? "?"} of {t?.need ?? "?"}</>
                  : <>No longer pending: the household approved or denied it. Check the household's approvals.</>}
                <div className="tiny muted">change request {id}</div>
                {stillPending && <button className="btn" disabled={busy} onClick={() => forceApprove(id)}>Force-approve it as root</button>}
              </div>
            );
          })}
        </div>
      )}
      {force && (
        <div className="result">
          <h3>Root tried every approval route:</h3>
          <table className="raw">
            <tbody>
              {force.attempts.map((a) => (
                <tr key={a.lane}>
                  <td className="mono">POST …/{a.lane}</td>
                  <td><b className={a.status >= 400 || JSON.stringify(a.body).includes("needs-approval") ? "warn-text" : ""}>HTTP {a.status}</b></td>
                  <td className="mono tiny">{short(typeof a.body === "string" ? a.body : JSON.stringify(a.body), 160)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">Status afterwards: <b>{force.changeRequest?.status}</b>, approvals {tally(force.changeRequest).have ?? "?"} of {tally(force.changeRequest).need}. Approving needs an owner's signature from the Tide enclave, and root has no Tide key.</p>
        </div>
      )}
      {pending.length > 0 && (
        <details className="setup" open>
          <summary className="muted small">All pending change requests (as root sees them)</summary>
          <ul className="small">
            {pending.map((p) => <li key={p.id}><span className="mono tiny">{p.id.slice(0, 8)}</span> {p.actionType} · {tally(p).have ?? "?"} of {tally(p).need}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
