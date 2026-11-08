import { useFocusEffect } from "expo-router";
import { CloudSnow, Droplets, Eye, RefreshCw, Thermometer, TriangleAlert, Wind } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, View } from "react-native";
import { ago, api, fmtTime, media, minutes, type Analysis, type SatStatus } from "../../src/api";
import Header from "../../src/components/Header";
import { modeLabel } from "../../src/components/ModeToggle";
import { Badge, Banner, Button, Card, DemoTag, Empty, Field, List, ListRow, Loading, Section, Screen, StatusDot, T, row } from "../../src/components/ui";
import { useStore } from "../../src/store";
import { radius, space } from "../../src/theme";

const compass = (deg?: number | null) =>
  deg == null ? "—" : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

export default function Weather() {
  const { c, weather, state, refresh, toast } = useStore();
  const [status, setStatus] = useState<SatStatus | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<"analyze" | "storm" | null>(null);
  const [frameIdx, setFrameIdx] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api.satStatus()); } catch (e) { toast((e as Error).message, "error"); }
  }, [toast]);
  useFocusEffect(useCallback(() => { load(); }, [load, state?.mode]));
  // Real-time: whenever GOES-19 has a newer frame than our last analysis, analyze it (on open and every 5 min).
  const autoBusy = useRef(false);
  const syncLive = useCallback(async () => {
    if (autoBusy.current) return;
    autoBusy.current = true;
    try {
      const st = await api.satStatus();
      setStatus(st);
      const latest = st.live_feed.latest_acquired_at, la = st.latest_analysis;
      const stale = st.live_feed.online && latest && (!la || la.source !== "goes19_live" || la.acquired_at < latest);
      if (stale) { setAnalysis(await api.analyze()); setStatus(await api.satStatus()); refresh("state", "lots", "weather"); }
    } catch { /* keep showing what we have */ } finally { autoBusy.current = false; }
  }, [refresh]);
  useFocusEffect(useCallback(() => {
    syncLive();
    const id = setInterval(syncLive, 5 * 60_000);
    return () => clearInterval(id);
  }, [syncLive]));
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  // Step through the replay frames, then settle on the tracking overlay.
  const play = (a: Analysis) => {
    if (timer.current) clearInterval(timer.current);
    let i = 0;
    setFrameIdx(0);
    timer.current = setInterval(() => {
      i += 1;
      if (i >= a.frames.length) { clearInterval(timer.current!); setFrameIdx(null); return; }
      setFrameIdx(i);
    }, 650);
  };

  const run = async (kind: "analyze" | "storm") => {
    setBusy(kind);
    try {
      const a = kind === "storm" ? await api.demoStorm() : await api.analyze();
      setAnalysis(a);
      if (a.frames.length > 1) play(a);
      await Promise.all([load(), refresh("state", "lots", "weather", "notifications")]);
      toast(a.state.mode === "ice" ? "Snow band approaching. Ice season is on." : `Analysis complete: ${modeLabel(a.decision.mode).toLowerCase()}`, a.state.mode === "ice" ? "ok" : "info");
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(null); }
  };

  const la = status?.latest_analysis;
  const tr = analysis?.track ?? (la ? {
    band_detected: la.band_detected, speed_kph: la.speed_kph, heading_deg: la.heading_deg, moving_toward_buffalo: la.moving_toward_buffalo,
    eta_minutes: la.eta_minutes, distance_km: (la.analysis?.distance_km as number) ?? null, method: (la.analysis?.method as string) ?? "", band_count: la.band_count,
  } : null);
  const viewerUrl = frameIdx != null && analysis ? analysis.frames[frameIdx].image_url
    : analysis?.overlay_url ?? la?.overlay_url ?? status?.live_feed.latest_image_url ?? null;
  const sourceLabel = analysis?.source_label ?? la?.source_label ?? status?.live_feed.label;
  // Only label what's actually on screen: the raw live listing image is real GOES-19 imagery.
  const shownSource = frameIdx != null || analysis ? analysis?.source : la ? la.source : status?.live_feed.latest_image_url ? "goes19_live" : undefined;
  const simulated = shownSource !== undefined && shownSource !== "goes19_live";
  const threshold = status?.threshold_minutes ?? 60;
  const live = status?.live_feed.online;

  return (
    <Screen header={<Header title="Weather" subtitle="Live driving conditions for UB North Campus" />} onRefresh={load}>
      <DriverWeather />

      <Section title="Satellite snow tracking">
      <Card padded={false}>
        <View style={{ padding: space.lg, gap: 4 }}>
          <View style={row.between}>
            <View style={row.gap}>
              <StatusDot color={live ? c.success : c.warn} />
              <T v="subheading">{live ? "Live feed online" : "Live feed offline"}</T>
            </View>
            {status?.live_feed.latest_acquired_at && <T v="caption">Latest frame {fmtTime(status.live_feed.latest_acquired_at)} · auto-updates</T>}
          </View>
          {status?.live_feed.error && <T v="caption" color={c.warn}>{status.live_feed.error}. Using a labelled simulated feed.</T>}
        </View>
        {viewerUrl ? (
          <Image source={{ uri: media(viewerUrl) }} style={{ width: "100%", aspectRatio: 1, backgroundColor: "#000" }} />
        ) : (
          <View style={{ aspectRatio: 1, backgroundColor: c.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
            <T v="caption">No analysis yet. Run one below.</T>
          </View>
        )}
        <View style={{ padding: space.md, gap: space.sm }}>
          <View style={row.wrap}>
            {simulated && viewerUrl && <DemoTag label="Simulated satellite feed" />}
            {frameIdx != null && analysis && <Badge>Frame {frameIdx + 1}/{analysis.frames.length} · {fmtTime(analysis.frames[frameIdx].acquired_at)}</Badge>}
          </View>
          {sourceLabel && <T v="caption">{sourceLabel}</T>}
        </View>
      </Card>

      </Section>

      <View style={row.gap}>
        <Button title="Analyze latest frame now" variant="secondary" icon={<RefreshCw size={15} color={c.text} />} onPress={() => run("analyze")} loading={busy === "analyze"} style={{ flex: 1 }} />
      </View>
      {analysis?.live_source_status && <T v="caption">Live feed: {analysis.live_source_status}</T>}

      <Section title="Snow band">
        <Card style={{ gap: space.md }}>
          {tr?.band_detected ? (
            <>
              <View style={row.between}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="subheading">{tr.moving_toward_buffalo ? "Headed for North Campus" : "Not tracking toward campus"}</T>
                  <T v="caption">{tr.method}</T>
                </View>
                {tr.eta_minutes != null && tr.moving_toward_buffalo && (
                  <View style={{ alignItems: "flex-end" }}>
                    <T v="metric" color={c.accent}>{minutes(tr.eta_minutes)}</T>
                    <T v="caption">until arrival</T>
                  </View>
                )}
              </View>
              <View style={row.between}>
                <Field label="Heading" value={compass(tr.heading_deg)} />
                <Field label="Speed" value={`${tr.speed_kph ?? "—"} km/h`} />
                <Field label="Distance" value={`${tr.distance_km ?? "—"} km`} />
              </View>
            </>
          ) : (
            <View style={row.gap}><CloudSnow size={18} color={c.textMuted} /><T v="body" color={c.textMuted}>No qualifying snow band in the latest frame.</T></View>
          )}
        </Card>
      </Section>

      <Section title="Ice season switch" footer={`Turns on when a band is under ${threshold} min away and a National Weather Service winter alert confirms it. Lot capacity drops, departure times get a buffer, and hazard reporting is promoted.`}>
        <Card style={{ gap: space.sm }}>
          <View style={row.between}>
            <T v="subheading">{modeLabel(state?.mode)}</T>
            <Badge tone={state?.mode === "ice" ? "warn" : state?.mode === "watch" ? "accent" : "neutral"}>
              {state?.mode === "ice" ? "Active" : state?.mode === "watch" ? "Watching" : "Standby"}
            </Badge>
          </View>
          <T v="caption">{state?.reason}</T>
          <T v="caption" color={c.textFaint}>{state?.source_label}</T>
        </Card>
      </Section>

    </Screen>
  );
}

/** What a driver needs from the weather: temperature, feels-like, conditions, wind, visibility, alerts, advice.
 *  Live from the National Weather Service (Buffalo airport station KBUF, ~5 km from North Campus). */
function DriverWeather() {
  const { c, weather } = useStore();
  const o = weather?.observation;
  const alerts = weather?.alerts ?? [];
  const footer = `${weather?.source_label ?? "National Weather Service"}${o ? ` · ${o.station}, updated ${ago(o.observed_at)}` : ""}`;
  return (
    <Section title="Driving conditions now" footer={footer}>
      <Card style={{ gap: space.lg }}>
        {o ? (
          <>
            <View style={[row.between, { alignItems: "flex-end" }]}>
              <View style={{ gap: 2 }}>
                <View style={row.gap}>
                  <T v="title" style={{ fontSize: 44, lineHeight: 50 }}>{o.temperature_f != null ? `${o.temperature_f}°F` : "—"}</T>
                  {weather?.observation_is_demo && <DemoTag />}
                </View>
                <T v="caption">{o.temperature_c != null ? `${o.temperature_c}°C` : ""}{o.feels_like_f != null && o.feels_like_f !== o.temperature_f ? ` · feels like ${o.feels_like_f}°F` : ""}</T>
              </View>
              <T v="heading" style={{ textAlign: "right", flexShrink: 1 }}>{o.condition}</T>
            </View>
            <View style={row.between}>
              <Stat icon={<Wind size={16} color={c.textMuted} />} label="Wind"
                value={o.wind_mph != null ? `${o.wind_mph} mph ${o.wind_dir ?? ""}`.trim() : "—"}
                sub={o.gust_mph != null ? `gusts ${o.gust_mph} mph` : undefined} />
              <Stat icon={<Eye size={16} color={c.textMuted} />} label="Visibility" value={o.visibility_mi != null ? `${o.visibility_mi} mi` : "—"} />
              <Stat icon={<Droplets size={16} color={c.textMuted} />} label="Humidity" value={o.humidity_pct != null ? `${o.humidity_pct}%` : "—"} />
            </View>
            <View style={{ gap: space.sm }}>
              {o.advice.map((a) => (
                <View key={a} style={row.gap}>
                  <Thermometer size={14} color={o.advice.length === 1 && a.startsWith("No weather") ? c.success : c.warn} />
                  <T v="body" style={{ flex: 1, fontSize: 14 }}>{a}</T>
                </View>
              ))}
            </View>
          </>
        ) : <T v="body" color={c.textMuted}>Live weather isn't available right now.</T>}
      </Card>
      {alerts.map((a) => (
        <Banner key={a.id} tone={a.winter ? "warn" : "neutral"} icon={<TriangleAlert size={18} color={a.winter ? c.warn : c.textMuted} />}
          title={<View style={row.gap}><T v="subheading" color={a.winter ? c.warn : c.text}>{a.event}</T>{a.demo && <DemoTag />}</View>}>
          {a.headline}
        </Banner>
      ))}
      {!alerts.length && o && <T v="caption">No active weather alerts for North Campus.</T>}
      {weather?.errors.length ? <Banner tone="danger">{weather.errors.join(" · ")}</Banner> : null}
    </Section>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <View style={row.gap}>{icon}<T v="caption">{label}</T></View>
      <T v="subheading">{value}</T>
      {sub ? <T v="caption">{sub}</T> : null}
    </View>
  );
}
