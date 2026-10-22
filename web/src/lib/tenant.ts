// Which household this browser is signing in to. Each household is its own TideCloak realm, so
// the app loads that realm's adapter config (public: realm URL, client id, public key, vendorId)
// before the Tide provider starts. Switching household means a fresh page load.

export interface Adapter {
  realm: string;
  resource: string;
  vendorId: string;
  "auth-server-url": string;
  [k: string]: unknown;
}

export interface HouseholdInfo { id: string; name: string; status: string }

const KEY = "camvault.household";
export const DEMO_HOUSEHOLD = "camera-vault";

export function selectedHousehold(): string {
  try { return localStorage.getItem(KEY) || DEMO_HOUSEHOLD; } catch { return DEMO_HOUSEHOLD; }
}

export function selectHousehold(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode: falls back to the demo household */ }
}

let current: { info: HouseholdInfo; adapter: Adapter } | null = null;

export async function fetchHousehold(id: string): Promise<HouseholdInfo> {
  const res = await fetch(`/api/households/${encodeURIComponent(id)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as HouseholdInfo;
}

/** Load the selected household's adapter. Falls back to the demo household if it's gone. */
export async function loadTenant(): Promise<{ info: HouseholdInfo; adapter: Adapter }> {
  for (const id of [...new Set([selectedHousehold(), DEMO_HOUSEHOLD])]) {
    try {
      const info = await fetchHousehold(id);
      const res = await fetch(`/api/households/${encodeURIComponent(id)}/adapter`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      current = { info, adapter: (await res.json()) as Adapter };
      if (id !== selectedHousehold()) selectHousehold(id);
      return current;
    } catch (e) {
      if (id === DEMO_HOUSEHOLD) throw e;
    }
  }
  throw new Error("no household available");
}

export function tenant() {
  if (!current) throw new Error("household config not loaded yet");
  return current;
}

export const tideConfig = () => tenant().adapter;
