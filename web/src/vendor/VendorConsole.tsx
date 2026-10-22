import { useCallback, useEffect, useState } from "react";
import { api, type Clip, type Me, type VaultPolicy } from "../lib/api";
import { unb64 } from "../lib/crypto";
import { unwrapKey, explainTideError } from "../lib/vault";
import { tally, type ChangeRequest } from "../lib/iga";
import { Steps, useSteps, ErrorBox, short, kb, when } from "../components";

interface Records { clips: Clip[]; vaultPolicy: VaultPolicy | null }
interface HouseholdRow { id: string; name: string; status: string; realm: string; clips: number; vault: boolean }

export function VendorConsole({ me }: { me: Me }) {
  const [records, setRecords] = useState<Records | null>(null);
  const [err, setErr] = useState("");
  const [list, setList] = useState<HouseholdRow[]>([]);
  const [target, setTarget] = useState(me.household.id);
  const load = useCallback(() => {
    setErr("");
    api<HouseholdRow[]>("/api/vendor/households").then(setList).catch(() => {});
    api<Records>(`/api/vendor/records?household=${encodeURIComponent(target)}`).then(setRecords).catch((e) => setErr(String(e.message ?? e)));
  }, [target]);
  useEffect(() => { setRecords(null); void load(); }, [load]);
  const current = list.find((h) => h.id === target);

  return (
    <div className="grid">
      <section className="card span-all vendor-banner">
        <h2>CamCo Support: full access to CamCo's own infrastructure</h2>
        <p>You can read every row in the database and you hold TideCloak's root admin password. What you can't do is watch a household's footage or give yourself the right to.</p>
      </section>
      <section className="card span-all">
        <h2>Customers</h2>
        <p className="muted small">Every household is its own TideCloak realm, with its own keys on the Tide network and its own owners. CamCo holds root on all of them.</p>
        <div className="table-wrap">
          <table className="raw">
            <thead><tr><th>household</th><th>realm</th><th>status</th><th>clips</th><th>vault</th><th /></tr></thead>
            <tbody>
              {list.map((h) => (
                <tr key={h.id} className={h.id === target ? "selected-row" : ""}>
                  <td>{h.name}<div className="muted tiny mono">{h.id}</div></td>
                  <td className="mono tiny">{h.realm}</td>
                  <td>{h.status}</td>
                  <td>{h.clips}</td>
                  <td>{h.vault ? "✓" : "—"}</td>
                  <td><button className="btn ghost" disabled={h.id === target} onClick={() => setTarget(h.id)}>{h.id === target ? "Inspecting" : "Inspect"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card span-all">
        <div className="row spread">
          <h2>Raw storage: <code>clips</code> table{current ? ` · ${current.name}` : ""}</h2>
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>
        {err && <ErrorBox title="Could not load records" detail={err} />}
        {records && records.clips.length === 0 && <p className="muted">No clips stored yet.</p>}
        {records && records.clips.length > 0 && (
          <div className="table-wrap">
            <table className="raw">
              <thead><tr><th>id</th><th>camera</th><th>captured</th><th>ciphertext</th><th>wrapped key</th><th /></tr></thead>
              <tbody>
                {records.clips.map((c) => (
                  <ClipRow key={c.id} clip={c} policy={records.vaultPolicy} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted tiny">Metadata (camera, time, size) is visible to CamCo. The footage and its keys are not.</p>
      </section>
      <SelfGrant me={me} target={target} targetName={current?.name ?? target} key={target} />
    </div>
  );
}

function ClipRow({ clip, policy }: { clip: Clip; policy: VaultPolicy | null }) {
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
        <td><button className="btn danger" onClick={view}>View clip</button></td>
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
