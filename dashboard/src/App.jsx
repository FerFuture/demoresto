import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams
} from "react-router-dom";
import Login from "./screens/Login";
import DemoHome from "./screens/DemoHome";
import AdminApp from "./screens/AdminApp";
import DeliveryApp from "./screens/DeliveryApp";
import KitchenApp from "./screens/KitchenApp";
import WaiterApp from "./screens/WaiterApp";
import MesaClientApp from "./screens/MesaClientApp";
import PublicMenuApp from "./screens/PublicMenuApp";
import { DemoTenantContext } from "./lib/DemoTenantContext";
import {
  demoBasePath,
  getSession,
  loginRoutePath,
  logout,
  SESSION_REVALIDATE_MS,
  validateStoredSession
} from "./lib/auth";

const DEFAULT_DEMO_SLUG = String(import.meta.env.VITE_DEFAULT_DEMO_SLUG || "").trim();

function homePathForRole(role, session) {
  const base = demoBasePath(session);
  if (role === "admin" || role === "maestro" || role === "encargado") return `${base}/admin`;
  if (role === "delivery") return `${base}/delivery`;
  if (role === "kitchen") return `${base}/kitchen`;
  if (role === "waiter") return `${base}/waiter`;
  return `${base}/login`.replace(/\/$/, "") || "/login";
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
  if (reason === "demo_expired") {
    return "Este demo venció. Pedí un nuevo acceso al equipo.";
  }
  if (reason === "tenant_mismatch") {
    return "Tu cuenta no pertenece a este demo. Iniciá sesión con el enlace correcto.";
  }
  return "Tu sesión ya no es válida. Iniciá sesión nuevamente.";
}

function DemoLayout() {
  const { demoSlug } = useParams();
  const slug = String(demoSlug || "").trim().toLowerCase();
  const session = getSession();
  if (session?.demoSlug && slug && session.demoSlug !== slug) {
    logout();
    return <Navigate to={`/d/${slug}/login`} replace />;
  }
  return (
    <DemoTenantContext.Provider value={{ demoSlug: slug || null }}>
      <Outlet />
    </DemoTenantContext.Provider>
  );
}

function LegacyTenantLayout() {
  return (
    <DemoTenantContext.Provider value={{ demoSlug: null }}>
      <Outlet />
    </DemoTenantContext.Provider>
  );
}

function AppRoutes() {
  const [session, setSession] = useState(() => getSession());
  const [sessionNotice, setSessionNotice] = useState("");
  const navigate = useNavigate();

  function handleLogout() {
    const path = loginRoutePath(getSession());
    logout();
    setSession(null);
    setSessionNotice("");
    navigate(path, { replace: true });
  }

  function onLoggedIn(nextSession) {
    setSessionNotice("");
    setSession(nextSession);
    navigate(homePathForRole(nextSession.role, nextSession), { replace: true });
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
      navigate(loginRoutePath(session), { replace: true });
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
      <Route
        path="/"
        element={
          DEFAULT_DEMO_SLUG ? (
            <Navigate to={`/d/${DEFAULT_DEMO_SLUG}/login`} replace />
          ) : session ? (
            <Navigate to={homePathForRole(session.role, session)} replace />
          ) : (
            <Navigate to="/start" replace />
          )
        }
      />
      <Route path="/start" element={<DemoHome />} />

      <Route path="/d/:demoSlug" element={<DemoLayout />}>
        <Route path="carta" element={<MesaClientApp />} />
        <Route path="menu" element={<PublicMenuApp />} />
        <Route
          path="login"
          element={
            session ? (
              <Navigate to={homePathForRole(session.role, session)} replace />
            ) : (
              <Login onLoggedIn={onLoggedIn} sessionNotice={sessionNotice} demoSlugFromRoute />
            )
          }
        />
        <Route
          path="admin"
          element={
            !session ? (
              <Navigate to="../login" replace />
            ) : session.role !== "admin" && session.role !== "maestro" && session.role !== "encargado" ? (
              <Navigate to={homePathForRole(session.role, session)} replace />
            ) : (
              <AdminApp onLogout={handleLogout} />
            )
          }
        />
        <Route
          path="delivery"
          element={
            !session ? (
              <Navigate to="../login" replace />
            ) : session.role !== "delivery" ? (
              <Navigate to={homePathForRole(session.role, session)} replace />
            ) : (
              <DeliveryApp onLogout={handleLogout} />
            )
          }
        />
        <Route
          path="kitchen"
          element={
            !session ? (
              <Navigate to="../login" replace />
            ) : session.role !== "kitchen" ? (
              <Navigate to={homePathForRole(session.role, session)} replace />
            ) : (
              <KitchenApp onLogout={handleLogout} />
            )
          }
        />
        <Route
          path="waiter"
          element={
            !session ? (
              <Navigate to="../login" replace />
            ) : session.role !== "waiter" ? (
              <Navigate to={homePathForRole(session.role, session)} replace />
            ) : (
              <WaiterApp onLogout={handleLogout} />
            )
          }
        />
      </Route>

      <Route element={<LegacyTenantLayout />}>
        <Route path="/carta" element={<MesaClientApp />} />
        <Route path="/menu" element={<PublicMenuApp />} />
        <Route
          path="/login"
          element={
            session ? (
              <Navigate to={homePathForRole(session.role, session)} replace />
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
              <Navigate to={homePathForRole(session.role, session)} replace />
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
              <Navigate to={homePathForRole(session.role, session)} replace />
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
              <Navigate to={homePathForRole(session.role, session)} replace />
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
              <Navigate to={homePathForRole(session.role, session)} replace />
            ) : (
              <WaiterApp onLogout={handleLogout} />
            )
          }
        />
      </Route>

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
