import Svg, { Circle, Ellipse } from "react-native-svg";
import { useStore } from "../store";

/** Brand mark: a planet with a tilted orbit and a satellite on it. */
export default function Logo({ size = 30 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Circle cx={16} cy={16} r={7} fill="#F59E0B" stroke="#D97706" strokeWidth={1.2} />
      <Ellipse cx={16} cy={16} rx={14} ry={4.5} fill="none" stroke="#FFFFFF" strokeOpacity={0.8} strokeWidth={1.4} transform="rotate(-24 16 16)" />
      <Circle cx={27.6} cy={10.4} r={2} fill="#FFFFFF" />
    </Svg>
  );
}
