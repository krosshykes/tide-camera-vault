// The household timezone control in the top bar. Owners pick it; everyone sees it. Changing it
// re-renders the page (all times use it) and new camera stamps use it from the next frame.
import { useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import { allTimezones, cameraStamp, deviceTimezone, offsetLabel, setTimezone, timezone, zoneAbbr } from "./lib/time";

/** Loads the household's timezone and applies it before the app renders its times. */
export async function loadHouseholdTimezone(): Promise<string | null> {
  try {
    const s = await api<{ timezone: string | null }>("/api/settings");
    setTimezone(s.timezone ?? deviceTimezone());
    return s.timezone;
  } catch {
    setTimezone(deviceTimezone());
    return null;
  }
}

function Clock() {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <span className="mono tiny">{cameraStamp().slice(11)}</span>;
}

export function TimezoneControl({ canEdit, saved, onChange }: { canEdit: boolean; saved: string | null; onChange: (tz: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const zones = useMemo(() => allTimezones().map((z) => ({ z, label: `${z.replaceAll("_", " ")} (${offsetLabel(z)})` })), []);
  const current = timezone();

  async function choose(tz: string) {
    setErr("");
    try {
      await api("/api/settings/timezone", { method: "PUT", body: JSON.stringify({ timezone: tz }) });
      setTimezone(tz);
      onChange(tz);
      setEditing(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const title = saved ? `Household timezone: ${current}` : `No household timezone set; showing this device's (${current})`;
  return (
    <span className="tz" title={title}>
      <span aria-hidden="true">🕒</span> <Clock /> <b className="tiny">{zoneAbbr()}</b>
      {!editing && canEdit && <button className="btn ghost tz-btn" onClick={() => setEditing(true)}>{saved ? "Change" : "Set timezone"}</button>}
      {!saved && !canEdit && <span className="muted tiny">(this device)</span>}
      {editing && (
        <>
          <select className="select tz-select" autoFocus defaultValue={current} onChange={(e) => void choose(e.target.value)}>
            {zones.map(({ z, label }) => <option key={z} value={z}>{label}</option>)}
          </select>
          {deviceTimezone() !== current && <button className="btn ghost tz-btn" onClick={() => void choose(deviceTimezone())}>Use this device's</button>}
          <button className="btn ghost tz-btn" onClick={() => setEditing(false)}>Cancel</button>
        </>
      )}
      {err && <span className="tiny warn-text">{err}</span>}
    </span>
  );
}
