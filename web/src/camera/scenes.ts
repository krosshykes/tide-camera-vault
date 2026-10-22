// Synthetic camera feeds, drawn on a canvas. No real cameras, no real footage, nothing to ship.
// Each scene renders a CCTV-style frame (grain, timestamp, camera name) with one moving subject.

export interface Scene {
  id: string;
  camera: string;
  label: string;
  night: boolean;
  draw: (g: CanvasRenderingContext2D, t: number, w: number, h: number) => void;
}

const W = 480;
const H = 270;

function ground(g: CanvasRenderingContext2D, w: number, h: number, night: boolean, sky: string, floor: string) {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, night ? "#0b1220" : sky);
  grad.addColorStop(0.55, night ? "#111a2b" : sky);
  grad.addColorStop(0.56, night ? "#151c14" : floor);
  grad.addColorStop(1, night ? "#0d120c" : floor);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
}

function person(g: CanvasRenderingContext2D, x: number, y: number, s: number, coat: string) {
  g.fillStyle = "#e0b48a";
  g.beginPath(); g.arc(x, y - 52 * s, 9 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = coat;
  g.fillRect(x - 11 * s, y - 42 * s, 22 * s, 30 * s);
  g.fillStyle = "#2b2f3a";
  g.fillRect(x - 10 * s, y - 12 * s, 8 * s, 14 * s);
  g.fillRect(x + 2 * s, y - 12 * s, 8 * s, 14 * s);
}

export const SCENES: Scene[] = [
  {
    id: "front-door-parcel", camera: "Front Door", label: "Person at door — parcel delivered", night: false,
    draw(g, t, w, h) {
      ground(g, w, h, false, "#9fb7c9", "#6d7a5a");
      g.fillStyle = "#b9a58c"; g.fillRect(w * 0.55, h * 0.18, w * 0.32, h * 0.62); // house wall
      g.fillStyle = "#5a3b28"; g.fillRect(w * 0.64, h * 0.32, w * 0.12, h * 0.48); // door
      g.fillStyle = "#d9c27a"; g.beginPath(); g.arc(w * 0.74, h * 0.57, 3, 0, Math.PI * 2); g.fill();
      const x = w * 0.2 + Math.min(t, 0.7) * w * 0.5;
      person(g, x, h * 0.82, 1.1, "#c0392b");
      g.fillStyle = "#a47a4c"; g.fillRect(t > 0.7 ? w * 0.6 : x + 6, t > 0.7 ? h * 0.76 : h * 0.62, 26, 18); // parcel
    },
  },
  {
    id: "driveway-car", camera: "Driveway", label: "Vehicle arriving", night: false,
    draw(g, t, w, h) {
      ground(g, w, h, false, "#b6c8d6", "#6b6b6b");
      g.fillStyle = "#4b4b4b"; g.beginPath(); g.moveTo(w * 0.35, h * 0.56); g.lineTo(w * 0.65, h * 0.56); g.lineTo(w, h); g.lineTo(0, h); g.fill();
      const s = 0.5 + t * 0.9;
      const cx = w * 0.5, cy = h * (0.6 + t * 0.25);
      g.fillStyle = "#2e5c8a"; g.fillRect(cx - 60 * s, cy - 30 * s, 120 * s, 40 * s);
      g.fillStyle = "#9ec3e6"; g.fillRect(cx - 40 * s, cy - 48 * s, 80 * s, 20 * s);
      g.fillStyle = "#fff7c2"; g.fillRect(cx - 55 * s, cy - 18 * s, 14 * s, 8 * s); g.fillRect(cx + 41 * s, cy - 18 * s, 14 * s, 8 * s);
    },
  },
  {
    id: "backyard-cat", camera: "Back Yard", label: "Animal detected", night: false,
    draw(g, t, w, h) {
      ground(g, w, h, false, "#a9c3a0", "#4f7a3a");
      g.fillStyle = "#7a5a3a"; for (let i = 0; i < 9; i++) g.fillRect(i * w / 8, h * 0.3, 10, h * 0.28); // fence posts
      g.fillRect(0, h * 0.36, w, 8); g.fillRect(0, h * 0.5, w, 8);
      const x = w * (0.1 + t * 0.75), y = h * 0.8 + Math.sin(t * 20) * 3;
      g.fillStyle = "#e08a2e"; g.beginPath(); g.ellipse(x, y, 22, 11, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(x + 22, y - 9, 9, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#e08a2e"; g.lineWidth = 4; g.beginPath(); g.moveTo(x - 20, y); g.quadraticCurveTo(x - 36, y - 20, x - 30, y - 30); g.stroke();
    },
  },
  {
    id: "front-door-night", camera: "Front Door", label: "Motion at night", night: true,
    draw(g, t, w, h) {
      ground(g, w, h, true, "", "");
      g.fillStyle = "#2a2a2a"; g.fillRect(w * 0.55, h * 0.18, w * 0.32, h * 0.62);
      g.fillStyle = "#1a120c"; g.fillRect(w * 0.64, h * 0.32, w * 0.12, h * 0.48);
      const lamp = g.createRadialGradient(w * 0.6, h * 0.25, 2, w * 0.6, h * 0.25, 140);
      lamp.addColorStop(0, "rgba(255,230,160,0.55)"); lamp.addColorStop(1, "rgba(255,230,160,0)");
      g.fillStyle = lamp; g.fillRect(0, 0, w, h);
      person(g, w * (0.95 - t * 0.45), h * 0.82, 1.05, "#20303f");
    },
  },
];

function overlay(g: CanvasRenderingContext2D, scene: Scene, at: Date, w: number, h: number) {
  // sensor grain
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * (scene.night ? 46 : 22);
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    if (scene.night) { const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3; img.data[i] = l * 0.7; img.data[i + 1] = l * 1.05; img.data[i + 2] = l * 0.7; }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(0, 0, w, 22); g.fillRect(0, h - 22, w, 22);
  g.fillStyle = "#e8eef5"; g.font = "bold 12px ui-monospace, Consolas, monospace";
  g.fillText(`● REC  ${scene.camera.toUpperCase()}  CAM`, 8, 15);
  g.fillText(at.toISOString().replace("T", " ").slice(0, 19), w - 150, 15);
  g.fillText(`SYNTHETIC FEED · ${scene.label}`, 8, h - 7);
}

function canvas() {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  return c;
}

export async function snapshot(scene: Scene): Promise<{ bytes: Uint8Array; mime: string }> {
  const c = canvas();
  const g = c.getContext("2d", { willReadFrequently: true })!;
  scene.draw(g, 0.55, W, H);
  overlay(g, scene, new Date(), W, H);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" };
}

/** A real 3-second WebM clip recorded from the canvas. */
export async function recordClip(scene: Scene, seconds = 3): Promise<{ bytes: Uint8Array; mime: string }> {
  const c = canvas();
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const rec = new MediaRecorder(c.captureStream(15), { mimeType: mime, videoBitsPerSecond: 400_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  const start = performance.now();
  rec.start();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const t = (performance.now() - start) / (seconds * 1000);
      if (t >= 1) { rec.stop(); resolve(); return; }
      scene.draw(g, t, W, H);
      overlay(g, scene, new Date(), W, H);
      requestAnimationFrame(frame);
    };
    frame();
  });
  await done;
  const blob = new Blob(chunks, { type: "video/webm" });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "video/webm" };
}
