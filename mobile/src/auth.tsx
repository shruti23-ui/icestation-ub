import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { ApiError, authApi, setAuthToken, setOnUnauthorized, type Account, type CodeSent } from "./api";
import { useStore } from "./store";

const TOKEN_KEY = "weparkit_token";

// Token lives in the OS keychain/keystore on phones; browsers only have localStorage.
const tokenStore = Platform.OS === "web"
  ? { get: () => AsyncStorage.getItem(TOKEN_KEY), set: (v: string) => AsyncStorage.setItem(TOKEN_KEY, v), del: () => AsyncStorage.removeItem(TOKEN_KEY) }
  : { get: () => SecureStore.getItemAsync(TOKEN_KEY), set: (v: string) => SecureStore.setItemAsync(TOKEN_KEY, v), del: () => SecureStore.deleteItemAsync(TOKEN_KEY) };

type Status = "loading" | "signedOut" | "signedIn";

interface Auth {
  status: Status;
  account: Account | null;
  login: (email: string, password: string) => Promise<{ verify?: CodeSent }>;
  /** Signs in immediately; returns a CodeSent only if the server requires email verification. */
  signup: (email: string, password: string) => Promise<{ verify?: CodeSent }>;
  verify: (email: string, code: string) => Promise<void>;
  resend: (email: string) => Promise<CodeSent>;
  /** Sign in with a Google ID token (verified by the backend). */
  googleSignIn: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
  continueAsGuest: () => void;
}

const Ctx = createContext<Auth | null>(null);

/** UB-email session: restores the saved token on launch, signs in/up/out, and signs out locally when the
 *  server rejects the token. The rest of the app only renders when `status === "signedIn"`. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { user, refresh, toast } = useStore();
  const [status, setStatus] = useState<Status>("loading");
  const [account, setAccount] = useState<Account | null>(null);

  const signOutLocal = useCallback(async () => {
    setAuthToken(null);
    await tokenStore.del().catch(() => {});
    setAccount(null);
    setStatus("signedOut");
  }, []);

  const adopt = useCallback(async (token: string, acct: Account) => {
    setAuthToken(token);
    await tokenStore.set(token).catch(() => {});
    setAccount(acct);
    setStatus("signedIn");
    refresh("crew", "lots", "notifications");  // load this student's own profile
  }, [refresh]);

  useEffect(() => {
    setOnUnauthorized(() => { toast("Your session expired. Please log in again.", "info"); signOutLocal(); });
    (async () => {
      const token = await tokenStore.get().catch(() => null);
      if (!token) return setStatus("signedOut");
      setAuthToken(token);
      try {
        const { account: acct } = await authApi.me();
        setAccount(acct);
        setStatus("signedIn");
        refresh("crew");
      } catch (e) {
        // Offline at launch: keep the saved session rather than kicking the student out.
        if (e instanceof ApiError && e.status === 0) { setStatus("signedIn"); return; }
        signOutLocal();
      }
    })();
    return () => setOnUnauthorized(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (email: string, password: string) => {
    try {
      const s = await authApi.login(email, password);
      await adopt(s.token, s.account);
      return {};
    } catch (e) {
      // Unverified account: the server sends a fresh code and tells us to verify.
      if (e instanceof ApiError && e.status === 403 && e.data?.verification_required) return { verify: e.data as unknown as CodeSent };
      throw e;
    }
  }, [adopt]);

  const signup = useCallback(async (email: string, password: string) => {
    const r = await authApi.signup({ email, password, anonymous_user_id: user?.id ?? null });
    if (r.verification_required) return { verify: r };
    await adopt(r.token, r.account);
    return {};
  }, [user?.id, adopt]);

  const verify = useCallback(async (email: string, code: string) => {
    const s = await authApi.verify(email, code);
    await adopt(s.token, s.account);
  }, [adopt]);

  const resend = useCallback((email: string) => authApi.resend(email), []);

  const googleSignIn = useCallback(async (idToken: string) => {
    const s = await authApi.google(idToken, user?.id ?? null);
    await adopt(s.token, s.account);
  }, [user?.id, adopt]);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    await signOutLocal();
  }, [signOutLocal]);

  const continueAsGuest = useCallback(() => {
    setAccount(null);
    setStatus("signedIn");
  }, []);

  const value = useMemo<Auth>(() => ({ status, account, login, signup, verify, resend, googleSignIn, logout, continueAsGuest }),
    [status, account, login, signup, verify, resend, googleSignIn, logout, continueAsGuest]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAuth must be used inside AuthProvider");
  return a;
}
