import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ADAPTER_PATH = join(ROOT, "web", "public", "tidecloak.json");
export const DATA_DIR = join(ROOT, "server", "data");
export const DB_PATH = join(DATA_DIR, "db.json");
export const STATE_PATH = join(DATA_DIR, "realm-state.json");
