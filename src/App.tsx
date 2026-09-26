import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import DocsPage from "./pages/DocsPage";
import QAPage from "./pages/QAPage";
import { DocsProvider } from "./store/DocsContext";
import AuthPage from "./pages/AuthPage";
import RequireAuth from "./components/RequireAuth";
import { AuthProvider } from "./store/AuthContext";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<RequireAuth><DocsProvider><Layout /></DocsProvider></RequireAuth>}>
          <Route path="/" element={<DocsPage />} />
          <Route path="/qa" element={<QAPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
