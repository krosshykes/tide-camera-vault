// The household's own copy of its footage, so CamCo's cloud is never the only one.
//
// Every clip is ciphertext + IV + a Tide-wrapped key: safe to keep anywhere, because nothing in it
// opens without the household's Tide-governed key. Two places, both under the household's control:
//   1. this device (IndexedDB), on by default, written BEFORE the upload, so an outage loses nothing;
//   2. optionally a folder the household picks: a USB drive, a NAS share (File System Access API,
//      Chromium browsers), one `.camvault.json` file per clip.
// If CamCo's copy disappears without the household deleting it, the app notices and restores it.

export interface LocalClip {
  id: string;
  household: string;
  cameraId?: string;
  camera: string;
  label: string;
  mime: string;
  capturedAt: number;
  uploadedBy: string;
  bytes: number;
  iv: string;
  ciphertext: string;
  wrappedKey: string;
  savedAt: number;
  inCloud: boolean; // last known: does CamCo's cloud hold it?
}

// --- IndexedDB ------------------------------------------------------------------------------------

let dbp: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("camvault", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const clips = d.createObjectStore("clips", { keyPath: "id" });
      clips.createIndex("household", "household");
      d.createObjectStore("kv", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return idb().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  }));
}

export const putClip = (c: LocalClip) => tx("clips", "readwrite", (s) => s.put(c));
export const getClip = (id: string) => tx<LocalClip>("clips", "readonly", (s) => s.get(id));
export const listClips = async (household: string) =>
  ((await tx<LocalClip[]>("clips", "readonly", (s) => s.index("household").getAll(household))) ?? []).sort((a, b) => b.capturedAt - a.capturedAt);
export async function deleteClips(ids: string[]) {
  if (ids.length) await tx("clips", "readwrite", (s) => { for (const id of ids) s.delete(id); });
}
export async function markInCloud(id: string, inCloud: boolean) {
  const c = await getClip(id);
  if (c && c.inCloud !== inCloud) await putClip({ ...c, inCloud });
}

const kvGet = async <T,>(key: string) => (await tx<{ key: string; value: T }>("kv", "readonly", (s) => s.get(key)))?.value;
const kvSet = (key: string, value: unknown) => tx("kv", "readwrite", (s) => s.put({ key, value }));
const kvDel = (key: string) => tx("kv", "readwrite", (s) => s.delete(key));

// --- on/off for this device -----------------------------------------------------------------------

const flagKey = (household: string) => `camvault.localcopy.${household}`;
export function localCopyEnabled(household: string): boolean {
  try { return localStorage.getItem(flagKey(household)) !== "off"; } catch { return true; }
}
export function setLocalCopyEnabled(household: string, on: boolean) {
  try { localStorage.setItem(flagKey(household), on ? "on" : "off"); } catch { /* ignore */ }
}

// --- folder mirror (USB drive / NAS) --------------------------------------------------------------

type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
};

export const folderSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;
export const getFolder = (household: string) => kvGet<PermissionedHandle>(`folder.${household}`);
export const forgetFolder = (household: string) => kvDel(`folder.${household}`);

export async function chooseFolder(household: string): Promise<FileSystemDirectoryHandle> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  const handle = await pick({ mode: "readwrite", id: "camvault" });
  await kvSet(`folder.${household}`, handle);
  return handle;
}

/** Browsers forget folder permission between visits; asking again needs a click. */
export async function folderReady(handle: PermissionedHandle, ask: boolean): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return ask && !!handle.requestPermission && (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

const fileName = (c: LocalClip) =>
  `${new Date(c.capturedAt).toISOString().replace(/[:.]/g, "-")}_${c.camera.replace(/[^a-z0-9]+/gi, "-")}_${c.id.slice(0, 8)}.camvault.json`;

export async function writeToFolder(handle: FileSystemDirectoryHandle, c: LocalClip) {
  const file = await handle.getFileHandle(fileName(c), { create: true });
  const w = await file.createWritable();
  // Only ciphertext, its IV and the Tide-wrapped key: useless to anyone who finds the drive.
  const { household, id, cameraId, camera, label, mime, capturedAt, uploadedBy, bytes, iv, ciphertext, wrappedKey } = c;
  await w.write(JSON.stringify({ format: "camvault-clip/1", household, id, cameraId, camera, label, mime, capturedAt, uploadedBy, bytes, iv, ciphertext, wrappedKey }));
  await w.close();
}

/** Save the household's copy: this device always (if on), the folder if one is set and permitted. */
export async function saveHouseholdCopy(c: LocalClip): Promise<{ device: boolean; folder: "written" | "none" | "needs-permission" | "failed" }> {
  let device = false;
  if (localCopyEnabled(c.household)) { await putClip(c); device = true; }
  let folder: "written" | "none" | "needs-permission" | "failed" = "none";
  const handle = await getFolder(c.household).catch(() => undefined);
  if (handle) {
    try {
      if (await folderReady(handle, false)) { await writeToFolder(handle, c); folder = "written"; }
      else folder = "needs-permission";
    } catch { folder = "failed"; }
  }
  return { device, folder };
}
