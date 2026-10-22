// CamCo's legitimate operations: everything a camera company needs to run the service, built
// from metadata alone. None of it needs, or can get, a household's footage.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { TC } from "./tidecloakAdmin.ts";
import { customerHouseholds, type Household } from "./households.ts";
import { db, save, audit } from "./db.ts";

// --- service health -------------------------------------------------------------------------------

async function timed(url: string, ms = 4000) {
  const t = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: r.ok, ms: Math.round(performance.now() - t) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t) };
  }
}

let healthCache: { at: number; value: unknown } | null = null;

/** TideCloak, the Tide ORK network (20 nodes, 14 needed), and storage totals. Cached 30 s. */
export async function serviceHealth() {
  if (healthCache && Date.now() - healthCache.at < 30_000) return healthCache.value;
  const [tidecloak, ...orks] = await Promise.all([
    timed(`${TC}/realms/master`),
    ...Array.from({ length: 20 }, (_, i) => timed(`https://ork${i + 1}.tideprotocol.com`)),
  ]);
  const hs = customerHouseholds();
  const byStatus: Record<string, number> = {};
  let clips = 0, bytes = 0;
  for (const h of hs) {
    byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
    const d = db(h);
    clips += d.clips.length;
    bytes += d.clips.reduce((n, c) => n + c.bytes, 0);
  }
  const reachable = orks.filter((o) => o.ok).length;
  const value = {
    checkedAt: Date.now(),
    tidecloak,
    orks: { reachable, total: 20, threshold: 14, healthy: reachable >= 14, slowestMs: Math.max(...orks.map((o) => o.ms)) },
    households: { total: hs.length, byStatus },
    storage: { clips, bytes },
  };
  healthCache = { at: Date.now(), value };
  return value;
}

// --- per-household metadata ----------------------------------------------------------------------

export function householdMetadata(h: Household) {
  const d = db(h);
  const last = d.clips.reduce((m, c) => Math.max(m, c.capturedAt), 0);
  return {
    storageBytes: d.clips.reduce((n, c) => n + c.bytes, 0),
    lastUpload: last || null,
    cameras: new Set(d.clips.map((c) => c.camera)).size,
  };
}

/** Camera fleet for one household: what each camera has uploaded, and when. No content. */
export function fleet(h: Household) {
  type Row = { camera: string; location: string; registered: boolean; events: number; bytes: number; lastSeen: number; videos: number };
  const d = db(h);
  const rows = new Map<string, Row>();
  // Registered cameras first, so a camera that never uploaded still shows (as "never seen").
  for (const c of d.cameras) rows.set(c.id, { camera: c.name, location: c.location, registered: true, events: 0, bytes: 0, lastSeen: 0, videos: 0 });
  for (const c of d.clips) {
    const key = c.cameraId && rows.has(c.cameraId) ? c.cameraId : `name:${c.camera}`;
    const e = rows.get(key) ?? { camera: c.camera, location: "", registered: false, events: 0, bytes: 0, lastSeen: 0, videos: 0 };
    e.events++; e.bytes += c.bytes; e.lastSeen = Math.max(e.lastSeen, c.capturedAt);
    if (c.mime.startsWith("video/")) e.videos++;
    rows.set(key, e);
  }
  const now = Date.now();
  return [...rows.values()]
    .map((e) => ({ ...e, status: !e.lastSeen ? "never seen" : !e.registered ? "not registered" : now - e.lastSeen < 24 * 3600_000 ? "active" : "quiet" }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

// --- legal / police requests -----------------------------------------------------------------------

export interface LegalRequest {
  id: string;
  receivedAt: number;
  loggedBy: string;
  household: string;
  householdName: string;
  requester: string; // e.g. "Victoria Police"
  reference: string; // their case / warrant number
  scope: string; // what they asked for, in their words
  outcome: string;
}

const LEGAL = join(DATA_DIR, "legal-requests.json");

export function legalRequests(): LegalRequest[] {
  return existsSync(LEGAL) ? JSON.parse(readFileSync(LEGAL, "utf8")) : [];
}

/**
 * Log a request for a household's footage. CamCo answers the only true thing it can: it holds
 * ciphertext and no way to open it, so disclosure has to come from the household. The household
 * is told, in its own activity log, that the request arrived.
 */
export function logLegalRequest(by: string, h: Household, input: { requester: string; reference: string; scope: string }): LegalRequest {
  const req: LegalRequest = {
    id: randomUUID(),
    receivedAt: Date.now(),
    loggedBy: by,
    household: h.id,
    householdName: h.name,
    requester: input.requester.slice(0, 120),
    reference: input.reference.slice(0, 80),
    scope: input.scope.slice(0, 500),
    outcome:
      "CamCo cannot disclose footage: clips are encrypted on the household's devices, and the keys are held by the Tide " +
      "network under the household's own policy. CamCo holds no key and cannot obtain one. The requester has been " +
      "referred to the household, who alone can decide whether to release footage. Stored metadata (camera names, " +
      "timestamps, sizes) can be provided under the applicable legal process.",
  };
  const all = [req, ...legalRequests()];
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LEGAL, JSON.stringify(all, null, 2));
  audit(h, "CamCo", "legal-request.received", `${req.requester} (ref ${req.reference}) asked for: ${req.scope}. CamCo could not disclose footage and referred them to you.`);
  save(h);
  return req;
}
