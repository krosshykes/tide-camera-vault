// The household registry: one TideCloak realm per household.
//
// Why a realm each: TideCloak's quorum (IGA) is realm-wide. In a shared realm every family's
// owners would approve everyone's changes, and the threshold would be 70% of ALL owners. A realm
// per household gives each family its own keys on the Tide network, its own owners and its own
// 2-of-3 quorum. CamCo creates the realm; once the first owner links their Tide account, CamCo
// can no longer change it without that household's approval.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ADAPTER_PATH, DATA_DIR, ROOT } from "./paths.ts";

export type HouseholdStatus = "provisioning" | "awaiting-owner" | "finalizing" | "ready" | "failed";

export interface Household {
  id: string;
  kind?: "household" | "vendor"; // vendor = CamCo staff realm; absent means household
  name: string;
  realm: string;
  client: string;
  dataDir: string; // db.json lives here
  adapterPath: string; // tidecloak.json for this realm (public: keys, vendorId, URLs)
  status: HouseholdStatus;
  createdAt: number;
  owner?: string; // the first owner's username in the realm
  error?: string;
  signupToken?: string; // lets the person who signed up poll progress; never listed
  inviteLink?: string; // the first owner's Tide account link; only returned to signupToken holder
}

const REGISTRY = join(DATA_DIR, "households.json");
// The demo household from `npm run bootstrap`. Its camco-support account is the legacy vendor login,
// used until CamCo has its own staff realm.
export const VENDOR_REALM = process.env.REALM_NAME || "camera-vault";
export const STAFF_ID = "camco-staff";

// The household made by `npm run bootstrap` is registered as the first one, at its original paths.
function seed(): Household[] {
  return [{
    id: VENDOR_REALM, name: "The Demo Household", realm: VENDOR_REALM, client: process.env.CLIENT_NAME || `${VENDOR_REALM}-client`,
    dataDir: DATA_DIR, adapterPath: ADAPTER_PATH, status: "ready", createdAt: Date.now(), owner: "alex",
  }];
}

let _list: Household[] | null = null;

export function households(): Household[] {
  if (!_list) {
    // Paths are stored relative to the project, so the folder can move; absolute in memory.
    const abs = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));
    _list = existsSync(REGISTRY)
      ? (JSON.parse(readFileSync(REGISTRY, "utf8")) as Household[]).map((h) => ({ ...h, dataDir: abs(h.dataDir), adapterPath: abs(h.adapterPath) }))
      : seed();
    if (!existsSync(REGISTRY)) saveRegistry();
  }
  return _list!;
}

export function saveRegistry() {
  mkdirSync(DATA_DIR, { recursive: true });
  const rel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");
  const out = households().map((h) => ({ ...h, dataDir: rel(h.dataDir), adapterPath: rel(h.adapterPath) }));
  writeFileSync(REGISTRY, JSON.stringify(out, null, 2) + "\n");
}

export const household = (id: string) => households().find((h) => h.id === id);

export function addHousehold(h: Household) {
  households().push(h);
  saveRegistry();
}

export function updateHousehold(id: string, patch: Partial<Household>) {
  const h = household(id);
  if (!h) throw new Error(`no household ${id}`);
  Object.assign(h, patch);
  saveRegistry();
  return h;
}

export function newHouseholdPaths(id: string) {
  const dataDir = join(DATA_DIR, "households", id);
  return { dataDir, adapterPath: join(dataDir, "tidecloak.json") };
}

export function adapterOf(h: Household): Record<string, unknown> | null {
  return existsSync(h.adapterPath) ? JSON.parse(readFileSync(h.adapterPath, "utf8")) : null;
}

/** Public view of a household: safe to show anyone who has its id. */
export const publicView = (h: Household) => ({ id: h.id, name: h.name, status: h.status, createdAt: h.createdAt, kind: h.kind ?? "household" });

export const isStaffRealm = (h: Household) => h.kind === "vendor";
export const customerHouseholds = () => households().filter((h) => !isStaffRealm(h));
export const staffRealm = () => households().find(isStaffRealm);

export function removeHousehold(id: string) {
  const list = households();
  const i = list.findIndex((h) => h.id === id);
  if (i >= 0) { list.splice(i, 1); saveRegistry(); }
}
