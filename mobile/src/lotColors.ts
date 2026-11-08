import { lotFull, type Lot } from "./api";
import type { Palette } from "./theme";

/** Traffic-light availability for map labels and outlines: green = plenty open, amber = filling up, red = full. */
export function availability(lot: Lot, c: Palette) {
  // Open/total spaces (e.g. 12/30). A full lot reads as taken/total (20/20): every space is filled.
  const label = `${lot.available}/${lot.snow_adjusted_capacity}`;
  if (lotFull(lot)) return { fill: c.danger, ink: "#FFFFFF", label: `${lot.snow_adjusted_capacity}/${lot.snow_adjusted_capacity}`, level: "full" as const };
  if (lot.occupancy_pct >= 75) return { fill: c.warn, ink: "#1B1305", label, level: "tight" as const };
  return { fill: c.success, ink: "#04210F", label, level: "open" as const };
}
