import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import Login from "./screens/Login";
import AdminApp from "./screens/AdminApp";
import DeliveryApp from "./screens/DeliveryApp";
import { getSession, logout } from "./lib/auth";

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
    navigate(nextSession.role === "admin" ? "/admin" : "/delivery", { replace: true });
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          session ? (
            <Navigate to={session.role === "admin" ? "/admin" : "/delivery"} replace />
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
            <Navigate to="/delivery" replace />
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
            <Navigate to="/admin" replace />
          ) : (
            <DeliveryApp onLogout={handleLogout} />
          )
        }
      />
      <Route
        path="/"
        element={
          !session ? (
            <Navigate to="/login" replace />
          ) : (
            <Navigate to={session.role === "admin" ? "/admin" : "/delivery"} replace />
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
