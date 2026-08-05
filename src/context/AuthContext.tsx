import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { supabase } from "../lib/supabase";
import type { User, Session } from "@supabase/supabase-js";

// ─── Types ──────────────────────────────────────────────────────────────

interface LocalProfile {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
}

interface AuthState {
  user: User | LocalProfile | null;
  session: Session | null;
  isLoading: boolean;
  isLocal: boolean;
  streak: number;
  totalSessions: number;
  averageClarity: number;
}

interface AuthContextType extends AuthState {
  signUp: (email: string, password: string, displayName?: string) => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  demoLogin: (displayName?: string) => void;
  saveSessionData: (clarity: number) => void;
  getSessionHistory: () => { clarity: number; date: string }[];
}

// ─── LocalStorage helpers ────────────────────────────────────────────────

const LOCAL_USER_KEY = "bolo_local_user";
const LOCAL_STREAK_KEY = "bolo_streak";
const LOCAL_SESSIONS_KEY = "bolo_sessions";

function getLocalUser(): LocalProfile | null {
  try {
    const raw = localStorage.getItem(LOCAL_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function getLocalStreak(): number {
  try {
    const raw = localStorage.getItem(LOCAL_STREAK_KEY);
    if (!raw) return 0;
    const { streak, lastDate } = JSON.parse(raw);
    const today = new Date().toDateString();
    const last = new Date(lastDate).toDateString();
    if (last === today) return streak;
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (last === yesterday) return streak;
    return 0;
  } catch { return 0; }
}

function updateLocalStreak(): number {
  const today = new Date().toDateString();
  let streak = 1;
  try {
    const raw = localStorage.getItem(LOCAL_STREAK_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      const last = new Date(data.lastDate).toDateString();
      if (last === today) {
        streak = data.streak;
      } else {
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        streak = last === yesterday ? data.streak + 1 : 1;
      }
    }
  } catch { streak = 1; }
  localStorage.setItem(LOCAL_STREAK_KEY, JSON.stringify({ streak, lastDate: today }));
  return streak;
}

function getLocalSessions(): { clarity: number; date: string }[] {
  try {
    const raw = localStorage.getItem(LOCAL_SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ─── Context ────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    isLoading: true,
    isLocal: false,
    streak: 0,
    totalSessions: 0,
    averageClarity: 0,
  });

  // ── Init: check Supabase session or local fallback ──────────────
  useEffect(() => {
    const init = async () => {
      try {
        // Try Supabase first
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const sessions = getLocalSessions();
          setState({
            user: session.user,
            session,
            isLoading: false,
            isLocal: false,
            streak: getLocalStreak(),
            totalSessions: sessions.length,
            averageClarity: sessions.length > 0
              ? Math.round(sessions.reduce((a, s) => a + s.clarity, 0) / sessions.length)
              : 0,
          });
          return;
        }
      } catch {
        // Supabase unavailable — fall through to local
      }

      // Fallback to local
      const localUser = getLocalUser();
      const sessions = getLocalSessions();
      setState({
        user: localUser,
        session: null,
        isLoading: false,
        isLocal: true,
        streak: getLocalStreak(),
        totalSessions: sessions.length,
        averageClarity: sessions.length > 0
          ? Math.round(sessions.reduce((a, s) => a + s.clarity, 0) / sessions.length)
          : 0,
      });
    };

    init();

    // Listen for Supabase auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const sessions = getLocalSessions();
        setState(prev => ({
          ...prev,
          user: session.user,
          session,
          isLocal: false,
          streak: getLocalStreak(),
          totalSessions: sessions.length,
          averageClarity: sessions.length > 0
            ? Math.round(sessions.reduce((a, s) => a + s.clarity, 0) / sessions.length)
            : 0,
        }));
      } else {
        setState(prev => ({
          ...prev,
          user: null,
          session: null,
        }));
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Sign Up ────────────────────────────────────────────────────
  const signUp = useCallback(async (email: string, password: string, displayName?: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName || email.split("@")[0] } },
      });
      if (error) return error.message;
      if (data.user) {
        const sessions = getLocalSessions();
        setState({
          user: data.user,
          session: data.session,
          isLocal: false,
          isLoading: false,
          streak: getLocalStreak(),
          totalSessions: sessions.length,
          averageClarity: sessions.length > 0
            ? Math.round(sessions.reduce((a, s) => a + s.clarity, 0) / sessions.length)
            : 0,
        });
      }
      return null;
    } catch (err: any) {
      return err.message || "Sign up failed";
    }
  }, []);

  // ── Sign In ────────────────────────────────────────────────────
  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return error.message;
      if (data.user) {
        const sessions = getLocalSessions();
        setState({
          user: data.user,
          session: data.session,
          isLocal: false,
          isLoading: false,
          streak: getLocalStreak(),
          totalSessions: sessions.length,
          averageClarity: sessions.length > 0
            ? Math.round(sessions.reduce((a, s) => a + s.clarity, 0) / sessions.length)
            : 0,
        });
      }
      return null;
    } catch (err: any) {
      return err.message || "Sign in failed";
    }
  }, []);

  // ── Sign Out ───────────────────────────────────────────────────
  const signOut = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch { /* ignore */ }
    setState({
      user: null,
      session: null,
      isLoading: false,
      isLocal: false,
      streak: 0,
      totalSessions: 0,
      averageClarity: 0,
    });
  }, []);

  // ── Demo Login (localStorage fallback) ─────────────────────────
  const demoLogin = useCallback((displayName?: string) => {
    const profile: LocalProfile = {
      id: "demo-user-" + Date.now(),
      email: "demo@bolo.app",
      displayName: displayName || "Demo User",
      createdAt: Date.now(),
    };
    localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(profile));

    // Merge any existing session data
    const sessions = getLocalSessions();
    setState({
      user: profile,
      session: null,
      isLoading: false,
      isLocal: true,
      streak: getLocalStreak(),
      totalSessions: sessions.length,
      averageClarity: sessions.length > 0
        ? Math.round(sessions.reduce((a, s) => a + s.clarity, 0) / sessions.length)
        : 0,
    });
  }, []);

  // ── Save session data (clarity score) ──────────────────────────
  const saveSessionData = useCallback((clarity: number) => {
    const sessions = getLocalSessions();
    sessions.push({ clarity, date: new Date().toISOString() });
    // Keep last 100
    const trimmed = sessions.slice(-100);
    localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(trimmed));
    const streak = updateLocalStreak();
    setState(prev => ({
      ...prev,
      streak,
      totalSessions: trimmed.length,
      averageClarity: Math.round(trimmed.reduce((a, s) => a + s.clarity, 0) / trimmed.length),
    }));
  }, []);

  // ── Get session history ────────────────────────────────────────
  const getSessionHistory = useCallback(() => {
    return getLocalSessions();
  }, []);

  return (
    <AuthContext.Provider value={{
      ...state,
      signUp,
      signIn,
      signOut,
      demoLogin,
      saveSessionData,
      getSessionHistory,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}