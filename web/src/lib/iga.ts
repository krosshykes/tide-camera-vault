// Quorum approvals, straight from the owner's browser to TideCloak with the owner's own token.
// Same two-call flow as TideCloak's own admin console:
//   1. POST /iga/change-requests/{id}/approve {}            -> mode "recorded" (done) or "needs-approval"
//   2. sign requestModel in the Tide enclave (popup)
//   3. POST /iga/change-requests/{id}/approve {requestModel}  -> records it; commits at quorum
import { IAMService } from "@tidecloak/js";
import { tcAdmin } from "./api";
import { b64, unb64 } from "./crypto";

export interface ChangeRequest {
  id: string;
  entityType: string;
  entityId: string;
  actionType: string;
  status: string;
  requestedBy?: string;
  createdAt?: number;
  authorizationCount?: number;
  authorizers?: { username: string; timestamp: number }[];
  threshold?: number;
  readyToCommit?: boolean;
  rows?: unknown;
}

interface ApproveReply {
  mode: "recorded" | "needs-approval";
  requestModel?: string;
  committed?: boolean;
  authCount?: number;
  threshold?: number;
  status?: string;
  crStatus?: string;
}

interface ApprovalClient {
  requestTideOperatorApproval(r: { id: string; request: Uint8Array }[]): Promise<{ id: string; request: Uint8Array; status: string }[]>;
}

export const listPending = () => tcAdmin<ChangeRequest[]>("/iga/change-requests?status=PENDING");
export const getChangeRequest = (id: string) => tcAdmin<ChangeRequest>(`/iga/change-requests/${id}`);
export const denyChangeRequest = (id: string) => tcAdmin(`/iga/change-requests/${id}/deny`, { method: "POST", body: "{}" });

/** Count approvals from authorizationCount; fall back to readyToCommit, never to 0. */
export function tally(cr: ChangeRequest): { have: number | null; need: number } {
  const need = Math.max(1, cr.threshold ?? 1);
  if (typeof cr.authorizationCount === "number") return { have: cr.authorizationCount, need };
  if (Array.isArray(cr.authorizers)) return { have: cr.authorizers.length, need };
  return { have: cr.readyToCommit ? need : null, need };
}

export async function approveChangeRequest(id: string): Promise<{ committed: boolean; status: string; cancelled: boolean }> {
  const first = await tcAdmin<ApproveReply>(`/iga/change-requests/${id}/approve`, { method: "POST", body: "{}" });
  if (first.mode === "recorded") {
    const cr = await getChangeRequest(id);
    return { committed: first.committed ?? cr.status === "APPROVED", status: first.crStatus ?? cr.status, cancelled: false };
  }
  const tc = (IAMService as unknown as { _tc: ApprovalClient | null })._tc;
  if (!tc) throw new Error("TideCloak is not initialised");
  const [signed] = await tc.requestTideOperatorApproval([{ id, request: unb64(first.requestModel ?? "") }]);
  if (!signed || signed.status !== "approved") {
    const cr = await getChangeRequest(id);
    return { committed: false, status: cr.status, cancelled: true };
  }
  const second = await tcAdmin<ApproveReply>(`/iga/change-requests/${id}/approve`, {
    method: "POST", body: JSON.stringify({ requestModel: b64(signed.request) }),
  });
  const cr = await getChangeRequest(id);
  return { committed: second.committed ?? cr.status === "APPROVED", status: second.crStatus ?? cr.status, cancelled: false };
}

export interface Directory { users: Record<string, string>; roles: Record<string, string> }

/** Human description of a change request, using our directory of user and role ids. */
export function describe(cr: ChangeRequest, dir: Directory): string {
  const who = dir.users[cr.entityId] ?? cr.entityId;
  const rows = Array.isArray(cr.rows) ? (cr.rows as Record<string, string>[]) : [];
  const roles = rows.map((r) => dir.roles[r.ROLE_ID] ?? r.ROLE_ID).filter(Boolean);
  const roleText = roles.join(" + ");
  if (cr.actionType === "ADD_COMPOSITE") {
    // rows name role ids; whichever isn't the parent is the role being added into it
    const parent = dir.roles[cr.entityId] ?? cr.entityId;
    const ids = rows.flatMap((r) => Object.values(r)).filter((v) => dir.roles[v] && v !== cr.entityId);
    return `Make every ${parent} also hold ${ids.map((v) => dir.roles[v]).join(" + ") || "another role"}`;
  }
  switch (cr.actionType) {
    case "GRANT_ROLES": return `Give ${who} ${roleText || "roles"}`;
    case "REVOKE_ROLES": return `Remove ${roleText || "roles"} from ${who}`;
    case "DELETE_USER": return `Remove ${who} from the household`;
    case "CREATE_USER": return `Add a new account: ${rows[0]?.USERNAME ?? "unknown"}`;
    case "REGEN_ADMIN_POLICY": return "Update the owners' approval policy (new quorum)";
    default: return `${cr.actionType} on ${cr.entityType} ${who}`;
  }
}
