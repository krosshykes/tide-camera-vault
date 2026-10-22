// Token + DPoP verification for every API route. Based on the Tide pack's
// nextjs-customer-portal src/lib/auth/tideJWT.ts, adapted to Express.
import type { Request, Response, NextFunction } from "express";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { readFileSync } from "node:fs";
import { verifyDpop } from "./verifyDpop.ts";
import { ADAPTER_PATH } from "../paths.ts";

export interface TidecloakConfig {
  realm: string;
  "auth-server-url": string;
  resource: string;
  jwk: { keys: object[] };
  vendorId?: string;
}

let _config: TidecloakConfig | null = null;
let _jwks: ReturnType<typeof createLocalJWKSet> | null = null;

// Lazy: the adapter only exists once scripts/bootstrap.mjs has run.
export function tideConfig(): TidecloakConfig {
  if (!_config) {
    const config = JSON.parse(readFileSync(ADAPTER_PATH, "utf8")) as TidecloakConfig;
    if (!config.jwk) throw new Error("Adapter JSON missing jwk field. Re-export with IGA enabled.");
    _config = config;
    _jwks = createLocalJWKSet(config.jwk as Parameters<typeof createLocalJWKSet>[0]);
  }
  return _config;
}

export async function verifyTideJWT(token: string): Promise<JWTPayload> {
  const config = tideConfig();
  const { payload } = await jwtVerify(token, _jwks!, {
    issuer: `${config["auth-server-url"].replace(/\/+$/, "")}/realms/${config.realm}`,
  });
  if (payload.azp !== config.resource) throw new Error("Token azp does not match client");
  return payload;
}

export interface Caller {
  sub: string;
  username: string;
  realmRoles: string[];
  isRealmAdmin: boolean; // tide-realm-admin: a household owner
  claims: JWTPayload;
}

declare module "express-serve-static-core" {
  interface Request { caller?: Caller }
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

/** Verifies the JWT AND the DPoP proof. Never skips DPoP: every token this realm issues is bound. */
export function requireAuth(check?: (c: Caller) => boolean, why = "Forbidden") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authz = req.headers.authorization ?? "";
    if (!/^(Bearer|DPoP) /i.test(authz)) return res.status(401).json({ error: "Unauthorized" });
    const token = authz.replace(/^(Bearer|DPoP) /i, "");
    try {
      const claims = await verifyTideJWT(token);
      await verifyDpop(fetchLike(req), token, claims as { cnf?: { jkt?: string } });
      req.caller = toCaller(claims);
    } catch (e) {
      return res.status(401).json({ error: "Invalid token", detail: e instanceof Error ? e.message : String(e) });
    }
    if (check && !check(req.caller)) return res.status(403).json({ error: why });
    next();
  };
}

export const isHousehold = (c: Caller) => c.realmRoles.includes("household-viewer");
export const isOwner = (c: Caller) => c.isRealmAdmin;
