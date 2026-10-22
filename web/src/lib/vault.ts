// The household vault: one RelationshipAttestation:1 policy, signed once by an owner in the
// Tide enclave, whose subject is the ROLE household-viewer. Every clip key is tagged with the
// vault's record id and wrapped by the Tide network under that policy. The network will only
// unwrap it for a caller who holds household-viewer AND _tide_decryptor - checked on every ORK,
// every time. Nobody holds a key that can skip that check: not CamCo, not this server.
import { api, tideConfig, type VaultPolicy } from "./api";
import { unb64 } from "./crypto";
import { signRelationshipPolicy, encryptForRecord, decryptForRecord } from "./tide/relationship";

export const VAULT_RECORD_ID = "household-vault";
export const VAULT_ROLE = "household-viewer";

let cachedPolicy: VaultPolicy | null = null;

export async function vaultPolicy(): Promise<VaultPolicy> {
  if (!cachedPolicy) cachedPolicy = await api<VaultPolicy>("/api/vault/policy");
  return cachedPolicy;
}

/** Owner-only, once: opens the Tide enclave; the owner's approval IS the grant of the vault to the role. */
export async function signVaultPolicy(): Promise<void> {
  const { policy: adminPolicyB64 } = await api<{ policy: string }>("/api/admin-policy");
  const signed = await signRelationshipPolicy(
    { vendorId: tideConfig.vendorId, subject: { type: "Role", id: VAULT_ROLE }, recordId: VAULT_RECORD_ID, access: "read-write" },
    unb64(adminPolicyB64),
  );
  await api("/api/vault/policy", { method: "PUT", body: JSON.stringify({ policy: signed, recordId: VAULT_RECORD_ID }) });
  cachedPolicy = null;
}

/** Wrap a clip key. The record id is the ONLY tag (AP-RA03). */
export async function wrapKey(rawKeyB64: string, policy: VaultPolicy): Promise<string> {
  return encryptForRecord(rawKeyB64, policy.recordId, policy.policy);
}

export async function unwrapKey(wrappedKey: string, policy: VaultPolicy): Promise<string> {
  return decryptForRecord(wrappedKey, policy.recordId, policy.policy);
}

/**
 * A contract refusal arrives as TIDE-TIDEJS-NET-THRESHOLD_FAILURE ("Could not reach enough VVK
 * ORKs"). It is not an outage: every ORK answered no, and the reason is in `cause` (AP-RA18).
 */
export function explainTideError(e: unknown): { refused: boolean; summary: string; detail: string } {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 6; i++) {
    if (cur instanceof Error) { parts.push(cur.message); cur = (cur as Error & { cause?: unknown }).cause; }
    else { parts.push(typeof cur === "string" ? cur : JSON.stringify(cur)); break; }
  }
  const detail = parts.join("\n  caused by: ");
  const reasons = [
    "role not found", "not found in doken", "subjectId does not match", "Tags do not contain assignmentId",
    "not found in list of roles", "_tide_decryptor", "_tide_encryptor", "THRESHOLD_FAILURE",
  ];
  const refused = reasons.some((r) => detail.includes(r));
  const summary = refused
    ? "The Tide network refused: this identity is not allowed to open the household vault."
    : "Tide request failed.";
  return { refused, summary, detail };
}
