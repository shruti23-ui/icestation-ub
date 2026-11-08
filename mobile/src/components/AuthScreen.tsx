import { Eye, EyeOff, Mail } from "lucide-react-native";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { authApi } from "../api";
import { useAuth } from "../auth";
import GoogleButton from "./GoogleButton";
import { useStore } from "../store";
import { space } from "../theme";
import Logo from "./Logo";
import { Alien } from "./SpaceArt";
import Starfield from "./Starfield";
import { Banner, Button, Card, DemoTag, Input, T, row } from "./ui";

type Mode = "login" | "signup";
const ALLOWED_EMAIL = /^[a-z0-9][a-z0-9._%+-]{0,63}@(buffalo\.edu|gmail\.com)$/i;

/** Email + password with a UB or Gmail account. Create account signs you straight in. (If the server
 *  turns on email verification, a code step appears; it's off by default.) */
export default function AuthScreen() {
  const { c } = useStore();
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({});
  // verification step
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  // Google sign-in appears only when the server has an OAuth client ID configured.
  const [googleId, setGoogleId] = useState<string | null>(null);
  useEffect(() => {
    authApi.providers().then((p) => setGoogleId(p.google ? (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || p.google_client_ids[0]) : null)).catch(() => {});
  }, []);
  const google = async (idToken: string) => { setError(null); await auth.googleSignIn(idToken); };

  const validate = () => {
    const e = email.trim().toLowerCase();
    const errs: typeof fieldErr = {};
    if (!ALLOWED_EMAIL.test(e)) errs.email = "Use a @buffalo.edu or @gmail.com email.";
    if (password.length < 8) errs.password = "At least 8 characters.";
    setFieldErr(errs);
    return Object.keys(errs).length ? null : e;
  };

  const toVerify = (addr: string, sent: { email_sent: boolean; dev_code?: string }) => {
    setVerifyFor(addr); setCode(""); setDevCode(sent.dev_code ?? null); setEmailSent(sent.email_sent); setError(null);
  };

  const submit = async () => {
    const e = validate();
    if (!e) return;
    setBusy(true); setError(null);
    try {
      const r = mode === "signup" ? await auth.signup(e, password) : await auth.login(e, password);
      if (r.verify) toVerify(e, r.verify);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const confirm = async (value = code) => {
    if (!verifyFor || value.trim().length < 6) return setError("Enter the 6-digit code.");
    setBusy(true); setError(null);
    try { await auth.verify(verifyFor, value.trim()); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    if (!verifyFor) return;
    try { const r = await auth.resend(verifyFor); setDevCode(r.dev_code ?? devCode); setEmailSent(r.email_sent); setError(null); }
    catch (err) { setError((err as Error).message); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <Starfield />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space.xl, gap: space.xl }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: "center", gap: space.sm }}>
            <Logo size={56} />
            <T v="title" style={{ fontSize: 34 }}>WeParkit</T>
            <T v="body" color={c.textMuted} style={{ textAlign: "center" }}>UB parking at North Campus</T>
          </View>

          {verifyFor ? (
            <Card style={{ gap: space.lg }}>
              <View style={[row.gap, { gap: space.md }]}>
                <Mail size={22} color={c.accent} />
                <View style={{ flex: 1 }}>
                  <T v="subheading">Check your email</T>
                  <T v="caption">{emailSent ? `We sent a 6-digit code to ${verifyFor}.` : `Enter the 6-digit code for ${verifyFor}.`}</T>
                </View>
              </View>
              {devCode && (
                <Banner tone="warn" title={<View style={row.gap}><DemoTag /><T v="subheading" color={c.warn}>Email isn't set up on this server</T></View>}
                  right={<Button size="sm" variant="secondary" title="Use it" onPress={() => { setCode(devCode); confirm(devCode); }} />}>
                  {`Demo mode shows the code here instead: ${devCode}`}
                </Banner>
              )}
              <Input label="Verification code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code"
                maxLength={6} onSubmitEditing={() => confirm()} />
              {error && <Banner tone="danger">{error}</Banner>}
              <Button title="Verify and continue" onPress={() => confirm()} loading={busy} />
              <View style={row.between}>
                <Pressable onPress={() => { setVerifyFor(null); setError(null); }} hitSlop={8}><T v="label" color={c.accent}>Back</T></Pressable>
                <Pressable onPress={resend} hitSlop={8}><T v="label" color={c.accent}>Send a new code</T></Pressable>
              </View>
            </Card>
          ) : (
            <Card style={{ gap: space.lg }}>
              <T v="heading">{mode === "signup" ? "Create your account" : "Log in"}</T>
              <Input label="Email" value={email} onChangeText={setEmail} placeholder="you@buffalo.edu or you@gmail.com" keyboardType="email-address"
                autoComplete="email" textContentType="emailAddress" error={fieldErr.email} maxLength={120} />
              <Input label="Password" value={password} onChangeText={setPassword} placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
                secure={!show} autoComplete={mode === "signup" ? "new-password" : "current-password"}
                textContentType={mode === "signup" ? "newPassword" : "password"} error={fieldErr.password} maxLength={128} onSubmitEditing={submit}
                right={<Pressable onPress={() => setShow((s) => !s)} hitSlop={10} accessibilityLabel={show ? "Hide password" : "Show password"}>
                  {show ? <EyeOff size={18} color={c.textMuted} /> : <Eye size={18} color={c.textMuted} />}
                </Pressable>} />
              {error && <Banner tone="danger">{error}</Banner>}
              <Button title={mode === "signup" ? "Create account" : "Log in"} onPress={submit} loading={busy} />
              {googleId && (
                <>
                  <View style={[row.gap, { gap: space.md }]}>
                    <View style={{ flex: 1, height: 1, backgroundColor: c.divider }} /><T v="caption">or</T><View style={{ flex: 1, height: 1, backgroundColor: c.divider }} />
                  </View>
                  <GoogleButton webClientId={googleId} onIdToken={google} onError={setError} />
                </>
              )}
              <Pressable onPress={() => { setMode(mode === "signup" ? "login" : "signup"); setError(null); setFieldErr({}); }} hitSlop={8}
                style={{ alignItems: "center" }} accessibilityRole="button">
                <T v="label" color={c.accent}>{mode === "signup" ? "Already have an account? Log in" : "New here? Create an account"}</T>
              </Pressable>
              <View style={{ height: 1, backgroundColor: c.divider, marginVertical: space.xs }} />
              <Pressable onPress={auth.continueAsGuest} hitSlop={8} style={{ alignItems: "center" }} accessibilityRole="button">
                <T v="label" color={c.textMuted}>Browse campus parking as guest →</T>
              </Pressable>
            </Card>
          )}

          <View style={{ alignItems: "center", opacity: 0.85 }}><Alien size={40} /></View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
