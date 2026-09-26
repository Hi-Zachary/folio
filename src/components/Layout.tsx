import { NavLink, Outlet } from "react-router-dom";
import { BookOpenText, FolderKanban, LogOut, MessageCircleQuestion } from "lucide-react";
import { useAuth } from "../store/AuthContext";

const navItems = [
  { to: "/", label: "资料库", icon: FolderKanban },
  { to: "/qa", label: "问答", icon: MessageCircleQuestion },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="brand-mark">
        <BookOpenText className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-tight text-ink">Folio</p>
        {!compact && <p className="text-xs text-faint">个人知识库 · 把资料变成可检索的答案</p>}
      </div>
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-paper text-ink">
      <aside className="hidden w-60 flex-col border-r border-line bg-card md:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `side-link ${isActive ? "bg-brand-soft text-brand-dark" : ""}`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-line px-5 py-4">
          <p className="truncate text-sm font-medium text-ink">{user?.nickname}</p>
          <p className="truncate text-xs text-faint">{user?.username}</p>
          <button onClick={() => void logout()} className="btn btn-ghost mt-2 -ml-2 px-2 py-1.5 text-xs">
            <LogOut className="h-3.5 w-3.5" />退出登录
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line bg-card px-4 py-3 md:hidden">
          <Brand compact />
          <button onClick={() => void logout()} className="btn btn-ghost px-2 py-2" title="退出登录">
            <LogOut className="h-4 w-4" />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `tab-link justify-self-stretch ${isActive ? "text-brand-dark" : ""}`}
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
