import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../store/AuthContext";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return <div className="flex h-dvh items-center justify-center bg-paper text-sm text-faint">正在验证登录状态…</div>;
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
