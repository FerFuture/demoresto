import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import Login from "./screens/Login";
import AdminApp from "./screens/AdminApp";
import DeliveryApp from "./screens/DeliveryApp";
import KitchenApp from "./screens/KitchenApp";
import WaiterApp from "./screens/WaiterApp";
import { getSession, logout } from "./lib/auth";

function homePathForRole(role) {
  if (role === "admin") return "/admin";
  if (role === "delivery") return "/delivery";
  if (role === "kitchen") return "/kitchen";
  if (role === "waiter") return "/waiter";
  return "/login";
}

function AppRoutes() {
  const [session, setSession] = useState(() => getSession());
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    setSession(null);
    navigate("/login", { replace: true });
  }

  function onLoggedIn(nextSession) {
    setSession(nextSession);
    navigate(homePathForRole(nextSession.role), { replace: true });
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          session ? (
            <Navigate to={homePathForRole(session.role)} replace />
          ) : (
            <Login onLoggedIn={onLoggedIn} />
          )
        }
      />
      <Route
        path="/admin"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : session.role !== "admin" ? (
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
