import { useEffect, useState } from "react";
import { useTideCloak, useAuthCallback, Authenticated, Unauthenticated } from "@tidecloak/react";
import { api, type Me } from "./lib/api";
import { Household } from "./household/Household";
import { VendorConsole } from "./vendor/VendorConsole";
import { Home } from "./Home";

// isInitializing must be checked BEFORE Authenticated/Unauthenticated guards (template rule).
export default function App() {
  const { isInitializing } = useTideCloak();
  const { isCallback, isProcessing, error: callbackError } = useAuthCallback({
    onSuccess: (returnUrl) => window.location.assign(returnUrl || "/"),
    onError: () => window.location.assign("/"),
    onMissingVerifierRedirectTo: "/",
  });

  if (isCallback) {
    if (callbackError) return <Centered>Authentication failed: {callbackError.message}</Centered>;
    return <Centered>{isProcessing ? "Completing login..." : "Redirecting..."}</Centered>;
  }
  if (isInitializing) return <Centered>Connecting to TideCloak...</Centered>;

  return (
    <>
      <Authenticated><SignedIn /></Authenticated>
      <Unauthenticated><Landing /></Unauthenticated>
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered"><p className="muted">{children}</p></div>;
}

function Landing() {
  const { login } = useTideCloak();
  // After picking a different household the page reloads with ?login=1: go straight to Tide.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("login") === "1") {
      window.history.replaceState(null, "", "/");
      login();
    }
  }, [login]);
  return <Home onSignIn={login} />;
}

function SignedIn() {
  const { logout } = useTideCloak();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { api<Me>("/api/me").then(setMe).catch((e) => setError(String(e.message ?? e))); }, []);

  if (error) return <Centered>Could not reach the CamCo backend: {error}</Centered>;
  if (!me) return <Centered>Loading...</Centered>;

  return (
    <div className={me.isVendor ? "app vendor" : "app household"}>
      <header className="topbar">
        <div className="brand">
          <span className="logo-dot" />
          <span>{me.isVendor ? "CamCo Vendor Console" : "Home Camera Vault"}</span>
          {!me.isVendor && <span className="household-name">· {me.household.name}</span>}
          <span className={`area-tag ${me.isVendor ? "vendor" : "household"}`}>{me.isVendor ? "VENDOR · INTERNAL" : "HOUSEHOLD APP"}</span>
        </div>
        <div className="who">
          <span className="user-chip">{me.username}</span>
          {me.isOwner && <span className="badge ok">owner · approver</span>}
          {me.isHousehold && !me.isOwner && <span className="badge ok">household viewer</span>}
          {!me.isHousehold && !me.isVendor && <span className="badge warn">no viewing rights</span>}
          {me.isVendor && <span className="badge vendor">root on servers + DB</span>}
          <button className="btn ghost" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main>{me.isVendor ? <VendorConsole me={me} /> : <Household me={me} />}</main>
    </div>
  );
}
