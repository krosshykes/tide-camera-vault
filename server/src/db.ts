// One JSON file per household is the whole database. Everything sensitive in it is ciphertext.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Household } from "./households.ts";

export interface Clip {
  id: string;
  camera: string; // the camera's name at the time of recording
  cameraId?: string; // registered camera (absent on clips from before cameras were registered)
  label: string;
  mime: string;
  capturedAt: number;
  uploadedBy: string;
  bytes: number;
  iv: string; // base64, AES-GCM nonce
  ciphertext: string; // base64, AES-256-GCM(clip)
  wrappedKey: string; // the AES key, encrypted by the Tide network under the vault policy
}

export interface VaultPolicy {
  policy: string; // base64 signed RelationshipAttestation:1 policy
  recordId: string; // the one tag every wrapped key carries
  signedBy: string;
  signedAt: number;
}

/** A registered camera. Its name and location are metadata CamCo can see; never footage. */
export interface Camera { id: string; name: string; location: string; addedBy: string; addedAt: number }

export interface AuditEntry { at: number; who: string; what: string; detail: string }

export interface Db {
  clips: Clip[];
  vaultPolicy: VaultPolicy | null;
  audit: AuditEntry[];
  cameras: Camera[];
  retentionDays?: number | null; // auto-delete clips older than this; null/absent = keep
  timezone?: string | null; // IANA name shown across the app and stamped on footage; null = each device's own
  tombstones?: Tombstone[]; // clips the HOUSEHOLD deleted (or retention removed), newest first
}

/** Record of a deliberate deletion. A clip gone from storage with no tombstone was not deleted by the household. */
export interface Tombstone { id: string; at: number; by: string; reason: string }

const cache = new Map<string, Db>();
const pathOf = (h: Household) => join(h.dataDir, "db.json");

export function db(h: Household): Db {
  if (!cache.has(h.id)) {
    const p = pathOf(h);
    // Defaults first, so households saved before a field existed (e.g. cameras) still load.
    const loaded = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    cache.set(h.id, { clips: [], vaultPolicy: null, audit: [], cameras: [], ...loaded });
  }
  return cache.get(h.id)!;
}

export function save(h: Household) {
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(pathOf(h), JSON.stringify(db(h), null, 2));
}

export function audit(h: Household, who: string, what: string, detail: string) {
  const d = db(h);
  d.audit.unshift({ at: Date.now(), who, what, detail });
  d.audit.length = Math.min(d.audit.length, 500);
}
