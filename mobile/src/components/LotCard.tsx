import { View } from "react-native";
import { ago, lotFull, sourceLabel, type Lot } from "../api";
import { useStore } from "../store";
import { space } from "../theme";
import { Badge, DemoTag, Field, ProgressBar, T, row } from "./ui";

/** One lot as a list row: name, open count, fill bar; `detailed` adds the breakdown and provenance. */
const KIND_LABEL: Record<string, string> = {
  commuter: "Commuter", residence: "Residence", visitor: "Visitor (paid)", event: "Event / overflow", park_and_ride: "Park & ride",
};

export default function LotRow({ lot, detailed = false, highlight = false, distanceM }: { lot: Lot; detailed?: boolean; highlight?: boolean; distanceM?: number | null }) {
  const { c } = useStore();
  const full = lotFull(lot);
  return (
    <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md + 2, gap: space.sm }}>
      <View style={row.between}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={row.gap}>
            <T v="subheading" numberOfLines={1}>{lot.name}</T>
            {highlight && <Badge tone="accent">Recommended</Badge>}
          </View>
          <T v="caption" numberOfLines={1}>{KIND_LABEL[lot.kind] ?? "Lot"}{distanceM != null ? ` · ${distanceM < 1000 ? `${distanceM} m` : `${(distanceM / 1000).toFixed(1)} km`}` : ""} · {sourceLabel(lot.data_source)}</T>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T v="subheading" color={full ? c.warn : c.text} style={{ fontVariant: ["tabular-nums"] }}>{full ? `Full · ${lot.snow_adjusted_capacity}/${lot.snow_adjusted_capacity}` : `${lot.available} open`}</T>
          {/* Total slots in the lot ("~" = estimated from the lot's area); snow-blocked stalls are excluded in ice season */}
          <T v="caption" style={{ fontVariant: ["tabular-nums"] }}>
            of {lot.capacity_is_seed_estimate ? "~" : ""}{lot.snow_adjusted_capacity} spaces · {Math.round(lot.occupancy_pct)}% full
          </T>
        </View>
      </View>
      <ProgressBar pct={lot.occupancy_pct} />
      {detailed && (
        <View style={{ gap: space.sm, marginTop: 2 }}>
          <View style={row.between}>
            <Field label="Occupied" value={String(lot.occupied)} />
            <Field label={lot.capacity_is_seed_estimate ? "Capacity (est.)" : "Capacity"} value={String(lot.total_capacity)} />
            <Field label="Snow-adjusted" value={`${lot.snow_adjusted_capacity}${lot.snow_blocked_spaces ? ` (−${lot.snow_blocked_spaces})` : ""}`}
              color={lot.snow_blocked_spaces ? c.warn : undefined} />
          </View>
          <View style={row.wrap}>
            {lot.data_source === "demo" && <DemoTag label="Demo data" />}
            {lot.pending_departures > 0 && <Badge tone="success">{lot.pending_departures} leaving soon</Badge>}
            {lot.snow_source === "ice-season default" && <Badge tone="warn">Ice season −18%</Badge>}
            {lot.capacity_is_seed_estimate && <Badge>Capacity est.</Badge>}
            <Badge>{Math.round(lot.confidence * 100)}% confidence</Badge>
          </View>
          {lot.description ? <T v="caption">{lot.description}</T> : null}
          <T v="caption">{lot.last_update ? `Updated ${ago(lot.last_update)}` : "Model estimate. No student report in the last 30 min."}</T>
        </View>
      )}
    </View>
  );
}
