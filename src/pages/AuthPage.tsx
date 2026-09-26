import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BookOpenText, Loader2 } from "lucide-react";
import { useAuth } from "../store/AuthContext";

export default function AuthPage({ mode }: { mode: "login" | "register" }) {
  const isRegister = mode === "register";
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isRegister) await register(username, nickname, password);
      else await login(username, password);
      navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="brand-mark h-9 w-9">
            <BookOpenText className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight text-ink">Folio</p>
            <p className="text-xs text-faint">个人知识库 · 把资料变成可检索的答案</p>
          </div>
        </div>

        <div className="card p-6 sm:p-7">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{isRegister ? "创建账户" : "登录账户"}</h1>

          <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
            {isRegister && (
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-ink">昵称</span>
                <input className="input" required value={nickname} onChange={(event) => setNickname(event.target.value)} />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">用户名</span>
              <input className="input" required type="text" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">密码</span>
              <input
                className="input"
                required
                minLength={8}
                type="password"
                autoComplete={isRegister ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {isRegister && <span className="mt-1.5 block text-xs text-faint">至少 8 位字符</span>}
            </label>
            {error && <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
            <button className="btn btn-primary w-full py-2.5" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isRegister ? "注册并开始使用" : "登录"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-muted">
            {isRegister ? "已有账户？" : "还没有账户？"}
            <Link className="ml-1 font-medium text-brand hover:text-brand-dark hover:underline" to={isRegister ? "/login" : "/register"}>
              {isRegister ? "立即登录" : "立即注册"}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
