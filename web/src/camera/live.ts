// A real camera (e.g. DroidCam's virtual webcam, or the laptop webcam) as an optional source.
// Frames are drawn onto a canvas with a CCTV-style stamp, then go through exactly the same
// pipeline: encrypted in this browser before anything is uploaded.
// getUserMedia needs a secure context; http://localhost counts as one.

import { cameraStamp } from "../lib/time";

const W = 640;
const H = 360;

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export async function openCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    // No resolution constraints: DroidCam's free tier only offers 640x480, and some virtual
    // cameras fail to start when asked for more.
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false,
  });
}

function stamp(g: CanvasRenderingContext2D, camera: string) {
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(0, 0, W, 24);
  g.fillStyle = "#e8eef5";
  g.font = "bold 13px ui-monospace, Consolas, monospace";
  g.fillText(`● LIVE  ${camera.toUpperCase()}`, 10, 17);
  // Burned into the footage in the household's timezone, e.g. "2026-10-23 03:04:05 AEDT".
  const t = cameraStamp();
  g.fillText(t, W - 10 - g.measureText(t).width, 17);
}

// Letterbox the video into 640x360 so file sizes stay small whatever the camera resolution.
function drawFrame(g: CanvasRenderingContext2D, video: HTMLVideoElement, camera: string) {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  const scale = Math.min(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale;
  g.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
  stamp(g, camera);
}

function canvas() {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  return c;
}

export async function liveSnapshot(video: HTMLVideoElement, camera: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const c = canvas();
  drawFrame(c.getContext("2d")!, video, camera);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
}

export interface Recording { stop(): Promise<{ bytes: Uint8Array; mime: string }>; startedAt: number }

/** Start recording the stamped feed. Used by the manual 3s clip and by motion detection. */
export function startRecording(video: HTMLVideoElement, camera: string): Recording {
  const c = canvas();
  const g = c.getContext("2d")!;
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const rec = new MediaRecorder(c.captureStream(15), { mimeType: mime, videoBitsPerSecond: 600_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  let running = true;
  // setInterval rather than requestAnimationFrame, so recording continues if the tab loses focus.
  drawFrame(g, video, camera);
  const timer = setInterval(() => { if (running) drawFrame(g, video, camera); }, 1000 / 15);
  rec.start(500);
  return {
    startedAt: performance.now(),
    async stop() {
      running = false;
      clearInterval(timer);
      if (rec.state !== "inactive") rec.stop();
      await done;
      return { bytes: new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer()), mime: "video/webm" };
    },
  };
}

export async function liveClip(video: HTMLVideoElement, camera: string, seconds = 3): Promise<{ bytes: Uint8Array; mime: string }> {
  const r = startRecording(video, camera);
  await new Promise((res) => setTimeout(res, seconds * 1000));
  return r.stop();
}
