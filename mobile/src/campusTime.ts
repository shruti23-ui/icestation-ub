// Campus time: UB North Campus is in New York (US Eastern). Every clock and timestamp in the app is shown in
// Eastern time, whatever timezone the phone is set to. The offset is computed from the fixed US DST rules
// (since 2007: 2nd Sunday of March 02:00 local -> 1st Sunday of November 02:00 local), so it doesn't depend
// on the device timezone or on Intl timeZone support in the JS engine.
import { useEffect, useState } from "react";
import { AppState } from "react-native";

export const CAMPUS_TZ = "America/New_York";

/** UTC instant of the nth Sunday of a month at a given UTC hour. */
function nthSundayUtc(year: number, month: number, n: number, utcHour: number): number {
  const first = new Date(Date.UTC(year, month, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return Date.UTC(year, month, firstSunday + 7 * (n - 1), utcHour);
}

/** Eastern offset from UTC in minutes for an instant: -240 (EDT) or -300 (EST). */
export function easternOffsetMinutes(at: Date): number {
  const y = at.getUTCFullYear();
  const dstStart = nthSundayUtc(y, 2, 2, 7);   // 2:00 EST = 07:00 UTC, 2nd Sunday in March
  const dstEnd = nthSundayUtc(y, 10, 1, 6);    // 2:00 EDT = 06:00 UTC, 1st Sunday in November
  const t = at.getTime();
  return t >= dstStart && t < dstEnd ? -240 : -300;
}

export interface CampusClock {
  /** "13:05" (24 h), for APIs and arithmetic */ hhmm: string;
  /** "1:05 PM" */ label: string;
  /** "EST" or "EDT" */ zone: "EST" | "EDT";
  hours: number; minutes: number;
}

export function campusClock(at: Date = new Date()): CampusClock {
  const offset = easternOffsetMinutes(at);
  const local = new Date(at.getTime() + offset * 60_000);   // read with getUTC* to get Eastern wall time
  const hours = local.getUTCHours(), minutes = local.getUTCMinutes();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    hhmm: `${pad(hours)}:${pad(minutes)}`,
    label: `${((hours + 11) % 12) + 1}:${pad(minutes)} ${hours < 12 ? "AM" : "PM"}`,
    zone: offset === -240 ? "EDT" : "EST",
    hours, minutes,
  };
}

/** Format an ISO timestamp (UTC, from the API) as Eastern wall time: "1:05 PM". */
export function campusTimeLabel(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : campusClock(d).label;
}

/** Live campus clock that updates on each minute boundary and when the app returns to the foreground. */
export function useCampusClock(): CampusClock {
  const [clock, setClock] = useState(() => campusClock());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setClock(campusClock());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);  // next minute boundary
    };
    tick();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") { clearTimeout(timer); tick(); } });
    return () => { clearTimeout(timer); sub.remove(); };
  }, []);
  return clock;
}
