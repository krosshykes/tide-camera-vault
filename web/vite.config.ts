import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolveDpopAuthRequest, expectationsFromConfig } from "@tidecloak/js/dpop-server";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const REGISTRY = join(ROOT, "server", "data", "households.json");

// Every household is its own realm, so the DPoP relay page must accept any registered realm's
// issuer + client, and nothing else. Read fresh on each request: new households appear at runtime.
function adapters(): object[] {
  const paths = [resolve(__dirname, "public/tidecloak.json")];
  if (existsSync(REGISTRY)) {
    for (const h of JSON.parse(readFileSync(REGISTRY, "utf8")) as { adapterPath: string }[]) {
      paths.push(isAbsolute(h.adapterPath) ? h.adapterPath : join(ROOT, h.adapterPath));
    }
  }
  return [...new Set(paths)].filter(existsSync).map((p) => JSON.parse(readFileSync(p, "utf8")));
}

type Res = { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void };
type Server = { middlewares: { use: (fn: (req: { url?: string; method?: string }, res: Res, next: () => void) => void) => void } };

// The SDK's resolver serves /tide_dpop/* -> tide_dpop_auth.html with its own CSP + Allow-CSP-From,
// and rejects an issuer/client it wasn't told to expect. We just try each household's.
function tideDpopMultiRealm(): Plugin {
  const install = (server: Server) => {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/tide_dpop/")) return next();
      let fallback: ReturnType<typeof resolveDpopAuthRequest> = null;
      for (const a of adapters()) {
        const { issuer, client } = expectationsFromConfig(a);
        const r = resolveDpopAuthRequest({ pathname: req.url, expectedIssuer: issuer, expectedClient: client, method: req.method });
        if (!r) continue;
        if (r.status === 200) { fallback = r; break; }
        fallback ??= r;
      }
      if (!fallback) return next();
      res.statusCode = fallback.status;
      for (const [k, v] of Object.entries(fallback.headers)) res.setHeader(k, String(v));
      res.end(fallback.body ?? "");
    });
  };
  return { name: "tide-dpop-multi-realm", configureServer: install, configurePreviewServer: install };
}

// Tide SWE iframe re-homing needs frames from anywhere (same rule as the pack's next.config.ts).
function frameSrc(): Plugin {
  // Block body on purpose: a function returned from configureServer is run by Vite as a post hook.
  const install = (server: Server) => {
    server.middlewares.use((_req, res, next) => { res.setHeader("Content-Security-Policy", "frame-src 'self' *"); next(); });
  };
  return { name: "tide-frame-src", configureServer: install, configurePreviewServer: install };
}

export default defineConfig({
  // The DPoP page handler ends its own response, so frameSrc never touches that page's CSP.
  plugins: [tideDpopMultiRealm(), frameSrc(), react()],
  server: { port: 5173, strictPort: true, proxy: { "/api": { target: "http://localhost:4000", xfwd: true } } },
  preview: { port: 5173, strictPort: true, proxy: { "/api": { target: "http://localhost:4000", xfwd: true } } },
});
