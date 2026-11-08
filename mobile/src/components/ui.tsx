import { Children, Fragment, isValidElement, type ReactNode } from "react";
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "../store";
import { radius, space } from "../theme";
import { Ufo } from "./SpaceArt";
import Starfield from "./Starfield";

// ---------------------------------------------------------------- layout

/** Scrollable screen body with an optional fixed header, pull-to-refresh and the backend-down banner. */
export function Screen({ children, onRefresh, refreshing = false, header }: {
  children: ReactNode; onRefresh?: () => void; refreshing?: boolean; header?: ReactNode;
}) {
  const { c, backendDown } = useStore();
  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <Starfield />
      {header}
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl * 2, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textMuted} /> : undefined}
      >
        {backendDown && <Banner tone="danger" title="Can't reach the server">{backendDown}</Banner>}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A titled group: small label (with an optional text action) above its content. */
export function Section({ title, action, children, footer }: {
  title?: string; action?: { label: string; onPress: () => void }; children: ReactNode; footer?: ReactNode;
}) {
  const { c } = useStore();
  return (
    <View style={{ gap: space.sm }}>
      {(title || action) && (
        <View style={[row.between, { paddingHorizontal: 2 }]}>
          {title ? <T v="label">{title}</T> : <View />}
          {action && (
            <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button">
              <Text style={{ color: c.accent, fontSize: 13, fontWeight: "500" }}>{action.label}</Text>
            </Pressable>
          )}
        </View>
      )}
      {children}
      {footer && <View style={{ paddingHorizontal: 2 }}>{typeof footer === "string" ? <T v="caption">{footer}</T> : footer}</View>}
    </View>
  );
}

export function Card({ children, style, onPress, padded = true }: {
  children?: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; padded?: boolean;
}) {
  const { c } = useStore();
  const base: ViewStyle = {
    backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: radius.lg, padding: padded ? space.lg : 0, overflow: "hidden",
  };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [base, { opacity: pressed ? 0.85 : 1 }, style]}>
      {children}
    </Pressable>
  );
}

/** Stacks children with hairline dividers between them. Use inside an unpadded Card. */
export function List({ children }: { children: ReactNode }) {
  const { c } = useStore();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View>
      {items.map((child, i) => (
        <Fragment key={child.key ?? i}>
          {i > 0 && <View style={{ height: StyleSheet.hairlineWidth * 2, backgroundColor: c.divider, marginLeft: space.lg }} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

export function ListRow({ title, subtitle, left, right, onPress, children }: {
  title: ReactNode; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode; onPress?: () => void; children?: ReactNode;
}) {
  const body = (
    <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm }}>
      <View style={[row.gap, { gap: space.md }]}>
        {left}
        <View style={{ flex: 1, gap: 2 }}>
          {typeof title === "string" ? <T v="subheading">{title}</T> : title}
          {subtitle != null && (typeof subtitle === "string" ? <T v="caption">{subtitle}</T> : subtitle)}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>{body}</Pressable> : body;
}

// ---------------------------------------------------------------- type

type Variant = "title" | "heading" | "subheading" | "body" | "label" | "caption" | "metric";

export function T({ children, style, v = "body", color, numberOfLines }: {
  children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number; v?: Variant; color?: string;
}) {
  const { c } = useStore();
  const s: Record<Variant, TextStyle> = {
    title: { fontSize: 28, fontWeight: "700", letterSpacing: -0.6, color: c.text },
    heading: { fontSize: 20, fontWeight: "600", letterSpacing: -0.3, color: c.text },
    subheading: { fontSize: 15, fontWeight: "600", color: c.text },
    body: { fontSize: 15, lineHeight: 21, color: c.text },
    label: { fontSize: 13, fontWeight: "500", color: c.textMuted },
    caption: { fontSize: 12, lineHeight: 17, color: c.textMuted },
    metric: { fontSize: 24, fontWeight: "600", letterSpacing: -0.4, fontVariant: ["tabular-nums"], color: c.text },
  };
  return <Text numberOfLines={numberOfLines} style={[s[v], color ? { color } : null, style]}>{children}</Text>;
}

// ---------------------------------------------------------------- status

export type Tone = "neutral" | "accent" | "warn" | "danger" | "success";

function toneColors(c: ReturnType<typeof useStore>["c"], tone: Tone) {
  return {
    neutral: { fg: c.textMuted, bg: c.surfaceAlt },
    accent: { fg: c.accent, bg: c.accentSoft },
    warn: { fg: c.warn, bg: c.warnSoft },
    danger: { fg: c.danger, bg: c.dangerSoft },
    success: { fg: c.success, bg: c.successSoft },
  }[tone];
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  const { c } = useStore();
  const { fg, bg } = toneColors(c, tone);
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2, alignSelf: "flex-start" }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: "500" }}>{children}</Text>
    </View>
  );
}

/** Honesty label for anything simulated. Required wherever demo data is shown. */
export function DemoTag({ label = "Demo" }: { label?: string }) {
  return <Badge tone="warn">{label}</Badge>;
}

export function StatusDot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function Banner({ tone = "neutral", icon, title, children, onPress, right }: {
  tone?: Tone; icon?: ReactNode; title?: ReactNode; children?: ReactNode; onPress?: () => void; right?: ReactNode;
}) {
  const { c } = useStore();
  const { fg, bg } = toneColors(c, tone);
  const renderSlot = (node: ReactNode, variant: "subheading" | "caption", color?: string) => {
    if (node == null) return null;
    if (isValidElement(node)) return node;
    return <T v={variant} color={color}>{node}</T>;
  };
  const inner = (
    <View style={[row.gap, { alignItems: "flex-start", gap: space.md }]}>
      {icon && <View style={{ marginTop: 1 }}>{icon}</View>}
      <View style={{ flex: 1, gap: 2 }}>
        {renderSlot(title, "subheading", tone === "neutral" ? c.text : fg)}
        {renderSlot(children, "caption", tone === "neutral" ? c.textMuted : c.text)}
      </View>
      {right}
    </View>
  );
  const style: ViewStyle = { backgroundColor: tone === "neutral" ? c.surface : bg, borderRadius: radius.lg, padding: space.md + 2,
    borderWidth: tone === "neutral" ? StyleSheet.hairlineWidth * 2 : 0, borderColor: c.border };
  return onPress
    ? <Pressable onPress={onPress} style={({ pressed }) => [style, { opacity: pressed ? 0.85 : 1 }]}>{inner}</Pressable>
    : <View style={style}>{inner}</View>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <Banner tone="danger">{typeof children === "string" ? children : <>{children}</>}</Banner>;
}

// ---------------------------------------------------------------- controls

export function Button({ title, onPress, variant = "primary", size = "md", disabled, loading, icon, style }: {
  title: string; onPress: () => void; variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md";
  disabled?: boolean; loading?: boolean; icon?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const { c } = useStore();
  const v = {
    primary: { bg: c.accent, fg: c.onAccent, border: c.accent },
    secondary: { bg: c.surfaceAlt, fg: c.text, border: c.border },
    ghost: { bg: "transparent", fg: c.accent, border: "transparent" },
    danger: { bg: c.dangerSoft, fg: c.danger, border: "transparent" },
  }[variant];
  const h = size === "sm" ? 34 : 46;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled || loading}
      style={({ pressed }) => [{
        height: h, paddingHorizontal: size === "sm" ? space.md : space.lg, borderRadius: radius.md,
        backgroundColor: v.bg, borderColor: v.border, borderWidth: StyleSheet.hairlineWidth * 2,
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      }, style]}>
      {loading ? <ActivityIndicator color={v.fg} size="small" /> : icon}
      <Text style={{ color: v.fg, fontSize: size === "sm" ? 13 : 15, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

export function IconButton({ children, onPress, label }: { children: ReactNode; onPress: () => void; label: string }) {
  const { c } = useStore();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? c.surfaceAlt : "transparent" })}>
      {children}
    </Pressable>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  const { c } = useStore();
  // activeThumbColor is react-native-web only (it otherwise defaults to teal).
  const web = { activeThumbColor: "#fff", activeTrackColor: c.accent } as object;
  return <Switch value={value} onValueChange={onChange} accessibilityLabel={label} trackColor={{ true: c.accent, false: c.border }}
    thumbColor="#fff" ios_backgroundColor={c.border} {...web} />;
}

export function Input({ label, value, onChangeText, placeholder, secure, keyboardType, autoComplete, error, right, onSubmitEditing, maxLength, textContentType }: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; secure?: boolean;
  keyboardType?: "default" | "email-address" | "number-pad"; autoComplete?: TextInputProps["autoComplete"];
  textContentType?: TextInputProps["textContentType"]; error?: string | null; right?: ReactNode;
  onSubmitEditing?: () => void; maxLength?: number;
}) {
  const { c } = useStore();
  return (
    <View style={{ gap: 6 }}>
      <T v="label">{label}</T>
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: c.surfaceSolid, borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth * 2, borderColor: error ? c.danger : c.border, paddingHorizontal: space.md }}>
        <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.textFaint}
          secureTextEntry={secure} keyboardType={keyboardType} autoComplete={autoComplete} textContentType={textContentType}
          autoCapitalize="none" autoCorrect={false} onSubmitEditing={onSubmitEditing} maxLength={maxLength} accessibilityLabel={label}
          style={{ flex: 1, color: c.text, fontSize: 16, paddingVertical: 13 }} />
        {right}
      </View>
      {error ? <T v="caption" color={c.danger}>{error}</T> : null}
    </View>
  );
}

export function Segmented<V extends string>({ options, value, onChange }: {
  options: { value: V; label: string }[]; value: V; onChange: (v: V) => void;
}) {
  const { c } = useStore();
  return (
    <View style={{ flexDirection: "row", backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: 3 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={{ flex: 1, paddingVertical: 8, borderRadius: radius.md - 3, alignItems: "center",
              backgroundColor: on ? c.border : "transparent" }}>
            <Text style={{ color: on ? c.text : c.textMuted, fontSize: 13, fontWeight: on ? "600" : "500" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chips<V extends string>({ options, value, onChange }: {
  options: { value: V; label: string }[]; value: V | null; onChange: (v: V) => void;
}) {
  const { c } = useStore();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={{ borderWidth: StyleSheet.hairlineWidth * 2, borderColor: on ? c.warn : c.border, backgroundColor: on ? c.warnSoft : "transparent",
              borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 7 }}>
            <Text style={{ color: on ? c.warn : c.text, fontSize: 13, fontWeight: "600" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- data display

export function ProgressBar({ pct, color, height = 4 }: { pct: number; color?: string; height?: number }) {
  const { c } = useStore();
  const col = color ?? (pct >= 95 ? c.warn : c.accent);
  return (
    <View style={{ height, backgroundColor: c.surfaceAlt, borderRadius: height, overflow: "hidden" }}>
      <View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", backgroundColor: col, borderRadius: height }} />
    </View>
  );
}

/** A row of key figures separated by hairlines. */
export function Metrics({ items }: { items: { label: string; value: ReactNode; color?: string }[] }) {
  const { c } = useStore();
  return (
    <Card padded={false} style={{ flexDirection: "row" }}>
      {items.map((m, i) => (
        <View key={m.label} style={{ flex: 1, paddingVertical: space.md + 2, paddingHorizontal: space.md,
          borderLeftWidth: i ? StyleSheet.hairlineWidth * 2 : 0, borderLeftColor: c.divider, gap: 2 }}>
          <T v="metric" color={m.color} style={{ fontSize: 20 }}>{m.value}</T>
          <T v="caption" numberOfLines={1}>{m.label}</T>
        </View>
      ))}
    </Card>
  );
}

/** Label / value pair for detail grids. */
export function Field({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="caption">{label}</T>
      {typeof value === "string" || typeof value === "number"
        ? <T v="body" color={color} style={{ fontVariant: ["tabular-nums"] }}>{value}</T> : value}
    </View>
  );
}

export function Empty({ title, children, art }: { title: string; children?: ReactNode; art?: ReactNode | null }) {
  return (
    <Card style={{ alignItems: "center", paddingVertical: space.xl }}>
      {art !== null && <View style={{ marginBottom: space.md }}>{art ?? <Ufo size={64} />}</View>}
      <T v="subheading">{title}</T>
      {children && <T v="caption" style={{ textAlign: "center", marginTop: 4, maxWidth: 280 }}>{children}</T>}
    </Card>
  );
}

export function Loading({ label }: { label?: string }) {
  const { c } = useStore();
  return (
    <View style={[row.gap, { padding: space.sm }]}>
      <ActivityIndicator color={c.textMuted} size="small" />
      {label && <T v="caption">{label}</T>}
    </View>
  );
}

export const row = StyleSheet.create({
  between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  gap: { flexDirection: "row", alignItems: "center", gap: space.sm },
}) as { between: ViewStyle; wrap: ViewStyle; gap: ViewStyle };
