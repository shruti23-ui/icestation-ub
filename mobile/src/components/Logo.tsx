import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop, Text as SvgText } from "react-native-svg";

export const BRAND_BLUE = "#1A4FA8";
/** Icon background: deep space navy with a blue-violet nebula. */
export const SPACE_TOP = "#141A4A";
export const SPACE_BOTTOM = "#050817";
const STARS: [number, number, number][] = [[14, 14, 1.1], [86, 12, 0.9], [90, 70, 1.2], [9, 80, 0.8], [70, 8, 0.7], [26, 92, 0.9], [80, 90, 0.7], [6, 40, 0.6], [94, 36, 0.7]];

/** WeParkit mark (matches the app icon): a parking pin inside two circling arrows on a deep-space tile.
 *  `tile` draws the rounded blue square; `name` adds "WeParkit" under it (sign-in screen). */
export default function Logo({ size = 30, tile = true, name = false }: { size?: number; tile?: boolean; name?: boolean }) {
  const fg = tile ? "#FFFFFF" : BRAND_BLUE;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id="wpSky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={SPACE_TOP} /><Stop offset="1" stopColor={SPACE_BOTTOM} />
        </LinearGradient>
        <RadialGradient id="wpNebula" cx="70%" cy="25%" r="65%">
          <Stop offset="0" stopColor="#5B6CFF" stopOpacity={0.45} /><Stop offset="1" stopColor="#5B6CFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {tile && (
        <>
          <Rect x={0} y={0} width={100} height={100} rx={22} fill="url(#wpSky)" />
          <Rect x={0} y={0} width={100} height={100} rx={22} fill="url(#wpNebula)" />
          {STARS.map(([x, y, r], i) => <Circle key={i} cx={x} cy={y} r={r} fill="#FFFFFF" opacity={0.8} />)}
        </>
      )}
      <PinAndArrows fg={fg} bg={tile ? "#18205A" : "#FFFFFF"} dy={name ? -6 : 0} scale={name ? 0.8 : 1} />
      {name && (
        <SvgText x={50} y={90} fill={fg} fontSize={15} fontWeight="800" textAnchor="middle">WeParkit</SvgText>
      )}
    </Svg>
  );
}

function PinAndArrows({ fg, bg, dy, scale }: { fg: string; bg: string; dy: number; scale: number }) {
  const t = `translate(${50 - 50 * scale} ${50 - 50 * scale + dy}) scale(${scale})`;
  return (
    <>
      {/* circling arrows: top arc left -> right (head points down), bottom arc right -> left (head points up) */}
      <Path d="M 21 57 A 30 30 0 1 1 79 50" stroke={fg} strokeWidth={5} fill="none" strokeLinecap="round" transform={t} />
      <Path d="M 72 47 L 86 47 L 79 59 Z" fill={fg} transform={t} />
      <Path d="M 77 63 A 30 30 0 0 1 21 46" stroke={fg} strokeWidth={5} fill="none" strokeLinecap="round" transform={t} />
      <Path d="M 14 49 L 28 49 L 21 37 Z" fill={fg} transform={t} />
      {/* parking pin */}
      <Path d="M 50 72 L 37.5 50 A 14.5 14.5 0 1 1 62.5 50 Z" fill={fg} transform={t} />
      <Circle cx={50} cy={42} r={9.5} fill={bg} transform={t} />
      <SvgText x={50} y={47.5} fill={fg} fontSize={14} fontWeight="800" textAnchor="middle" transform={t}>P</SvgText>
    </>
  );
}
