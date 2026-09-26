import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { AuthUser } from "../types";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, nickname: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const authRequestVersion = useRef(0);

  useEffect(() => {
    const version = ++authRequestVersion.current;
    let active = true;
    void api.me()
      .then((result) => {
        if (active && version === authRequestVersion.current) setUser(result.user);
      })
      .catch(() => {
        if (active && version === authRequestVersion.current) setUser(null);
      })
      .finally(() => {
        if (active && version === authRequestVersion.current) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function login(username: string, password: string) {
    ++authRequestVersion.current;
    setError(null);
    try {
      setUser((await api.login(username, password)).user);
      setLoading(false);
    }
    catch (reason) { const message = reason instanceof Error ? reason.message : "登录失败"; setError(message); throw reason; }
  }

  async function register(username: string, nickname: string, password: string) {
    ++authRequestVersion.current;
    setError(null);
    try {
      setUser((await api.register(username, nickname, password)).user);
      setLoading(false);
    }
    catch (reason) { const message = reason instanceof Error ? reason.message : "注册失败"; setError(message); throw reason; }
  }

  async function logout() {
    await api.logout();
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, error, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
