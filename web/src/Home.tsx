// The signed-out home page: what this is, why it exists, how it works, and the way in.
import { useState } from "react";
import { fetchHousehold, selectHousehold, tenant, DEMO_HOUSEHOLD } from "./lib/tenant";

const STEPS = [
  {
    n: "1",
    title: "Locked on your device",
    body: "Each motion clip is encrypted in your browser with a fresh AES-256 key before it's uploaded. CamCo's cloud only ever stores ciphertext.",
  },
  {
    n: "2",
    title: "The key isn't anywhere",
    body: "The clip's key is wrapped by the Tide network, about 20 independent servers that each hold only a fragment. There's no master key to steal, subpoena or misuse.",
  },
  {
    n: "3",
    title: "The network checks who you are",
    body: "To play a clip, Tide's servers each check that you hold the household's viewing role. Only then do they help unlock it, on your screen and nowhere else.",
  },
  {
    n: "4",
    title: "The household decides together",
    body: "Adding or removing a viewer takes 2 of 3 owners approving in their own Tide enclave. Not one owner, and never the camera company.",
  },
];

const COMPARE: [string, string, string][] = [
  ["A support worker opens your footage", "Possible: the company holds the keys", "Impossible: there are no keys to hold"],
  ["The company breaches and leaks everything", "Every home's video is exposed", "Attackers get ciphertext only"],
  ["An admin grants themselves access", "One click in the admin panel", "Lands as a request the household can deny"],
  ["Someone asks the company to hand over a clip", "The company decides alone", "The company has nothing it can open"],
  ["A housemate moves out", "Hope someone remembers", "2 owners revoke it; every clip locks for them"],
];

const CAST = [
  { name: "Alex, Sam, Riley", role: "Owners", body: "Watch the cameras. Approve every change: any 2 of 3.", tone: "ok" },
  { name: "Jordan", role: "New housemate", body: "Can't watch anything until the owners agree to let him in.", tone: "warn" },
  { name: "CamCo Support", role: "The camera company", body: "Runs the servers and has root on them. Still can't watch, and can't let itself in.", tone: "vendor" },
];

export function Home({ onSignIn }: { onSignIn: () => void }) {
  const [picker, setPicker] = useState(false);
  const open = () => setPicker(true);
  return (
    <div className="home">
      {picker && <HouseholdPicker onSignIn={onSignIn} onClose={() => setPicker(false)} />}
      <header className="home-nav">
        <div className="brand"><span className="logo-dot" /> Home Camera Vault</div>
        <div className="row">
          <a className="btn ghost" href="/signup">Get started</a>
          <button className="btn primary" onClick={open}>Sign in with Tide</button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">Home security, without handing over the keys</span>
          <h1>Your cameras.<br />Your footage.<br /><span className="accent">Nobody else's call.</span></h1>
          <p className="lede">
            Footage from inside your home is encrypted on your devices. The camera company runs the cloud,
            but it can't watch your clips, can't hand them over, and can't give itself access, even with
            root on its own servers.
          </p>
          <div className="row">
            <button className="btn primary big" onClick={open}>Sign in with Tide</button>
            <a className="btn ghost big" href="/signup">Set up my household</a>
            <a className="btn ghost big" href="#how">How it works</a>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="cctv">
            <div className="cctv-bar"><span>● REC FRONT DOOR</span><span>{new Date().toISOString().slice(0, 10)}</span></div>
            <div className="cctv-lock">🔒</div>
            <div className="cctv-cipher">8f3a 91c2 e07d 4b16 a9f0 33ce 5d82 07b1 c64e 9a1f 2e70 bb39 …</div>
            <div className="cctv-caption">What CamCo's cloud sees</div>
          </div>
          <div className="pending-chip">⏳ CamCo asked to view · pending household approval: 0 of 2</div>
        </div>
      </section>

      <section className="home-section problem">
        <h2>The problem with camera apps today</h2>
        <p>
          The company that sells you the camera holds the keys to everything it records. Logging in doesn't
          change that: the vendor's admins sit above every customer account. A rogue employee, an attacker
          who breaches the vendor, or a quiet data request can all reach video from inside people's homes.
        </p>
      </section>

      <section className="home-section" id="how">
        <h2>How Home Camera Vault works</h2>
        <div className="steps-grid">
          {STEPS.map((s) => (
            <div className="step-card" key={s.n}>
              <span className="step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="home-section">
        <h2>What changes</h2>
        <div className="table-wrap">
          <table className="compare">
            <thead><tr><th>If…</th><th>Ordinary camera app</th><th>Home Camera Vault</th></tr></thead>
            <tbody>
              {COMPARE.map(([what, before, after]) => (
                <tr key={what}><td>{what}</td><td className="before">{before}</td><td className="after">{after}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="home-section">
        <h2>Who's who in this demo</h2>
        <div className="cast-grid">
          {CAST.map((c) => (
            <div className={`cast-card ${c.tone}`} key={c.name}>
              <span className={`badge ${c.tone}`}>{c.role}</span>
              <h3>{c.name}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="home-section cta">
        <h2>See it for yourself</h2>
        <p>Sign in as a household owner to record and play encrypted clips, or as CamCo Support to try, and fail, to get in.</p>
        <button className="btn primary big" onClick={open}>Sign in with Tide</button>
      </section>

      <footer className="home-footer">
        <span>Prototype for the RMIT × Tide UNLOCKED hackathon. Cameras and footage are synthetic.</span>
        <span>Secured with <b>TideCloak</b>: no master key, quorum-approved access.</span>
      </footer>
    </div>
  );
}

/** Which household to sign in to. Each household is its own realm, so a change means a reload. */
function HouseholdPicker({ onSignIn, onClose }: { onSignIn: () => void; onClose: () => void }) {
  const current = tenant().info;
  const [code, setCode] = useState(current.id);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(id: string) {
    setErr(""); setBusy(true);
    try {
      if (id === current.id) { onSignIn(); return; }
      const h = await fetchHousehold(id.trim());
      if (h.status !== "ready") throw new Error(`"${h.name}" is still being set up (${h.status}).`);
      selectHousehold(h.id);
      window.location.assign("/?login=1"); // reload with that household's Tide config, then sign in
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose household">
        <h2>Sign in to your household</h2>
        <p className="muted small">Each household is separate, with its own keys and its own owners. Enter the household code you were given.</p>
        <form onSubmit={(e) => { e.preventDefault(); void go(code); }}>
          <label className="small">Household code
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy || !code.trim()}>{code.trim() === current.id ? `Sign in to ${current.name}` : "Continue"}</button>
            {current.id !== DEMO_HOUSEHOLD && <button type="button" className="btn ghost" disabled={busy} onClick={() => go(DEMO_HOUSEHOLD)}>Demo household</button>}
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
        {err && <p className="small warn-text">{err}</p>}
        <p className="muted tiny">New here? <a href="/signup">Set up a household</a>.</p>
      </div>
    </div>
  );
}
