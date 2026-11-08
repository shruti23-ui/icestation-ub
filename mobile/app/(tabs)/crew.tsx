import { useFocusEffect } from "expo-router";
import { LogOut } from "lucide-react-native";
import { useAuth } from "../../src/auth";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { api, ago, type CrewUser } from "../../src/api";
import Header from "../../src/components/Header";
import { Alien } from "../../src/components/SpaceArt";
import { Badge, Button, Card, Empty, List, ListRow, Metrics, Section, Screen, T, Toggle, row } from "../../src/components/ui";
import { useStore } from "../../src/store";
import { space } from "../../src/theme";

const ACTIONS: Record<string, string> = {
  scan: "Scanned a lot", report: "Reported a lot", hazard: "Reported a hazard", verify: "Confirmed a hazard",
  clear: "Cleared a hazard", leaving: "Shared a departure", assist_help: "Helped push a car", assist_request: "Asked for help",
};

export default function Profile() {
  const { c, user, notifications, refresh, toast, setUser } = useStore();
  const auth = useAuth();
  const [board, setBoard] = useState<CrewUser[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setBoard((await api.leaderboard()).leaderboard); await refresh("crew"); } catch (e) { toast((e as Error).message, "error"); }
  }, [refresh, toast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Open help requests carry a responders list; skip our own.
  const requests = notifications.filter((n) => n.kind === "assist" && Array.isArray(n.meta?.responders) && n.user_id !== user?.id);
  const respond = async (id: number) => {
    if (!user) return;
    setBusy(id);
    try { const r = await api.assist({ user_id: user.id, action: "respond", request_id: id }); toast(`They've been told you're coming (+${r.points_awarded} pts)`); load(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  };
  const toggleHelp = async (v: boolean) => {
    if (!user) return;
    try { setUser(await api.me(user.id, { accepts_assist_requests: v })); } catch (e) { toast((e as Error).message, "error"); }
  };

  return (
    <Screen header={<Header title="Profile" subtitle={auth.account ? `${user?.handle ?? auth.account.name} · ${auth.account.email}` : user?.handle} />} onRefresh={load}>
      {user && (
        <>
          <Metrics items={[
            { label: "Reports", value: user.reports_submitted, color: c.accent },
            { label: "Walkway verified", value: user.hazards_verified },
            { label: "Community karma", value: user.points.toLocaleString() },
          ]} />
          <Card padded={false}>
            <ListRow title="Winter roadside assist" subtitle="Receive notification if a student nearby is stuck in snow"
              right={<Toggle value={user.accepts_assist_requests} onChange={toggleHelp} label="Winter roadside assist" />} />
          </Card>
        </>
      )}

      <Section title="Account">
        <Card padded={false}>
          <List>
            <ListRow title={auth.account?.email ?? "Not signed in"} subtitle={auth.account ? "UB Verified Account" : undefined} />
            <ListRow title={<T v="subheading" color={c.danger}>Log out</T>} left={<LogOut size={18} color={c.danger} />} onPress={auth.logout} />
          </List>
        </Card>
      </Section>

      <Section title="Help requests nearby">
        {requests.length === 0 ? <Empty art={<Alien size={52} />} title="No stuck cars reported">If your car is stuck in snow or ice, tap 'Request help' from the Plan tab.</Empty> : (
          <Card padded={false}>
            <List>
              {requests.map((n) => (
                <ListRow key={n.id} title={n.title} subtitle={`${n.body} · ${ago(n.created_at)}`}
                  right={<Button size="sm" title="I'll help" onPress={() => respond(n.id)} loading={busy === n.id} />} />
              ))}
            </List>
          </Card>
        )}
      </Section>

      <Section title="Recent parking reports">
        {user?.history?.length ? (
          <Card padded={false}>
            <List>
              {user.history.map((h, i) => (
                <ListRow key={i} title={<T v="body">{ACTIONS[h.action] ?? h.action}</T>}
                  right={<View style={{ alignItems: "flex-end" }}>
                    <T v="body" color={c.success} style={{ fontVariant: ["tabular-nums"] }}>+{h.points}</T>
                    <T v="caption">{ago(h.at)}</T>
                  </View>} />
              ))}
            </List>
          </Card>
        ) : <T v="caption" style={{ paddingHorizontal: space.xs }}>Scan a lot or report a hazard to earn your first points.</T>}
      </Section>
    </Screen>
  );
}
