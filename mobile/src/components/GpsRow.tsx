import { LocateFixed } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";
import type { LocateResult } from "../api";
import { methodLabel, type LocateStatus } from "../location";
import { useStore } from "../store";
import { space } from "../theme";
import { Badge, Button, T, row } from "./ui";

/** GPS status line + locate button. States plainly how the match was made. */
export default function GpsRow({ status, result, error, onLocate, matchedName, label, override, showConfidence = true }: {
  status: LocateStatus; result: LocateResult | null; error: string | null; onLocate: () => void; matchedName?: string | null;
  /** Replaces the default lot-match wording once a fix is in. */
  label?: string; showConfidence?: boolean;
  /** Shown regardless of GPS state (e.g. "You're parked at Jarvis B"). */
  override?: string;
}) {
  const { c } = useStore();
  const text = override ?? (
    status === "locating" ? "Finding your location…"
      : status === "denied" ? "Location access is off. Pick manually or enable it in Settings."
        : status === "error" ? error ?? "Couldn't get a location fix."
          : result ? label ?? (result.lot ? `${methodLabel(result)} ${matchedName ?? result.lot.name}` : methodLabel(result))
            : "Use your location to pick automatically.");
  return (
    <View style={[row.between, { gap: space.md }]}>
      <View style={[row.gap, { flex: 1 }]}>
        {status === "locating" ? <ActivityIndicator size="small" color={c.textMuted} /> : <LocateFixed size={16} color={override || result?.lot ? c.success : c.textMuted} />}
        <T v="caption" style={{ flex: 1 }} color={status === "error" || status === "denied" ? c.warn : undefined}>{text}</T>
        {showConfidence && result?.lot && <Badge tone={result.confidence >= 0.8 ? "success" : "warn"}>{Math.round(result.confidence * 100)}%</Badge>}
      </View>
      <Button size="sm" variant="secondary" title={result ? "Retry" : "Locate"} onPress={onLocate} disabled={status === "locating"} />
    </View>
  );
}
