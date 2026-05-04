import { supabase } from "../supabaseClient";
import bcrypt from "bcryptjs";
import {
  deliveryMayLoginToday,
  formatAllowedWeekdaysSentence
} from "./deliverySchedule";

const SESSION_KEY = "restobot_session_v1";

export const ROLES = ["admin", "delivery"];

export const ROLE_LABELS = {
  admin: "Restaurante (admin)",
  delivery: "Repartidor (delivery)"
};

const DASHBOARD_USERS_TABLE = "dashboard_users";

function envPasswords() {
  return {
    admin: String(import.meta.env.VITE_ADMIN_PASSWORD || "").trim(),
    delivery: String(import.meta.env.VITE_DELIVERY_PASSWORD || "").trim()
  };
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !ROLES.includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function loginWithTableUser(username, password) {
  const norm = String(username || "")
    .trim()
    .toLowerCase();
  if (!norm) {
    return { ok: false, error: "Ingresá un usuario o usá la contraseña del rol sin completar usuario." };
  }
  const { data, error } = await supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, password_hash, role, is_active, delivery_work_weekdays")
    .eq("username", norm)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" || (error.message || "").includes("does not exist")) {
      return {
        ok: false,
        error: "Acceso de usuarios no disponible. Contactá al administrador."
      };
    }
    return { ok: false, error: `Error de acceso: ${error.message}` };
  }
  if (!data || !data.is_active) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (!ROLES.includes(data.role)) {
    return { ok: false, error: "Rol inválido en la base de datos." };
  }
  const ok = bcrypt.compareSync(String(password || ""), data.password_hash);
  if (!ok) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (
    data.role === "delivery" &&
    !deliveryMayLoginToday(data.delivery_work_weekdays)
  ) {
    const hint = formatAllowedWeekdaysSentence(data.delivery_work_weekdays);
    return {
      ok: false,
      error: `Hoy no podés entrar con esta cuenta de reparto. Días habilitados: ${hint}.`
    };
  }
  const session = {
    role: data.role,
    username: norm,
    userId: data.id,
    loginSource: "db",
    loggedInAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
  }
  return { ok: true, session };
}

function loginWithEnvPassword(role, password) {
  if (!ROLES.includes(role)) {
    return { ok: false, error: "Rol inválido." };
  }
  const expected = envPasswords()[role];
  if (!expected) {
    return {
      ok: false,
      error: `No hay acceso configurado para "${ROLE_LABELS[role]}". Contactá al administrador.`
    };
  }
  if (String(password || "") !== expected) {
    return { ok: false, error: "Contraseña incorrecta." };
  }
  const session = {
    role,
    loginSource: "env",
    loggedInAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
  }
  return { ok: true, session };
}

export async function login(p) {
  const username = String(p?.username || "").trim();
  if (username) {
    return loginWithTableUser(username, p.password);
  }
  return loginWithEnvPassword(p.role, p.password);
}

export function logout() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
  }
}
