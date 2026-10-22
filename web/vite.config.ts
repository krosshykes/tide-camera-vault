import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { tideDpopPlugin } from "@tidecloak/js/vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Adapter JSON written by scripts/bootstrap.mjs. Lets the DPoP plugin check issuer + client.
const adapterPath = resolve(__dirname, "public/tidecloak.json");
const tidecloak = existsSync(adapterPath) ? JSON.parse(readFileSync(adapterPath, "utf8")) : undefined;

// Tide SWE iframe re-homing needs frames from anywhere (same rule as the pack's next.config.ts).
function frameSrc(): Plugin {
  // Block body on purpose: a function returned from configureServer is run by Vite as a post hook.
  const install = (server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((_req, res, next) => { res.setHeader("Content-Security-Policy", "frame-src 'self' *"); next(); });
  };
  return { name: "tide-frame-src", configureServer: install, configurePreviewServer: install };
}

export default defineConfig({
  // tideDpopPlugin serves /tide_dpop/* -> tide_dpop_auth.html with its own CSP + Allow-CSP-From.
  // It must run before frameSrc so its CSP is the one on that page.
  plugins: [tideDpopPlugin({ config: tidecloak }), frameSrc(), react()],
  server: { port: 5173, strictPort: true, proxy: { "/api": { target: "http://localhost:4000", xfwd: true } } },
  preview: { port: 5173, strictPort: true, proxy: { "/api": { target: "http://localhost:4000", xfwd: true } } },
});
