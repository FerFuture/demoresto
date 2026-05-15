import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import Login from "./screens/Login";
import AdminApp from "./screens/AdminApp";
import DeliveryApp from "./screens/DeliveryApp";
import KitchenApp from "./screens/KitchenApp";
import WaiterApp from "./screens/WaiterApp";
import MesaClientApp from "./screens/MesaClientApp";
import PublicMenuApp from "./screens/PublicMenuApp";
import { getSession, logout, SESSION_REVALIDATE_MS, validateStoredSession } from "./lib/auth";

function homePathForRole(role) {
  if (role === "admin" || role === "maestro" || role === "encargado") return "/admin";
  if (role === "delivery") return "/delivery";
  if (role === "kitchen") return "/kitchen";
  if (role === "waiter") return "/waiter";
  return "/login";
}

function sessionInvalidationMessage(reason) {
  if (reason === "user_updated") {
    return "Tu usuario fue actualizado. Iniciá sesión nuevamente.";
  }
  if (reason === "role_changed") {
    return "Tu rol cambió. Iniciá sesión nuevamente.";
  }
  if (reason === "user_inactive_or_deleted") {
    return "Tu usuario fue desactivado o eliminado.";
  }
  return "Tu sesión ya no es válida. Iniciá sesión nuevamente.";
}

function AppRoutes() {
  const [session, setSession] = useState(() => getSession());
  const [sessionNotice, setSessionNotice] = useState("");
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    setSession(null);
    setSessionNotice("");
    navigate("/login", { replace: true });
  }

  function onLoggedIn(nextSession) {
    setSessionNotice("");
    setSession(nextSession);
    navigate(homePathForRole(nextSession.role), { replace: true });
  }

  useEffect(() => {
    if (!session) return undefined;
    let cancelled = false;

    async function checkSession() {
      const result = await validateStoredSession(session);
      if (cancelled) return;
      if (result.ok) {
        if (result.session && result.session.userUpdatedAt !== session.userUpdatedAt) {
          setSession(result.session);
        }
        return;
      }
      logout();
      setSession(null);
      setSessionNotice(sessionInvalidationMessage(result.reason));
      navigate("/login", { replace: true });
    }

    checkSession();
    const intervalId = window.setInterval(checkSession, SESSION_REVALIDATE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [navigate, session]);

  return (
    <Routes>
      <Route path="/carta" element={<MesaClientApp />} />
      <Route path="/menu" element={<PublicMenuApp />} />
      <Route
        path="/login"
        element={
          session ? (
            <Navigate to={homePathForRole(session.role)} replace />
          ) : (
            <Login onLoggedIn={onLoggedIn} sessionNotice={sessionNotice} />
          )
        }
      />
      <Route
        path="/admin"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : session.role !== "admin" && session.role !== "maestro" && session.role !== "encargado" ? (
            <Navigate to={homePathForRole(session.role)} replace />
          ) : (
            <AdminApp onLogout={handleLogout} />
          )
        }
      />
      <Route
        path="/delivery"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : session.role !== "delivery" ? (
            <Navigate to={homePathForRole(session.role)} replace />
          ) : (
            <DeliveryApp onLogout={handleLogout} />
          )
        }
      />
      <Route
        path="/kitchen"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : session.role !== "kitchen" ? (
            <Navigate to={homePathForRole(session.role)} replace />
          ) : (
            <KitchenApp onLogout={handleLogout} />
          )
        }
      />
      <Route
        path="/waiter"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : session.role !== "waiter" ? (
            <Navigate to={homePathForRole(session.role)} replace />
          ) : (
            <WaiterApp onLogout={handleLogout} />
          )
        }
      />
      <Route
        path="/"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : (
            <Navigate to={homePathForRole(session.role)} replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
