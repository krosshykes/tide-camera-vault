// Motion-triggered recording for the live camera, entirely in the browser.
//
// Frame differencing on a tiny 64x36 greyscale copy of the feed, ~5 times a second: the share of
// pixels whose brightness changed by more than PIXEL_DELTA is the "motion level". Above the
// threshold set by the sensitivity slider, recording starts; after QUIET_MS without motion (or at
// MAX_MS) it stops and hands the clip back, to be encrypted and uploaded like any other event.
// The motion check never leaves this device.
import { startRecording, type Recording } from "./live";

const SW = 64;
const SH = 36;
const SAMPLE_MS = 200;
const PIXEL_DELTA = 28; // brightness change (0-255) that counts as a changed pixel
const WARMUP_MS = 1500; // cameras auto-adjust exposure when they start
const QUIET_MS = 2000; // stop after this long without motion
const MAX_MS = 15000; // cap clip length (keeps uploads around 1 MB)
const MIN_MS = 1500; // never upload a clip shorter than this
const COOLDOWN_MS = 3000; // wait before the next trigger

export type MotionState = "warming" | "watching" | "recording" | "cooldown";

export interface MotionEvents {
  onLevel(level: number, threshold: number): void; // 0..1 share of changed pixels
  onState(state: MotionState, recordingMs?: number): void;
  onClip(media: { bytes: Uint8Array; mime: string }, seconds: number): void;
  onError(e: unknown): void;
}

/** sensitivity 1..100 -> share of pixels that must change. 50 -> 5%, 90 -> 1%, 10 -> 9%. */
export const thresholdFor = (sensitivity: number) => Math.max(0.005, (101 - sensitivity) / 1000);

export function watchMotion(video: HTMLVideoElement, camera: string, getSensitivity: () => number, ev: MotionEvents) {
  const c = document.createElement("canvas");
  c.width = SW; c.height = SH;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  let prev: Uint8ClampedArray | null = null;
  const armedAt = performance.now();
  let rec: Recording | null = null;
  let lastMotion = 0;
  let cooldownUntil = 0;
  let stopped = false;

  function level(): number {
    if (!video.videoWidth) return 0;
    g.drawImage(video, 0, 0, SW, SH);
    const px = g.getImageData(0, 0, SW, SH).data;
    const grey = new Uint8ClampedArray(SW * SH);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) grey[j] = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10;
    let changed = 0;
    if (prev) for (let j = 0; j < grey.length; j++) if (Math.abs(grey[j] - prev[j]) > PIXEL_DELTA) changed++;
    prev = grey;
    return changed / grey.length;
  }

  async function finish(now: number) {
    const r = rec!;
    rec = null;
    cooldownUntil = now + COOLDOWN_MS;
    ev.onState("cooldown");
    const ms = now - r.startedAt;
    try {
      const media = await r.stop();
      if (ms >= MIN_MS) ev.onClip(media, Math.round(ms / 100) / 10);
    } catch (e) { ev.onError(e); }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    const lv = level();
    const threshold = thresholdFor(getSensitivity());
    ev.onLevel(lv, threshold);
    if (now - armedAt < WARMUP_MS) { ev.onState("warming"); return; }
    const moving = lv >= threshold;
    if (moving) lastMotion = now;

    if (rec) {
      const ms = now - rec.startedAt;
      ev.onState("recording", ms);
      if (now - lastMotion >= QUIET_MS || ms >= MAX_MS) void finish(now);
    } else if (now < cooldownUntil) {
      ev.onState("cooldown");
    } else if (moving) {
      try { rec = startRecording(video, camera); ev.onState("recording", 0); }
      catch (e) { ev.onError(e); }
    } else {
      ev.onState("watching");
    }
  }, SAMPLE_MS);

  return {
    /** Disarm. A recording in progress is still finished and handed over. */
    stop() {
      clearInterval(timer);
      if (rec) void finish(performance.now());
      stopped = true;
    },
  };
}
