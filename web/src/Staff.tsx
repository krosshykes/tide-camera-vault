// CamCo staff sign-in: a separate entry point that signs in to CamCo's own staff realm, which is
// not any customer's realm and holds no household role.
import { useEffect, useState } from "react";
import { selectHousehold } from "./lib/tenant";

interface StaffRealm { id: string; name: string; legacy: boolean; staffRealmStatus?: string }

export function Staff() {
  const [realm, setRealm] = useState<StaffRealm | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/staff-realm").then((r) => r.json()).then(setRealm).catch((e) => setErr(String(e)));
  }, []);

  function signIn() {
    if (!realm) return;
    selectHousehold(realm.id);
    window.location.assign("/?login=1");
  }

  return (
    <div className="home staff-page">
      <header className="home-nav">
        <a className="brand plain" href="/"><span className="logo-dot" /> Home Camera Vault</a>
        <a className="btn ghost" href="/">Customer sign-in</a>
      </header>
      <section className="signup">
        <div className="card signup-card staff-card">
          <span className="area-tag vendor">CAMCO · STAFF ONLY</span>
          <h1>CamCo staff sign-in</h1>
          <p className="muted">For CamCo employees running the service. Staff accounts live in CamCo's own realm, separate from every customer household.</p>
          <div className="two-col">
            <div>
              <h3>You can</h3>
              <ul className="small">
                <li>monitor the service: TideCloak, the Tide network, storage</li>
                <li>help customers finish setup</li>
                <li>see each household's camera fleet and upload history</li>
                <li>log legal and police requests</li>
              </ul>
            </div>
            <div>
              <h3>You can't</h3>
              <ul className="small">
                <li>watch any footage</li>
                <li>give yourself or anyone access</li>
                <li>approve a household's changes</li>
                <li>reset a customer's Tide password</li>
              </ul>
            </div>
          </div>
          <button className="btn primary big" disabled={!realm} onClick={signIn}>Sign in as CamCo staff</button>
          {realm?.legacy && (
            <p className="muted tiny">
              CamCo's staff realm isn't ready yet ({realm.staffRealmStatus}), so this signs in with the demo realm's camco-support account.
              The operator finds the staff realm's setup link in <code>server/data/staff-invite.txt</code>.
            </p>
          )}
          {err && <p className="small warn-text">{err}</p>}
        </div>
      </section>
    </div>
  );
}
