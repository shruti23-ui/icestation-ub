// Design tokens: Emerald & Amber deep-space palette.
// Vibrant emerald green for primary actions & WeParkIt brand; warm amber gold for active tabs & chips.

const space_ = {
  bg: "#060A16",
  surface: "rgba(14, 23, 48, 0.85)",
  surfaceAlt: "rgba(24, 38, 76, 0.65)",
  surfaceSolid: "#0B132B",
  border: "rgba(130, 160, 255, 0.16)",
  divider: "rgba(130, 160, 255, 0.10)",
  text: "#FFFFFF",
  textMuted: "#8D99BD",
  textFaint: "#55618A",
  green: "#22C55E",
  blue: "#6CC6FF",
  violet: "#8B7CFF",
  amber: "#FFB547",
  success: "#22C55E",
  danger: "#FF6B6B",
};

export type Palette = typeof space_ & {
  accent: string; onAccent: string; accentSoft: string;
  warn: string; warnSoft: string; dangerSoft: string; successSoft: string;
  isIce: boolean;
};

export function palette(ice: boolean): Palette {
  return {
    ...space_,
    accent: "#22C55E", // Vibrant emerald green for all primary buttons, toggles & CTAs
    onAccent: "#021208", // Contrast dark text on emerald green
    accentSoft: "rgba(34, 197, 94, 0.15)",
    warn: "#FFB547", // Warm amber gold for active tabs & selected chips
    warnSoft: "rgba(255, 181, 71, 0.15)",
    dangerSoft: "rgba(255, 107, 107, 0.14)",
    successSoft: "rgba(34, 197, 94, 0.15)",
    isIce: ice,
  };
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 };
