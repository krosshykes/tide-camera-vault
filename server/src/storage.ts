// Storage for one household: usage against the plan's allowance, and the retention rule.
// Deleting ciphertext gives nobody the ability to watch anything, so it isn't quorum-governed.
// Owners set retention; CamCo's server enforces it (it can delete ciphertext, never open it).
import { db, save, audit, type Clip } from "./db.ts";
import { customerHouseholds, type Household } from "./households.ts";

export const QUOTA_BYTES = Number(process.env.STORAGE_QUOTA_MB || 500) * 1024 * 1024;
export const RETENTION_CHOICES = [7, 30, 90] as const; // days; null = keep until deleted

export const usedBytes = (h: Household) => db(h).clips.reduce((n, c) => n + c.bytes, 0);

export function storageSummary(h: Household) {
  const d = db(h);
  const perCamera = new Map<string, { camera: string; clips: number; bytes: number; snapshots: number; videos: number; newest: number }>();
  for (const c of d.clips) {
    const e = perCamera.get(c.camera) ?? { camera: c.camera, clips: 0, bytes: 0, snapshots: 0, videos: 0, newest: 0 };
    e.clips++; e.bytes += c.bytes; e.newest = Math.max(e.newest, c.capturedAt);
    if (c.mime.startsWith("video/")) e.videos++; else e.snapshots++;
    perCamera.set(c.camera, e);
  }
  const times = d.clips.map((c) => c.capturedAt);
  return {
    quotaBytes: QUOTA_BYTES,
    usedBytes: usedBytes(h),
    clips: d.clips.length,
    snapshots: d.clips.filter((c) => !c.mime.startsWith("video/")).length,
    videos: d.clips.filter((c) => c.mime.startsWith("video/")).length,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
    retentionDays: d.retentionDays ?? null,
    perCamera: [...perCamera.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/**
 * Remove clips by id; the caller has already checked permission. A household deletion or a
 * retention clean-up leaves a tombstone, so members' devices can tell it apart from footage that
 * vanished from CamCo's storage without the household asking (see /api/clips/tombstones).
 */
export function removeClips(h: Household, ids: Set<string>, tomb: { by: string; reason: string } | null): Clip[] {
  const d = db(h);
  const removed = d.clips.filter((c) => ids.has(c.id));
  d.clips = d.clips.filter((c) => !ids.has(c.id));
  if (tomb && removed.length) {
    d.tombstones = [...removed.map((c) => ({ id: c.id, at: Date.now(), by: tomb.by, reason: tomb.reason })), ...(d.tombstones ?? [])].slice(0, 5000);
  }
  return removed;
}

/** Apply the household's retention rule. Cheap; called on reads, uploads and hourly. */
export function prune(h: Household) {
  const days = db(h).retentionDays;
  if (!days) return 0;
  const cutoff = Date.now() - days * 24 * 3600_000;
  const old = new Set(db(h).clips.filter((c) => c.capturedAt < cutoff).map((c) => c.id));
  if (!old.size) return 0;
  const removed = removeClips(h, old, { by: "retention rule", reason: `older than ${days} days` });
  audit(h, "retention", "clips.pruned", `${removed.length} clip(s) older than ${days} days deleted by the retention rule`);
  save(h);
  return removed.length;
}

export function startRetentionSweep() {
  setInterval(() => { for (const h of customerHouseholds()) prune(h); }, 3600_000).unref();
}
