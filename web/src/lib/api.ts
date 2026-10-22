// Calls to our backend and to TideCloak, always through IAMService.secureFetch so the
// DPoP-bound token goes out with its proof. Never set Authorization yourself.
import { IAMService } from "@tidecloak/js";
import tcConfig from "../../public/tidecloak.json";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown) { super(message); }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await IAMService.secureFetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = (body as { error?: string; errorMessage?: string })?.error ?? (body as { errorMessage?: string })?.errorMessage ?? res.statusText;
    throw new ApiError(res.status, `${res.status} ${msg}`, body);
  }
  return body as T;
}

export const api = <T>(path: string, init?: RequestInit) => call<T>(new URL(path, window.location.origin).toString(), init);

// Browser -> TideCloak admin API, with the signed-in owner's own token (AP-89: never proxied).
const tcAdminBase = `${String(tcConfig["auth-server-url"]).replace(/\/+$/, "")}/admin/realms/${tcConfig.realm}`;
export const tcAdmin = <T>(path: string, init?: RequestInit) => call<T>(`${tcAdminBase}${path}`, init);

export const tideConfig = tcConfig as unknown as { realm: string; resource: string; vendorId: string; "auth-server-url": string };

export interface Me {
  username: string;
  realmRoles: string[];
  isOwner: boolean;
  isHousehold: boolean;
  isVendor: boolean;
  canDecrypt: boolean;
}

export interface ClipMeta {
  id: string;
  camera: string;
  label: string;
  mime: string;
  capturedAt: number;
  uploadedBy: string;
  bytes: number;
}
export interface Clip extends ClipMeta { iv: string; ciphertext: string; wrappedKey: string }
export interface VaultPolicy { policy: string; recordId: string; signedBy: string; signedAt: number }
