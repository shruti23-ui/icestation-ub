import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Linking } from "react-native";
import { api, type ParkingSession } from "./api";
import { decide, lotAt, metersBetween, type Fix } from "./parkDetect";
import { useStore } from "./store";

const AUTO_KEY = "weparkit_auto_detect";
const LEGACY_AUTO_KEY = "icestation_auto_detect";  // pre-rename key, read once
const CAMPUS_RADIUS_M = 2500;   // farther than this from every UB lot = not on North Campus
// "Yes, I'm parked" is the student telling us they're parked, so accept the nearest UB lot this close
// even if GPS puts them just outside its outline (big lots, GPS drift, parked at the edge).
const PARKED_NEAREST_MAX_M = 400;
const FRESH_FIX_MS = 60_000;

export type ParkHereResult = { ok: true } | { ok: false; reason: string };

type Gps = "starting" | "watching" | "off" | "denied" | "unavailable";

interface Parking {
  session: ParkingSession | null;
  /** UB lot the latest GPS fix is inside (outline match with a little GPS slack). */
  hereLotId: number | null;
  /** Closest UB lot to the latest fix, and how far away it is. */
  nearest: { lotId: number; distanceM: number } | null;
  onCampus: boolean | null;
  /** Latest GPS position (for "nearest lots" sorting). */
  position: { lat: number; lng: number } | null;
  autoDetect: boolean;
  gps: Gps;
  busy: boolean;
  setAutoDetect: (on: boolean) => Promise<void>;
  checkIn: (lotId: number, source?: "manual" | "auto", at?: { lat: number; lng: number }) => Promise<void>;
  /** "Yes, I'm parked": find the UB lot from location and check in, no questions asked when possible. */
  parkHere: () => Promise<ParkHereResult>;
  locating: boolean;
  checkOut: (source?: "manual" | "auto") => Promise<void>;
}

const Ctx = createContext<Parking | null>(null);
/** Raw context for optional consumers (e.g. the header avatar); most code should use useParking(). */
export const ParkingContext = Ctx;

/** Parked / not parked. On launch it asks for location and watches it while the app is open:
 *  it shows which UB lot you're in, and auto-detect checks you in (driving -> still inside a lot)
 *  and out (driving away from your car). The buttons always work and always win. */
export function ParkingProvider({ children }: { children: ReactNode }) {
  const { user, lots, refresh, toast } = useStore();
  const [session, setSession] = useState<ParkingSession | null>(null);
  const [autoDetect, setAuto] = useState(false);
  const autoRef = useRef(false);
  autoRef.current = autoDetect;
  const [gps, setGps] = useState<Gps>("starting");
  const [hereLotId, setHere] = useState<number | null>(null);
  const [nearest, setNearest] = useState<Parking["nearest"]>(null);
  const [position, setPosition] = useState<Parking["position"]>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const fixes = useRef<Fix[]>([]);
  const lastFix = useRef<Fix | null>(null);
  const live = useRef({ session, lots, user });
  live.current = { session, lots, user };

  useEffect(() => {
    if (!user) return;
    api.session(user.id).then((r) => setSession(r.session)).catch(() => {});
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Location is the core of the main page, so ask as soon as the app opens (unless the user turned it off).
  useEffect(() => {
    (async () => {
      const saved = (await AsyncStorage.getItem(AUTO_KEY).catch(() => null)) ?? (await AsyncStorage.getItem(LEGACY_AUTO_KEY).catch(() => null));
      if (saved === "off") { setGps("off"); return; }
      const perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
      if (perm?.granted) setAuto(true);
      else setGps("denied");
    })();
  }, []);

  const checkIn = useCallback(async (lotId: number, source: "manual" | "auto" = "manual", at?: { lat: number; lng: number }) => {
    const u = live.current.user;
    if (!u) return;
    setBusy(true);
    try {
      const f = at ?? lastFix.current;
      const r = await api.checkIn({ user_id: u.id, lot_id: lotId, source, ...(f ? { lat: f.lat, lng: f.lng } : {}) });
      setSession(r.session);
      fixes.current = [];
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast(source === "auto" ? `Parked at ${r.lot.name} (detected automatically)` : `Parked at ${r.lot.name}`);
      refresh("lots");
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(false); }
  }, [refresh, toast]);

  const checkOut = useCallback(async (source: "manual" | "auto" = "manual") => {
    const u = live.current.user;
    if (!u) return;
    setBusy(true);
    try {
      const r = await api.checkOut({ user_id: u.id, source });
      setSession(null);
      fixes.current = [];
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast(`Left ${r.lot.name}. Drivers heading there were notified${r.points_awarded ? ` (+${r.points_awarded} pts)` : ""}`);
      refresh("lots", "notifications", "crew");
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(false); }
  }, [refresh, toast]);

  const parkHere = useCallback(async (): Promise<ParkHereResult> => {
    // 1. Already standing inside a lot outline: check in straight away.
    const f0 = lastFix.current;
    if (f0?.lotId != null && Date.now() - f0.t < FRESH_FIX_MS) { await checkIn(f0.lotId, "manual", f0); return { ok: true }; }
    setLocating(true);
    try {
      // 2. Get a position: a fresh fix we already have, else ask GPS now.
      let pos: { lat: number; lng: number; accuracy: number | null } | null =
        f0 && Date.now() - f0.t < FRESH_FIX_MS ? { lat: f0.lat, lng: f0.lng, accuracy: null } : null;
      if (!pos) {
        let perm = await Location.getForegroundPermissionsAsync().catch(() => null);
        if (!perm?.granted) perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
        if (!perm?.granted) return { ok: false, reason: "Location is off, so pick your lot." };
        const p = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<null>((r) => setTimeout(() => r(null), 12_000)),
        ]).catch(() => null);
        if (!p) return { ok: false, reason: "Couldn't get a GPS fix, so pick your lot." };
        pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null };
        setGps((g) => (g === "denied" || g === "starting" ? "watching" : g));
      }
      // 3. Server matcher (accuracy-aware outline match), then the nearest UB lot within reach.
      const m = await api.locate(pos.lat, pos.lng, pos.accuracy).catch(() => null);
      const pick = m?.lot?.id ?? (m?.candidates[0] && m.candidates[0].distance_m <= PARKED_NEAREST_MAX_M ? m.candidates[0].id : null);
      if (pick != null) { await checkIn(pick, "manual", pos); return { ok: true }; }
      const far = m?.candidates[0];
      return { ok: false, reason: far ? `You're ${far.distance_m >= 1000 ? `${(far.distance_m / 1000).toFixed(1)} km` : `${Math.round(far.distance_m)} m`} from the nearest UB lot (${far.name}). Pick your lot.` : "Couldn't match your location to a UB lot. Pick it." };
    } finally {
      setLocating(false);
    }
  }, [checkIn]);

  const setAutoDetect = useCallback(async (on: boolean) => {
    await AsyncStorage.setItem(AUTO_KEY, on ? "on" : "off").catch(() => {});
    if (!on) { setAuto(false); setGps("off"); return; }
    let perm = await Location.getForegroundPermissionsAsync().catch(() => null);
    if (!perm?.granted && perm?.canAskAgain !== false) perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
    if (!perm?.granted) {
      setGps("denied"); setAuto(false);
      // The OS won't show the prompt again once location was denied: send the student to Settings.
      // When they come back, the AppState listener below picks the new permission up.
      if (perm && !perm.canAskAgain) {
        toast("Location is blocked for this app. Turn it on in Settings, then come back.", "info");
        Linking.openSettings().catch(() => {});
      } else {
        toast("Location access is off. Choose your lot from the list instead.", "info");
      }
      return;
    }
    setGps("starting");
    setAuto(true);
  }, [toast]);

  // Back from Settings with location allowed? Start auto-detect without another tap.
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (st) => {
      if (st !== "active" || autoRef.current) return;
      const saved = await AsyncStorage.getItem(AUTO_KEY).catch(() => null);
      if (saved === "off") return;
      const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (perm?.granted) { setGps("starting"); setAuto(true); }
    });
    return () => sub.remove();
  }, []);

  /** Turn a GPS position into a fix, update "where am I", and (optionally) run auto check-in/out. */
  const ingest = useCallback((pos: Location.LocationObject, detect: boolean) => {
    const { lots: ls, session: s } = live.current;
    const all = ls?.lots ?? [];
    const { latitude: lat, longitude: lng } = pos.coords;
    const speed = pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed : null;
    const f: Fix = { t: pos.timestamp || Date.now(), lat, lng, speed, lotId: lotAt(lat, lng, all.map((l) => ({ id: l.id, polygon: l.polygon }))) };
    lastFix.current = f;
    setHere(f.lotId);
    setPosition((p) => (p && metersBetween(p, f) < 15 ? p : { lat: f.lat, lng: f.lng }));  // avoid re-sorting on jitter
    let best: Parking["nearest"] = null;
    for (const l of all) {
      const d = Math.min(metersBetween(f, l), ...l.polygon.map(([a, b]) => metersBetween(f, { lat: a, lng: b })));
      if (!best || d < best.distanceM) best = { lotId: l.id, distanceM: Math.round(d) };
    }
    setNearest(best);
    if (!detect) return;
    fixes.current = [...fixes.current.filter((x) => f.t - x.t <= 10 * 60_000), f];
    const car = s?.car_lat != null && s.car_lng != null ? { lat: s.car_lat, lng: s.car_lng } : s?.lot ? { lat: s.lot.lat, lng: s.lot.lng } : null;
    const d = decide(fixes.current, s?.lot?.id ?? null, car, f.t);
    if (d?.kind === "checkin") { fixes.current = []; checkIn(d.lotId, "auto"); }
    else if (d?.kind === "checkout") { fixes.current = []; checkOut("auto"); }
  }, [checkIn, checkOut]);

  // Watch GPS while auto-detect is on and the app is open. An instant cached fix fills "where am I" first.
  useEffect(() => {
    if (!autoDetect) { setHere(null); setNearest(null); return; }
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      try {
        const quick = await Location.getLastKnownPositionAsync({ maxAge: 120_000 }).catch(() => null);
        if (quick && !cancelled) ingest(quick, false);
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 4000, distanceInterval: 5 },
          (pos) => ingest(pos, true),
        );
        if (cancelled) sub.remove(); else setGps("watching");
      } catch {
        if (!cancelled) setGps("unavailable");
      }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [autoDetect, ingest]);

  // Lot outlines arrive after launch; re-evaluate the last fix once they do.
  useEffect(() => {
    const f = lastFix.current;
    if (f && lots?.lots.length) ingest({ coords: { latitude: f.lat, longitude: f.lng, speed: f.speed, accuracy: null, altitude: null, altitudeAccuracy: null, heading: null }, timestamp: f.t }, false);
  }, [lots?.lots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCampus = nearest ? nearest.distanceM <= CAMPUS_RADIUS_M : null;
  const value = useMemo<Parking>(() => ({ session, hereLotId, nearest, onCampus, position, autoDetect, gps, busy, locating, setAutoDetect, checkIn, checkOut, parkHere }),
    [session, hereLotId, nearest, onCampus, position, autoDetect, gps, busy, locating, setAutoDetect, checkIn, checkOut, parkHere]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useParking() {
  const p = useContext(Ctx);
  if (!p) throw new Error("useParking must be used inside ParkingProvider");
  return p;
}
