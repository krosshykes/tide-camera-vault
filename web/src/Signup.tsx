// "Get started": a new customer signs up, and CamCo provisions their household's own realm.
// The page then walks the new owner through creating their Tide account, which is the moment
// CamCo stops being able to change anything in that household on its own.
import { useEffect, useState } from "react";
import { selectHousehold } from "./lib/tenant";
import { ErrorBox } from "./components";

interface Progress {
  household: { id: string; name: string; status: string };
  status: "provisioning" | "awaiting-owner" | "finalizing" | "ready" | "failed";
  error: string | null;
  inviteLink: string | null;
  owner?: string;
}

const TOKEN_KEY = "camvault.signup";
const ORDER = ["provisioning", "awaiting-owner", "finalizing", "ready"] as const;
const STEPS: { key: (typeof ORDER)[number]; label: string; note: string }[] = [
  { key: "provisioning", label: "Creating your household's private realm", note: "Its own keys on the Tide network, its own quorum, licensed and governed from the start." },
  { key: "awaiting-owner", label: "Create your Tide account", note: "Your password never reaches CamCo. Tide's network verifies it without anyone seeing it." },
  { key: "finalizing", label: "Making you the owner", note: "From this step on, CamCo can only file requests in your household. You approve them." },
  { key: "ready", label: "Ready", note: "Sign in, create your vault, and add your cameras and family." },
];

export function Signup() {
  const [form, setForm] = useState({ householdName: "", ownerName: "", username: "", email: "" });
  // A sign-up can be resumed from /signup?token=... (e.g. on another device), or from this browser.
  const [token, setToken] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) { try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* ignore */ } return fromUrl; }
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/signup/${encodeURIComponent(token)}`);
        if (res.status === 404) { forget(); return; }
        const p = (await res.json()) as Progress;
        if (alive) setProgress(p);
      } catch { /* backend restarting: keep polling */ }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [token]);

  function forget() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    setToken(null); setProgress(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const res = await fetch("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      try { localStorage.setItem(TOKEN_KEY, body.token); } catch { /* ignore */ }
      setToken(body.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  function goToHousehold() {
    if (!progress) return;
    selectHousehold(progress.household.id);
    forget();
    window.location.assign("/?login=1");
  }

  const at = progress ? ORDER.indexOf(progress.status as (typeof ORDER)[number]) : -1;

  return (
    <div className="home">
      <header className="home-nav">
        <a className="brand plain" href="/"><span className="logo-dot" /> Home Camera Vault</a>
        <a className="btn ghost" href="/">Back</a>
      </header>
      <section className="signup">
        {!token && (
          <form className="card signup-card" onSubmit={submit}>
            <h1>Set up your household</h1>
            <p className="muted">CamCo creates a private space for your home: its own keys on the Tide network and its own approval rules. Once you've created your Tide account, CamCo can't change anything in it without you.</p>
            <label>Household name<input required value={form.householdName} onChange={(e) => setForm({ ...form, householdName: e.target.value })} placeholder="e.g. The Nguyen home" /></label>
            <label>Your name<input required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} placeholder="e.g. Mai" /></label>
            <label>Username in your household<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} placeholder="e.g. mai" pattern="[a-z][a-z0-9._\-]{1,29}" title="2-30 characters: letters, numbers, . _ -" /></label>
            <label>Email <span className="muted tiny">(optional: Tide doesn't need it)</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <button className="btn primary big" disabled={busy}>{busy ? "Starting…" : "Create my household"}</button>
            {err && <ErrorBox title="Could not start" detail={err} />}
          </form>
        )}
        {token && progress && (
          <div className="card signup-card">
            <h1>{progress.household.name}</h1>
            <p className="muted small">Household code: <code>{progress.household.id}</code>. Family members use it to sign in.</p>
            <ol className="steps big-steps">
              {STEPS.map((s, i) => {
                const state = progress.status === "failed" ? (i <= Math.max(at, 0) ? "fail" : "pending") : i < at || progress.status === "ready" ? "ok" : i === at ? "running" : "pending";
                return (
                  <li key={s.key} className={`step ${state}`}>
                    <span className="step-icon">{state === "ok" ? "✓" : state === "fail" ? "✕" : state === "running" ? "…" : "○"}</span>
                    <span>{s.label}<span className="step-note">{s.note}</span></span>
                  </li>
                );
              })}
            </ol>
            {progress.status === "awaiting-owner" && progress.inviteLink && (
              <div className="result">
                <a className="btn primary big" href={progress.inviteLink} target="_blank" rel="noreferrer">Create my Tide account</a>
                <p className="muted tiny">Opens in a new tab. Pick a username and password for Tide; this page continues by itself once you're done.</p>
              </div>
            )}
            {progress.status === "ready" && <button className="btn primary big" onClick={goToHousehold}>Go to my household</button>}
            {progress.status === "failed" && (
              <>
                <ErrorBox title="Setup failed" detail={progress.error ?? undefined} />
                <button className="btn" onClick={forget}>Start again</button>
              </>
            )}
          </div>
        )}
        {token && !progress && <p className="muted">Loading…</p>}
      </section>
    </div>
  );
}
