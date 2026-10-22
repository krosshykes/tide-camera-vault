// Token + DPoP verification for every API route. Based on the Tide pack's
// nextjs-customer-portal src/lib/auth/tideJWT.ts, adapted to Express and to many households:
// the token's issuer says which household's realm it claims to come from, and it is then
// verified against THAT realm's embedded key (each realm has its own key on the Tide network).
import type { Request, Response, NextFunction } from "express";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { verifyDpop } from "./verifyDpop.ts";
import { adapterOf, households, type Household } from "../households.ts";

interface Adapter { realm: string; "auth-server-url": string; resource: string; jwk: { keys: object[] } }

const verifiers = new Map<string, { issuer: string; client: string; jwks: ReturnType<typeof createLocalJWKSet> }>();

function verifierFor(h: Household) {
  if (!verifiers.has(h.id)) {
    const a = adapterOf(h) as Adapter | null;
    if (!a?.jwk) return null; // not provisioned yet
    verifiers.set(h.id, {
      issuer: `${a["auth-server-url"].replace(/\/+$/, "")}/realms/${a.realm}`,
      client: a.resource,
      jwks: createLocalJWKSet(a.jwk as Parameters<typeof createLocalJWKSet>[0]),
    });
  }
  return verifiers.get(h.id)!;
}

/** Find the household by the (still unverified) issuer, then verify against its own key. */
export async function verifyTideJWT(token: string): Promise<{ claims: JWTPayload; household: Household }> {
  const iss = decodeJwt(token).iss;
  const household = households().find((h) => verifierFor(h)?.issuer === iss);
  if (!household) throw new Error("Token is not from any known household");
  const v = verifierFor(household)!;
  const { payload } = await jwtVerify(token, v.jwks, { issuer: v.issuer });
  if (payload.azp !== v.client) throw new Error("Token azp does not match client");
  return { claims: payload, household };
}

export interface Caller {
  sub: string;
  username: string;
  realmRoles: string[];
  isRealmAdmin: boolean; // tide-realm-admin: a household owner
  claims: JWTPayload;
}

declare module "express-serve-static-core" {
  interface Request { caller?: Caller; household?: Household }
}

function toCaller(claims: JWTPayload): Caller {
  const realmRoles = ((claims.realm_access as { roles?: string[] })?.roles ?? []).map(String);
  const rm = (claims.resource_access as Record<string, { roles?: string[] }> | undefined)?.["realm-management"];
  return {
    sub: String(claims.sub),
    username: String(claims.preferred_username ?? ""),
    realmRoles,
    isRealmAdmin: !!rm?.roles?.includes("tide-realm-admin"),
    claims,
  };
}

// The URL the browser signed into the proof's `htu`. Requests arrive through the Vite proxy,
// which sets x-forwarded-host/proto, so the pack's requestHtu() rebuilds the browser's origin.
function fetchLike(req: Request) {
  const host = req.headers.host ?? "localhost";
  return {
    url: `http://${host}${req.originalUrl}`,
    method: req.method,
    headers: { get: (name: string) => { const v = req.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } },
  };
}

/** Verifies the JWT AND the DPoP proof. Never skips DPoP: every token these realms issue is bound. */
export function requireAuth(check?: (c: Caller, h: Household) => boolean, why = "Forbidden") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authz = req.headers.authorization ?? "";
    if (!/^(Bearer|DPoP) /i.test(authz)) return res.status(401).json({ error: "Unauthorized" });
    const token = authz.replace(/^(Bearer|DPoP) /i, "");
    try {
      const { claims, household } = await verifyTideJWT(token);
      await verifyDpop(fetchLike(req), token, claims as { cnf?: { jkt?: string } });
      req.caller = toCaller(claims);
      req.household = household;
    } catch (e) {
      return res.status(401).json({ error: "Invalid token", detail: e instanceof Error ? e.message : String(e) });
    }
    if (check && !check(req.caller, req.household)) return res.status(403).json({ error: why });
    next();
  };
}

export const isHousehold = (c: Caller) => c.realmRoles.includes("household-viewer");
export const isOwner = (c: Caller) => c.isRealmAdmin;
