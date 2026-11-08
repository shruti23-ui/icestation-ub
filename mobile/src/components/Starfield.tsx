import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { useStore } from "../store";
import { Planet, Ufo, useSvgId } from "./SpaceArt";

const native = Platform.OS !== "web";

// Deterministic PRNG so the sky doesn't reshuffle on every render.
function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

/** Fixed backdrop: nebula glow, stars, a ringed planet, a passing UFO and the odd shooting star.
 *  Sits behind scroll content and ignores touches. */
function Starfield() {
  const { c } = useStore();
  const { width, height } = useWindowDimensions();
  const ids = { a: useSvgId("nebA"), b: useSvgId("nebB"), t: useSvgId("trail") };
  const stars = useMemo(() => {
    const r = rng(7);
    const n = Math.round((width * height) / 5200);
    return Array.from({ length: n }, () => ({ x: r() * width, y: r() * height, s: r() < 0.08 ? 2 : r() < 0.4 ? 1.4 : 1, o: 0.25 + r() * 0.6 }));
  }, [width, height]);

  // UFO crosses the sky every ~45 s with a gentle bob.
  const ufoX = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  // Shooting star every ~11 s.
  const shoot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anims = [
      Animated.loop(Animated.sequence([
        Animated.delay(6000),
        Animated.timing(ufoX, { toValue: 1, duration: 22000, easing: Easing.linear, useNativeDriver: native }),
        Animated.delay(17000),
      ])),
      Animated.loop(Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
        Animated.timing(bob, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
      ])),
      Animated.loop(Animated.sequence([
        Animated.delay(9000),
        Animated.timing(shoot, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.timing(shoot, { toValue: 0, duration: 0, useNativeDriver: native }),
      ])),
    ];
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [ufoX, bob, shoot]);

  const ufoTranslate = ufoX.interpolate({ inputRange: [0, 1], outputRange: [-70, width + 70] });
  const ufoTilt = ufoX.interpolate({ inputRange: [0, 0.5, 1], outputRange: ["-6deg", "4deg", "-6deg"] });
  const ufoBob = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });
  const starX = shoot.interpolate({ inputRange: [0, 1], outputRange: [0, -width * 0.45] });
  const starY = shoot.interpolate({ inputRange: [0, 1], outputRange: [0, width * 0.26] });
  const starO = shoot.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [0, 1, 0.8, 0] });

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id={ids.a} cx="80%" cy="0%" r="70%">
            <Stop offset="0" stopColor={c.accent} stopOpacity={0.2} />
            <Stop offset="1" stopColor={c.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={ids.b} cx="0%" cy="35%" r="60%">
            <Stop offset="0" stopColor={c.violet} stopOpacity={0.14} />
            <Stop offset="1" stopColor={c.violet} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={width * 0.8} cy={0} r={Math.max(width, height) * 0.7} fill={`url(#${ids.a})`} />
        <Circle cx={0} cy={height * 0.35} r={Math.max(width, height) * 0.6} fill={`url(#${ids.b})`} />
        {stars.map((s, i) => <Circle key={i} cx={s.x} cy={s.y} r={s.s / 2} fill="#FFFFFF" opacity={s.o * 0.9} />)}
      </Svg>

      <View style={{ position: "absolute", right: -48, top: height * 0.42 }}>
        <Planet size={150} opacity={0.45} />
      </View>

      <Animated.View style={{ position: "absolute", top: height * 0.2, left: 0, opacity: 0.75,
        transform: [{ translateX: ufoTranslate }, { translateY: ufoBob }, { rotate: ufoTilt }] }}>
        <Ufo size={44} beam={false} />
      </Animated.View>

      <Animated.View style={{ position: "absolute", top: height * 0.08, left: width * 0.75, opacity: starO,
        transform: [{ translateX: starX }, { translateY: starY }, { rotate: "-30deg" }] }}>
        <Svg width={70} height={2}>
          <Defs>
            <LinearGradient id={ids.t} x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={1} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width={70} height={2} rx={1} fill={`url(#${ids.t})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}

export default memo(Starfield);
