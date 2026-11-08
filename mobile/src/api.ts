import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { deleteAsync, EncodingType, FileSystemUploadType, readAsStringAsync, uploadAsync } from "expo-file-system/legacy";
import { Platform } from "react-native";
// Typed API client for the WeParkit FastAPI backend.
import { campusTimeLabel } from "./campusTime";
import { API_BASE as BASE } from "./config";

/** A photo picked with expo-image-picker. React Native FormData accepts {uri,name,type}. */
export interface PickedImage { uri: string; name?: string; mimeType?: string }
export type IssueKind = "vehicle" | "ice" | "water" | "cone" | "object";
export interface Issue { kind: IssueKind; label: string; box: [number, number, number, number]; score: number; detail: string }
export interface Verdict { usable: boolean; blocked: boolean; headline: string; reasons: string[] }
export interface LiveObject {
  label: string; kind: "vehicle" | "space" | "person" | "issue" | "other"; issue?: IssueKind;
  box: [number, number, number, number]; score: number | null;
}
export interface LiveDetect {
  objects: LiveObject[]; cars: number; spaces: number; is_parking_scene: boolean; scene: string;
  message: string | null; provider: string; latency_ms: number; verdict?: Verdict;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: Record<string, unknown>) { super(message); }
}

// Login token (set by src/auth.tsx). Sent as a Bearer header on every request.
let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
export const setAuthToken = (t: string | null) => { authToken = t; };
export const setOnUnauthorized = (fn: (() => void) | null) => { onUnauthorized = fn; };

// Timeouts. A GET that stalls is usually stuck on a stale pooled keep-alive connection (the server
// closed it, and some campus networks drop the reset). Fail fast and retry once: the dead connection is
// evicted after the first failure, so the retry opens a fresh one. POSTs are never retried, so a
// check-in or report can't be applied twice.
const GET_TIMEOUT_MS = 7000;
const POST_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 60000;
const UNREACHABLE = `Can't reach the backend at ${BASE}. Check it's running with --host 0.0.0.0 and the phone is online. If it never connects, the network may block phone-to-laptop traffic: use a hotspot or scripts/dev-tunnel.ps1.`;

async function attempt(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { ...(init?.headers as Record<string, string> | undefined), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) };
    return await fetch(BASE + path, { ...init, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const isGet = !init?.method || init.method.toUpperCase() === "GET";
  const timeout = init?.body instanceof FormData ? UPLOAD_TIMEOUT_MS : isGet ? GET_TIMEOUT_MS : POST_TIMEOUT_MS;
  let res: Response;
  try {
    res = await attempt(path, init, timeout);
  } catch {
    if (!isGet) throw new ApiError(0, UNREACHABLE);
    try { res = await attempt(path, init, timeout); }
    catch { throw new ApiError(0, UNREACHABLE); }
  }
  return parse<T>(path, res.status, res.ok, await res.text());
}

function parse<T>(path: string, status: number, ok: boolean, text: string): T {
  const res = { status, ok };
  let data: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { data = text ? JSON.parse(text) : {}; }
  catch { if (res.ok) throw new ApiError(res.status, `Backend returned non-JSON from ${path}`); data = { detail: text.slice(0, 200) }; }
  if (!res.ok) {
    const d = data?.detail;
    const msg = typeof d === "string" ? d
      : Array.isArray(d) ? d.map((e: { msg: string }) => e.msg).join("; ")
        : d && typeof d === "object" && typeof d.message === "string" ? d.message
          : `Request failed (${res.status})`;
    // A rejected token (expired / revoked / logged out elsewhere) signs the app out; auth screens handle their own 401s.
    if (res.status === 401 && authToken && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, msg, d && typeof d === "object" && !Array.isArray(d) ? d : undefined);
  }
  return data as T;
}

/** Photo uploads. On phones, React Native's fetch + FormData multipart is unreliable on Android ("Network request
 *  failed" before anything is sent), so native uploads go through Expo's native uploader, after shrinking the
 *  photo to 1600 px (a full-res photo is 3-6 MB; 1600 px is plenty for detection). Web uses fetch with a Blob. */
async function upload<T>(path: string, fields: Record<string, string | number | boolean | null | undefined>, image: PickedImage,
  opts: { shrink?: boolean; timeoutMs?: number; mimeType?: string } = {}): Promise<T> {
  let cleanupUri: string | null = null;   // shrunk temp copy of this upload, deleted once sent
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== "") params[k] = String(v);
  const timeoutMs = opts.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const timeout = <R,>(p: Promise<R>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), timeoutMs))]);
  try {
    if (Platform.OS === "web") {
      const fd = new FormData();
      for (const [k, v] of Object.entries(params)) fd.append(k, v);
      fd.append("file", await (await fetch(image.uri)).blob(), image.name ?? "photo.jpg");
      const res = await timeout(fetch(BASE + path, { method: "POST", body: fd, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} }));
      return parse<T>(path, res.status, res.ok, await res.text());
    }
    let uri = image.uri;
    if (opts.shrink !== false) {
      try { uri = (await manipulateAsync(uri, [{ resize: { width: 1600 } }], { compress: 0.8, format: SaveFormat.JPEG })).uri; cleanupUri = uri; }
      catch { /* send the original */ }
    }
    let first: unknown;
    try {
      const r = await Promise.race([uploadAsync(BASE + path, uri, {
        httpMethod: "POST", uploadType: FileSystemUploadType.MULTIPART, fieldName: "file", mimeType: opts.mimeType ?? "image/jpeg",
        parameters: params, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("upload timed out")), Math.min(timeoutMs, 25000)))]);
      return parse<T>(path, r.status, r.status >= 200 && r.status < 300, r.body);
    } catch (e) {
      if (e instanceof ApiError) throw e;   // the server answered (e.g. bad photo): no point retrying
      first = e;
    }
    // Fallback: some networks drop big phone->laptop uploads but pass small requests. Send ~48 KB pieces.
    clientLog(`native upload to ${path} failed: ${(first as Error)?.message ?? first}; trying chunked upload`);
    const b64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
    const size = 48 * 1024;   // multiple of 4 so every piece is valid base64 on its own
    let uploadId: string | null = null;
    for (let i = 0, n = 0; i < b64.length; i += size, n++) {
      const piece: { upload_id: string } = await req<{ upload_id: string }>("/api/parking/upload-chunk", json({ upload_id: uploadId, index: n, data: b64.slice(i, i + size) }));
      uploadId = piece.upload_id;
    }
    const body = new URLSearchParams({ ...params, upload_id: uploadId ?? "" }).toString();
    return await timeout(req<T>(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }));
  } catch (e) {
    clientLog(`upload to ${path} failed: ${(e as Error)?.message ?? e}`);
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, `Couldn't upload the photo (${(e as Error).message || "network error"}). ` +
      `Make sure the phone is on the same Wi-Fi as the laptop running the backend (${BASE}), then try again.`);
  } finally {
    if (cleanupUri && Platform.OS !== "web") deleteAsync(cleanupUri, { idempotent: true }).catch(() => {});
  }
}

/** Best-effort: report a client-side failure to the server log (small JSON, fire and forget). */
function clientLog(message: string) {
  fetch(BASE + "/api/parking/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) })
    .catch(() => {});
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const form = (fields: Record<string, string | number | boolean | PickedImage | null | undefined>): RequestInit => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") {
      // React Native's FormData file shape
      fd.append(k, { uri: v.uri, name: v.name ?? "photo.jpg", type: v.mimeType ?? "image/jpeg" } as unknown as Blob);
    } else fd.append(k, String(v));
  }
  return { method: "POST", body: fd };
};

export const media = (url?: string | null) => (url && url.startsWith("/") ? BASE + url : url ?? "");

export type Mode = "standard" | "watch" | "ice";

export interface Lot {
  id: number; slug: string; name: string; kind: string; description: string;
  lat: number; lng: number; polygon: [number, number][];
  /** Where a mapped road enters the lot (OSM). Driving directions go here. */
  entrance?: [number, number];
  total_capacity: number; capacity_is_seed_estimate: boolean;
  snow_adjusted_capacity: number; snow_blocked_spaces: number; snow_blocked_fraction: number; snow_source: string;
  occupied: number; available: number; occupancy_pct: number; confidence: number;
  data_source: string; last_update: string | null; report_expires_at: string | null; note: string;
  plowed_rows: number | null; unplowed_rows: number | null; total_rows: number;
  pending_departures: number; search_minutes: number; hourly_profile: number[]; simulated_clock: boolean;
  checked_in?: number; checkin_adjustment?: number;
}
export interface LotsResponse { lots: Lot[]; totals: Record<string, number>; mode: Mode; disclaimer: string }

export interface SystemState {
  mode: Mode; auto_mode: Mode; decision_source: string; manual_override: Mode | null; reason: string;
  demo_active: boolean; eta_minutes: number | null; updated_at: string; threshold_minutes: number; source_label: string;
}

export interface ScanResult {
  scan_id: number; lot_id: number; lot_name: string; vehicles_detected: number; estimated_open_spaces: number;
  snow_blocked_spaces: number; occupied_spaces: number; visible_spaces: number; plowed_rows: number | null;
  unplowed_rows: number | null; confidence: number; weather_condition: string; recommendation: string;
  explanation: string; explanation_source: string; space_method: string; space_method_label: string;
  detector: string; detector_note: string; gemini_used: boolean; annotated_image_url: string; blurred_image_url: string;
  privacy: { regions_blurred: number; methods: string[] }; sample_is_synthetic: boolean;
  frame_occupancy_fraction: number; frame_snow_blocked_fraction: number; snow_cover_fraction: number;
  /** Local OpenCV issue detector: what makes spaces unusable (snow, ice, water, cones, objects). */
  issues?: Issue[]; verdict?: Verdict; issues_method?: string;
}

export interface Hazard {
  id: number; location_name: string; lat: number; lng: number; category: string; category_label: string;
  confidence: number; classified_by: string; explanation: string; image_url: string | null;
  confirmations: number; clear_votes: number; status: string; created_at: string; expires_at: string;
  minutes_left: number; is_demo: boolean; hard_stop_for_wheelchairs: boolean;
}

export interface Route { status: "blocked" | "hazard" | "unverified"; label: string; hazard_ids: number[]; wheelchair_hard_stop: boolean }

export interface LotEval {
  slug: string; name: string; kind: string; snow_adjusted_capacity: number; predicted_occupancy: number;
  expected_open_spaces: number; availability_probability: number; walk_minutes: number; walk_distance_m: number;
  via_shuttle: boolean; search_minutes: number; ice_buffer_minutes: number; recommended_departure: string;
  score: number; label: string; accessible_blocked: boolean; data_source: string; confidence: number; route?: Route;
}
export interface Recommendation {
  destination: string; arrival_time: string; mode: string; best: LotEval | null; backup: LotEval | null; all: LotEval[];
  explanation: string; disclaimer: string; forecast?: { lot: string; series: { time: string; occupancy: number; is_arrival: boolean }[] };
  simulated_clock: boolean; now: string;
}

export interface Notification { id: number; kind: string; title: string; body: string; lot_id: number | null; user_id: number | null; created_at: string; is_demo: boolean; meta: Record<string, unknown> }
export interface CrewUser {
  id: number; handle: string; points: number; reports_submitted: number; hazards_verified: number; assists_given: number;
  needs_accessible_routes: boolean; accepts_assist_requests: boolean; is_seed: boolean; rank: number | null;
  history?: { action: string; points: number; at: string }[];
}
export interface Weather {
  source: string; source_label: string; errors: string[];
  observation: WeatherObservation | null;
  observation_is_demo: boolean;
  alerts: { id: string; event: string; headline: string; severity: string; onset: string; ends: string; winter: boolean; demo: boolean; source: string }[];
  winter_alert_active: boolean; demo_active: boolean;
}
export interface SatObs {
  id: number; source: string; source_label: string; acquired_at: string; image_url: string; overlay_url: string | null;
  band_detected: boolean; band_count: number; speed_kph: number | null; heading_deg: number | null;
  moving_toward_buffalo: boolean; eta_minutes: number | null; is_demo: boolean; analysis: Record<string, unknown>;
}
export interface SatStatus {
  satellite: Record<string, string | number>;
  live_feed: { online: boolean; error: string | null; latest_acquired_at: string | null; latest_image_url: string | null; label: string };
  latest_observation: SatObs | null; latest_analysis: SatObs | null; timeline: SatObs[]; state: SystemState; threshold_minutes: number;
}
export interface Analysis {
  scenario: string; source: string; source_label: string; is_simulated: boolean; live_source_status: string | null;
  frames: { acquired_at: string; image_url: string; band_count: number; centroid: number[] | null }[];
  overlay_url: string;
  track: { band_detected: boolean; band_count: number; speed_kph: number | null; heading_deg: number | null; moving_toward_buffalo: boolean; eta_minutes: number | null; distance_km: number | null; method: string };
  decision: { mode: Mode; reason: string; corroborated: boolean }; weather: Weather; state: SystemState;
}
export interface Meta {
  buildings: { name: string; lat: number; lng: number }[]; hazard_locations: { name: string; lat: number; lng: number }[];
  campus_center: [number, number]; campus_time: string; simulated_clock: boolean; config: Record<string, number>;
}
/** Live NWS reading (Buffalo airport, KBUF) shaped for drivers; `advice` is plain-English driving guidance. */
export interface WeatherObservation {
  temperature_c: number | null; temperature_f: number | null; feels_like_c: number | null; feels_like_f: number | null;
  condition: string; precipitation: string | null; wind_kph: number | null; wind_mph: number | null;
  gust_kph: number | null; gust_mph: number | null; wind_dir: string | null; visibility_km: number | null;
  visibility_mi: number | null; humidity_pct: number | null; advice: string[]; observed_at: string; station: string;
}
export interface LocateResult {
  lot: { id: number; slug: string; name: string } | null;
  method: "inside_outline" | "nearest_outline" | "none"; distance_m: number | null; confidence: number;
  search_radius_m: number; accuracy_m: number | null; outline_source: string | null;
  candidates: { id: number; key: string; name: string; distance_m: number }[];
  hazard_location: { name: string; distance_m: number } | null; on_campus: boolean;
}
export interface Sample { id: string; title: string; synthetic: boolean; image_url: string; has_stall_map: boolean; kind?: string }
export interface Health { status: string; mode: Mode; vision_detector: string; gemini_configured: boolean; satellite_source: string; weather_source: string; simulated_clock: boolean; time_campus: string; voice_enabled?: boolean }

export interface ParkingSession {
  id: number; lot: { id: number; slug: string; name: string; lat: number; lng: number } | null;
  source: "manual" | "auto"; car_lat: number | null; car_lng: number | null;
  started_at: string; ended_at: string | null; end_source: string | null; active: boolean;
}

export interface Account { id: number; email: string; name: string; email_verified: boolean; user: { id: number; handle: string; points: number } | null }
export interface AuthSession { token: string; expires_in_days: number; account: Account }
export interface CodeSent { verification_required?: boolean; email?: string; email_sent: boolean; dev_code?: string }
/** Signup either signs you in (default) or, if the server requires email verification, sends a code. */
export type SignupResult = ({ verification_required: false } & AuthSession) | ({ verification_required: true } & CodeSent);

export const authApi = {
  signup: (b: { email: string; password: string; name?: string; anonymous_user_id?: number | null }) => req<SignupResult>("/api/auth/signup", json(b)),
  verify: (email: string, code: string) => req<AuthSession>("/api/auth/verify", json({ email, code })),
  resend: (email: string) => req<CodeSent>("/api/auth/resend", json({ email })),
  login: (email: string, password: string) => req<AuthSession>("/api/auth/login", json({ email, password })),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => req<{ account: Account }>("/api/auth/me"),
  providers: () => req<{ email: boolean; google: boolean; google_client_ids: string[]; email_domains: string[] }>("/api/auth/providers"),
  google: (id_token: string, anonymous_user_id?: number | null) => req<AuthSession>("/api/auth/google", json({ id_token, anonymous_user_id })),
};

export const api = {
  health: () => req<Health>("/api/health"),
  meta: () => req<Meta>("/api/meta"),
  lots: () => req<LotsResponse>("/api/parking/lots"),
  samples: () => req<{ samples: Sample[] }>("/api/parking/samples"),
  locate: (lat: number, lng: number, accuracy_m?: number | null) =>
    req<LocateResult>(`/api/parking/locate?lat=${lat}&lng=${lng}${accuracy_m ? `&accuracy_m=${Math.round(accuracy_m)}` : ""}`),
  /** Live camera frame -> labelled boxes. On web the frame is a data/blob URL, so it's sent as a real Blob. */
  /** save=true only for the Capture button: the server keeps a privacy-blurred, annotated copy. Preview frames: false. */
  liveDetect: async (image: PickedImage, save = false) => {
    if (Platform.OS === "web") {
      const fd = new FormData();
      if (save) fd.append("save", "true");
      fd.append("file", await (await fetch(image.uri)).blob(), "frame.jpg");
      return req<LiveDetect & { saved?: boolean }>("/api/parking/live-detect", { method: "POST", body: fd });
    }
    return upload<LiveDetect & { saved?: boolean }>("/api/parking/live-detect", save ? { save: "true" } : {}, image,
      { shrink: save, timeoutMs: save ? 60000 : 20000 });
  },
  scan: (lot_id: number, opts: { file?: PickedImage | null; sample_id?: string | null }) =>
    opts.file ? upload<ScanResult>("/api/parking/scan", { lot_id }, opts.file)
      : req<ScanResult>("/api/parking/scan", form({ lot_id, sample_id: opts.sample_id })),
  report: (body: Record<string, unknown>) => req<{ report_id: number; lot: Lot; points_awarded: number; corrected: boolean; expires_in_minutes: number }>("/api/parking/report", json(body)),
  recommend: (p: { destination: string; arrival: string; accessible: boolean; drive_minutes?: number; user_id?: number }) =>
    req<Recommendation>(`/api/parking/recommendations?${new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  session: (user_id: number) => req<{ session: ParkingSession | null }>(`/api/parking/session?user_id=${user_id}`),
  checkIn: (b: { user_id: number; lot_id: number; source: "manual" | "auto"; lat?: number; lng?: number }) =>
    req<{ session: ParkingSession; lot: Lot }>("/api/parking/checkin", json(b)),
  checkOut: (b: { user_id: number; source: "manual" | "auto" }) =>
    req<{ session: ParkingSession; lot: Lot; points_awarded: number }>("/api/parking/checkout", json(b)),
  leave: (lot_id: number, user_id?: number) => req<{ lot: Lot; points_awarded: number }>("/api/parking/leave", json({ lot_id, user_id })),
  weather: (refresh = false) => req<Weather>(`/api/weather/current${refresh ? "?refresh=true" : ""}`),
  satStatus: () => req<SatStatus>("/api/satellite/status"),
  analyze: () => req<Analysis>("/api/satellite/analyze", { method: "POST" }),
  demoStorm: () => req<Analysis>("/api/satellite/demo-storm", { method: "POST" }),
  state: () => req<SystemState>("/api/state"),
  setMode: (mode: Mode | null) => req<SystemState>("/api/state/mode", json({ mode })),
  reset: () => req<{ ok: boolean }>("/api/demo/reset", { method: "POST" }),
  hazards: () => req<{ hazards: Hazard[] }>("/api/hazards"),
  routes: (destination: string) => req<{ destination: string; routes: (Route & { lot: string; slug: string })[] }>(`/api/hazards/routes?destination=${encodeURIComponent(destination)}`),
  /** A dropped pin (lat/lng) is the location; location_name is optional (the server names the spot). */
  reportHazard: (f: { location_name?: string; lat?: number; lng?: number; description?: string; category: string; user_id?: number; file?: PickedImage | null; sample_id?: string; is_demo?: boolean }) =>
    f.file ? upload<{ created: boolean; hazard?: Hazard; ai: Record<string, unknown> | null; points_awarded?: number; message?: string }>(
      "/api/hazards/report", { location_name: f.location_name, lat: f.lat, lng: f.lng, description: f.description, category: f.category, user_id: f.user_id, sample_id: f.sample_id, is_demo: f.is_demo }, f.file)
      : req<{ created: boolean; hazard?: Hazard; ai: Record<string, unknown> | null; points_awarded?: number; message?: string }>("/api/hazards/report", form(f)),
  vote: (id: number, user_id: number, vote: "confirm" | "clear") => req<{ hazard: Hazard; cleared: boolean; points_awarded: number }>(`/api/hazards/${id}/vote`, json({ user_id, vote })),
  clearHazard: (id: number, user_id: number) => req<{ hazard: Hazard; cleared: boolean; points_awarded: number }>(`/api/hazards/${id}/clear`, json({ user_id })),
  me: (user_id?: number | null, body?: Partial<Pick<CrewUser, "needs_accessible_routes" | "accepts_assist_requests">>) =>
    req<CrewUser>(`/api/crew/me${user_id ? `?user_id=${user_id}` : ""}`, body ? json(body) : { method: "POST" }),
  leaderboard: () => req<{ leaderboard: CrewUser[] }>("/api/crew/leaderboard"),
  assist: (body: { user_id: number; lot_id?: number; location_note?: string; action?: "request" | "respond"; request_id?: number }) =>
    req<{ ok: boolean; request_id?: number; crew_alerted?: number; message?: string; points_awarded?: number }>("/api/crew/assist", json(body)),
  notifications: () => req<{ notifications: Notification[] }>("/api/notifications"),
};

/** API timestamps (UTC) shown as New York campus time, whatever the phone's timezone: "1:05 PM". */
export const fmtTime = (iso?: string | null) => campusTimeLabel(iso);
export const hhmm12 = (t?: string | null) => {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
export const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
export const sourceLabel = (s: string) =>
  ({ seed_model: "Model estimate", crew_scan: "Student scan", crew_manual: "Student report", demo: "Demo data" } as Record<string, string>)[s] ?? s;

/** Shared "full" rule so lists, maps and sheets never disagree. */
export const lotFull = (l: Pick<Lot, "available" | "snow_adjusted_capacity">) => l.available <= Math.max(2, l.snow_adjusted_capacity * 0.02);

/** "LIKELY OPEN" -> "Likely open" */
export const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** Availability label -> badge tone. */
export const availabilityTone = (label: string) =>
  (label === "LIKELY OPEN" ? "success" : label === "TIGHT" ? "warn" : "danger") as "success" | "warn" | "danger";

export const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)} min`);

/** Backend paths that stream ElevenLabs MP3 audio (see backend/app/routers/voice.py). */
export const voicePaths = {
  briefing: (destination: string, arrival?: string, accessible = false, intro = false, drive = false) =>
    `/api/voice/briefing?${new URLSearchParams({ destination, accessible: String(accessible), ...(arrival ? { arrival } : {}), ...(intro ? { intro: "true" } : {}), ...(drive ? { drive: "true" } : {}) })}`,
  lot: (id: number, drive = false) => `/api/voice/lot/${id}${drive ? "?drive=true" : ""}`,
  alert: (kind: "ice_on" | "ice_off" | "lot_full", destination: string, lotId?: number) =>
    `/api/voice/alert?${new URLSearchParams({ kind, destination, ...(lotId ? { lot_id: String(lotId) } : {}) })}`,
};

export interface CopilotAnswer {
  transcript: string; intent: string; answer: string; destination: string; speech_path: string | null;
  /** wake mode: the clip didn't start with "Hey Parky" (ignored) / it was only "Hey Parky" (listen for the question) */
  ignored?: boolean; listen_again?: boolean;
  action: "directions" | null; lot: { id: number; slug: string; name: string; lat: number; lng: number; entrance?: [number, number] } | null;
  conversation_id: string; end_conversation: boolean; answered_by: "rules" | "gemini";
}

/** Voice co-pilot: a recorded question (ElevenLabs speech-to-text on the server) or typed text. */
export async function askCopilot(q: { audioUri?: string; text?: string; destination: string; arrival?: string; accessible?: boolean; conversationId?: string | null; drive?: boolean; wake?: boolean }) {
  // Phones: send the recording with the reliable uploader (native multipart, chunked fallback on networks that
  // drop uploads), the same path photos use. Web keeps FormData with a Blob.
  if (q.audioUri && !q.text && Platform.OS !== "web" && !q.audioUri.startsWith("blob:") && !q.audioUri.startsWith("data:")) {
    return upload<CopilotAnswer>("/api/voice/ask", {
      destination: q.destination, arrival: q.arrival, accessible: String(!!q.accessible),
      conversation_id: q.conversationId ?? undefined, drive: q.drive ? "true" : undefined, wake: q.wake ? "true" : undefined,
    }, { uri: q.audioUri, name: "question.m4a", mimeType: "audio/mp4" }, { shrink: false, mimeType: "audio/mp4", timeoutMs: 45000 });
  }
  const fd = new FormData();
  if (q.drive) fd.append("drive", "true");
  if (q.wake) fd.append("wake", "true");
  if (q.text) fd.append("text", q.text);
  if (q.audioUri) {
    if (q.audioUri.startsWith("blob:") || q.audioUri.startsWith("data:")) {
      // Web recorder hands back a blob URL; native FormData takes {uri,name,type}.
      const blob = await (await fetch(q.audioUri)).blob();
      fd.append("file", blob, "question.webm");
    } else {
      fd.append("file", { uri: q.audioUri, name: "question.m4a", type: "audio/mp4" } as unknown as Blob);
    }
  }
  fd.append("destination", q.destination);
  if (q.arrival) fd.append("arrival", q.arrival);
  fd.append("accessible", String(!!q.accessible));
  if (q.conversationId) fd.append("conversation_id", q.conversationId);
  return req<CopilotAnswer>("/api/voice/ask", { method: "POST", body: fd });
}

/** Google Maps driving directions to a point. Opens the Maps app when installed, the web otherwise. */
/** Driving directions to a lot's real entrance (where a road enters it), falling back to its pin. */
export const lotDirectionsUrl = (lot: { lat: number; lng: number; entrance?: [number, number] | null }) =>
  directionsUrl(lot.entrance?.[0] ?? lot.lat, lot.entrance?.[1] ?? lot.lng);
export const directionsUrl = (lat: number, lng: number, mode: "driving" | "walking" = "driving") =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=${mode}`;
