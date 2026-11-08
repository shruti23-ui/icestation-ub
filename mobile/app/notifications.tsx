import { useEffect } from "react";
import { View } from "react-native";
import { ago } from "../src/api";
import Header from "../src/components/Header";
import { Alien } from "../src/components/SpaceArt";
import { Card, DemoTag, Empty, List, ListRow, Screen, StatusDot, T, row } from "../src/components/ui";
import { useStore } from "../src/store";

const KIND_LABEL: Record<string, string> = {
  leaving: "Space opening", assist: "Help request", hazard: "Hazard", scan: "Lot update", ice_season: "Ice season", system: "System",
};

export default function Notifications() {
  const { c, notifications, markRead } = useStore();
  useEffect(() => { markRead(); }, [markRead]);
  return (
    <Screen header={<Header title="Notifications" subtitle="Latest 3" home />}>
      {notifications.length === 0 ? <Empty art={<Alien size={56} />} title="All quiet out here">Lot updates, hazards, departures and help requests appear here.</Empty> : (
        <Card padded={false}>
          <List>
            {notifications.slice(0, 3).map((n) => {
              const warn = n.kind === "ice_season" || n.kind === "hazard";
              return (
                <ListRow key={n.id} left={<StatusDot color={warn ? c.warn : c.accent} />}
                  title={<View style={row.between}>
                    <T v="caption">{KIND_LABEL[n.kind] ?? n.kind}</T>
                    <View style={row.gap}>{n.is_demo && <DemoTag />}<T v="caption">{ago(n.created_at)}</T></View>
                  </View>}
                  subtitle={<View style={{ gap: 2 }}>
                    <T v="subheading">{n.title}</T>
                    {n.body ? <T v="caption">{n.body}</T> : null}
                  </View>} />
              );
            })}
          </List>
        </Card>
      )}
    </Screen>
  );
}
