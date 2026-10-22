// A JSON file is the whole database. Everything sensitive in it is ciphertext.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR, DB_PATH } from "./paths.ts";

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

interface Db { clips: Clip[]; vaultPolicy: VaultPolicy | null; audit: AuditEntry[] }

let _db: Db | null = null;

export function db(): Db {
  if (!_db) _db = existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, "utf8")) : { clips: [], vaultPolicy: null, audit: [] };
  return _db!;
}

export function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db(), null, 2));
}

export function audit(who: string, what: string, detail: string) {
  db().audit.unshift({ at: Date.now(), who, what, detail });
  db().audit.length = Math.min(db().audit.length, 500);
}
