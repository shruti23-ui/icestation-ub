import { View } from "react-native";
import { api, type Mode } from "../api";
import { useStore } from "../store";
import { space } from "../theme";
import { Badge, Card, DemoTag, Segmented, T, row } from "./ui";

type Choice = "auto" | "standard" | "ice";

export const modeLabel = (m?: Mode | null) => (m === "ice" ? "Snow season" : m === "watch" ? "Storm watch" : "Standard");

/** Demo control to simulate weather impact on parking lot capacity. */
export default function ModeToggle() {
  const { state, refresh, toast } = useStore();
  const choice: Choice = (state?.manual_override === "ice" ? "ice" : state?.manual_override ? "standard" : "auto");
  const manual = state?.decision_source === "manual_override";

  const set = async (v: Choice) => {
    if (v === choice) return;
    try {
      await api.setMode(v === "auto" ? null : v);
      refresh("state", "lots");
      toast(v === "auto" ? "Mode follows live weather" : `${modeLabel(v)} set (demo override)`, "info");
    } catch (e) { toast((e as Error).message, "error"); }
  };

  return (
    <View style={{ gap: space.sm, marginTop: space.xs }}>
      <View style={[row.between, { alignItems: "center" }]}>
        <View style={row.gap}>
          <T v="label">Simulate season:</T>
          <Badge tone={manual ? "warn" : "neutral"}>{manual ? "Manual override" : "Automatic"}</Badge>
        </View>
        <T v="caption">{choice === "ice" ? "Snowbanks reduce capacity" : "Full lot capacity"}</T>
      </View>
      <Segmented<Choice>
        options={[{ value: "auto", label: "Automatic" }, { value: "standard", label: "Standard" }, { value: "ice", label: "Snow season" }]}
        value={choice} onChange={set} />
    </View>
  );
}
