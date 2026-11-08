// Design tokens: deep-space palette. Translucent surfaces sit over the starfield backdrop
// (components/Starfield.tsx). Ice season swaps the accent from brand blue to amber.

const space_ = {
  // Deep space navy: near-black navy base, layered navy cards, cool silver-blue text, brand blue accent.
  bg: "#050817",
  surface: "rgba(17,25,54,0.86)",
  surfaceAlt: "rgba(34,48,96,0.55)",
  surfaceSolid: "#0F1735",
  border: "rgba(148,168,230,0.14)",
  divider: "rgba(148,168,230,0.09)",
  text: "#EDF0FA",
  textMuted: "#99A4C6",
  textFaint: "#5E6A91",
  blue: "#4479EC",        // WeParkit brand blue (the app icon is #1A4FA8; this is a touch brighter for dark mode)
  brand: "#1A4FA8",
  violet: "#8B7CFF",
  amber: "#FFB547",
  success: "#4ADE9B",
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
    accent: ice ? space_.amber : space_.blue,
    onAccent: ice ? "#1C1203" : "#FFFFFF",
    accentSoft: ice ? "rgba(255,181,71,0.14)" : "rgba(46,102,209,0.20)",
    warn: space_.amber,
    warnSoft: "rgba(255,181,71,0.14)",
    dangerSoft: "rgba(255,107,107,0.14)",
    successSoft: "rgba(74,222,155,0.14)",
    isIce: ice,
  };
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 };
