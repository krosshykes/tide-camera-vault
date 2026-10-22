import React from "react";
import ReactDOM from "react-dom/client";
import { TideCloakContextProvider } from "@tidecloak/react";
import App from "./App";
import { Signup } from "./Signup";
import { Staff } from "./Staff";
import { loadTenant } from "./lib/tenant";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

async function boot() {
  // Signing up creates a household, so it runs before any household's Tide config exists.
  if (window.location.pathname.startsWith("/signup")) {
    root.render(<React.StrictMode><Signup /></React.StrictMode>);
    return;
  }
  // Staff sign-in is its own page; it picks CamCo's staff realm, then signs in to it.
  if (window.location.pathname.startsWith("/staff")) {
    root.render(<React.StrictMode><Staff /></React.StrictMode>);
    return;
  }
  try {
    const { adapter } = await loadTenant();
    // The provider takes the adapter JSON directly as the config prop.
    // useDPoP goes inside the config object, not as a separate JSX prop (I-12).
    root.render(
      <React.StrictMode>
        <TideCloakContextProvider config={{ ...adapter, useDPoP: { mode: "strict", alg: "ES256" } }}>
          <App />
        </TideCloakContextProvider>
      </React.StrictMode>,
    );
  } catch (e) {
    root.render(
      <div className="centered"><p className="muted">Could not load the household's sign-in settings: {e instanceof Error ? e.message : String(e)}. Is the CamCo backend running?</p></div>,
    );
  }
}

void boot();
