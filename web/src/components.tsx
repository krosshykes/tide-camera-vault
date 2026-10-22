import { useEffect, useState } from "react";
import { formatWhen } from "./lib/time";

export type StepState = "pending" | "running" | "ok" | "fail";
export interface Step { label: string; state: StepState; note?: string }

/** A narrated pipeline, so a viewer can follow each security step as it happens. */
export function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i} className={`step ${s.state}`}>
          <span className="step-icon">{s.state === "ok" ? "✓" : s.state === "fail" ? "✕" : s.state === "running" ? "…" : "○"}</span>
          <span>
            {s.label}
            {s.note && <span className="step-note">{s.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Small helper: run a list of labelled async steps, updating UI state as each one finishes. */
export function useSteps() {
  const [steps, setSteps] = useState<Step[]>([]);
  async function run<T>(plan: string[], body: (step: (i: number, note?: string) => void) => Promise<T>): Promise<T> {
    setSteps(plan.map((label, i) => ({ label, state: i === 0 ? "running" : "pending" })));
    let current = 0;
    const step = (i: number, note?: string) => {
      current = i + 1;
      setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, state: "ok", note: note ?? s.note } : j === i + 1 ? { ...s, state: "running" } : s)));
    };
    try {
      return await body(step);
    } catch (e) {
      setSteps((prev) => prev.map((s, j) => (j === current ? { ...s, state: "fail" } : j > current ? { ...s, state: "pending" } : s)));
      throw e;
    }
  }
  return { steps, run, reset: () => setSteps([]) };
}

export function Media({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);
  if (!url) return null;
  return mime.startsWith("video/") ? <video className="media" src={url} controls autoPlay loop muted /> : <img className="media" src={url} alt="Decrypted footage" />;
}

export const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
// Always in the household's timezone (lib/time.ts), not whatever this device is set to.
export const when = (t: number) => formatWhen(t);

export function ErrorBox({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="error-box">
      <strong>{title}</strong>
      {detail && <pre>{detail}</pre>}
    </div>
  );
}
