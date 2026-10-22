// The household's timezone: every time shown in the app, and the stamp burned into camera footage,
// uses it. Owners set it (stored on CamCo's server as plain metadata). Until the household's
// setting has loaded, this device's own timezone is used.

export const deviceTimezone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

let tz = deviceTimezone();

export const timezone = () => tz;

export function setTimezone(next: string) {
  if (isValidTimezone(next)) tz = next;
}

export function isValidTimezone(name: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}

/** All IANA timezones the browser knows, for the selector. */
export function allTimezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch { /* old browser */ }
  return ["UTC", "Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Perth", "Asia/Kolkata", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles"];
}

/** "Fri 23 Oct, 3:04:05 am" in the household's timezone. */
export function formatWhen(t: number): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", second: "2-digit",
  }).format(t);
}

/** Short zone name for that moment, e.g. "AEDT" (or "GMT+11" where no abbreviation exists). */
export function zoneAbbr(t: number = Date.now()): string {
  // Each locale knows abbreviations for its own region ("AEDT" in en-AU, "EDT" in en-US);
  // use whichever gives a real one, else the GMT offset.
  let fallback = "";
  for (const locale of ["en-AU", "en-US", "en-GB", "en-IN"]) {
    const v = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "";
    if (v && !/^(GMT|UTC)[+-]/.test(v)) return v;
    fallback ||= v;
  }
  return fallback || tz;
}

/** CCTV-style stamp burned into footage: "2026-10-23 03:04:05 AEDT". */
export function cameraStamp(t: number = Date.now()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${zoneAbbr(t)}`;
}

/** "UTC+11:00" style offset for the selector's labels. */
export function offsetLabel(name: string, t: number = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "longOffset" }).formatToParts(t).find((x) => x.type === "timeZoneName");
    return (part?.value ?? "GMT").replace("GMT", "UTC") || "UTC";
  } catch { return ""; }
}
