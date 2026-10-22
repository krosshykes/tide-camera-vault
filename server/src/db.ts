// One JSON file per household is the whole database. Everything sensitive in it is ciphertext.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Household } from "./households.ts";

export interface Clip {
  id: string;
  camera: string;
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

export interface AuditEntry { at: number; who: string; what: string; detail: string }

export interface Db { clips: Clip[]; vaultPolicy: VaultPolicy | null; audit: AuditEntry[] }

const cache = new Map<string, Db>();
const pathOf = (h: Household) => join(h.dataDir, "db.json");

export function db(h: Household): Db {
  if (!cache.has(h.id)) {
    const p = pathOf(h);
    cache.set(h.id, existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { clips: [], vaultPolicy: null, audit: [] });
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
