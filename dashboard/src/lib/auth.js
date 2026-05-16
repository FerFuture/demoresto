import bcrypt from "bcryptjs";
import { supabase } from "../supabaseClient";
import {
  deliveryMayLoginToday,
  formatAllowedWeekdaysSentence
} from "./deliverySchedule";
import { fetchRestaurantByDemoSlug, normalizeDemoSlug } from "./restaurantTenant";
import { buildRestobotHttpApiCandidates, RESTOBOT_DB_LOGIN_API_PATH } from "./restobotHttpApi";

const SESSION_KEY = "restobot_session_v1";
export const SESSION_REVALIDATE_MS = 120_000;

/** Roles que pueden guardarse en sesión (incluye maestro: solo login por env, no alta en BD). */
export const SESSION_ROLES = ["admin", "encargado", "delivery", "kitchen", "waiter", "maestro"];

/** Roles permitidos en la tabla `dashboard_users`. */
export const DB_USER_ROLES = ["admin", "encargado", "delivery", "kitchen", "waiter"];

export const ROLE_LABELS = {
  admin: "Restaurante (admin)",
  encargado: "Encargado",
  delivery: "Repartidor (delivery)",
  kitchen: "Cocina",
  waiter: "Mozo",
  maestro: "Maestro"
};

const DASHBOARD_USERS_TABLE = "dashboard_users";

/** Prefijo de rutas para la sesión actual (`/d/slug` o ""). */
export function demoBasePath(session) {
  const slug = session?.demoSlug ? String(session.demoSlug).trim() : "";
  return slug ? `/d/${slug}` : "";
}

export function loginRoutePath(session = null) {
  const slug = session?.demoSlug ? String(session.demoSlug).trim() : "";
  if (slug) return `/d/${slug}/login`;
  return "/login";
}

/** Misma lógica que el servidor (`index.js`): el login preferido usa POST /api/dashboard/db-login (sin leer password_hash por anon). */
function verifyPasswordLocal(password, passwordHash) {
  const pw = String(password || "");
  const hash = String(passwordHash || "");
  if (!hash) return false;
  try {
    return bcrypt.compareSync(pw, hash);
  } catch {
    return false;
  }
}

function envPasswords() {
  return {
    admin: String(import.meta.env.VITE_ADMIN_PASSWORD || "").trim(),
    delivery: String(import.meta.env.VITE_DELIVERY_PASSWORD || "").trim(),
    kitchen: String(import.meta.env.VITE_KITCHEN_PASSWORD || "").trim(),
    waiter: String(import.meta.env.VITE_WAITER_PASSWORD || "").trim(),
    maestro: String(import.meta.env.VITE_MAESTRO_PASSWORD || "").trim()
  };
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !SESSION_ROLES.includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
  }
}

function normalizeSessionUpdatedAt(value) {
  return value ? String(value) : "";
}

const DB_LOGIN_API_TIMEOUT_MS = 18_000;

async function tryLoginDbUserViaBotApi(usernameNorm, password, restaurantId) {
  const urls = buildRestobotHttpApiCandidates(RESTOBOT_DB_LOGIN_API_PATH);
  if (!urls.length) return null;
  const body = {
    username: usernameNorm,
    password: String(password ?? ""),
    restaurantId: restaurantId || null
  };
  const controller = new AbortController();
  const t = window.setTimeout(() => controller.abort(), DB_LOGIN_API_TIMEOUT_MS);
  try {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          continue;
        }
        if (json && typeof json === "object" && "ok" in json) {
          return { res, json };
        }
      } catch {
        continue;
      }
    }
  } finally {
    window.clearTimeout(t);
  }
  return null;
}

export async function validateStoredSession(session = getSession()) {
  if (!session) return { ok: false, reason: "missing" };
  if (session.loginSource !== "db") {
    if (session.restaurantId) {
      const { data: r, error } = await supabase
        .from("restaurants")
        .select("demo_expires_at")
        .eq("id", session.restaurantId)
        .maybeSingle();
      if (!error && r?.demo_expires_at && new Date(r.demo_expires_at).getTime() < Date.now()) {
        return { ok: false, reason: "demo_expired" };
      }
    }
    return { ok: true, session };
  }
  if (!session.userId || !DB_USER_ROLES.includes(session.role)) {
    return { ok: false, reason: "invalid_session" };
  }

  const { data, error } = await supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, role, is_active, updated_at, restaurant_id")
    .eq("id", session.userId)
    .maybeSingle();

  if (error) {
    return { ok: true, session, warning: error.message || "No se pudo validar la sesión." };
  }
  if (!data || !data.is_active) {
    return { ok: false, reason: "user_inactive_or_deleted" };
  }
  if (data.role !== session.role) {
    return { ok: false, reason: "role_changed" };
  }

  if (session.restaurantId) {
    if (!data.restaurant_id || data.restaurant_id !== session.restaurantId) {
      return { ok: false, reason: "tenant_mismatch" };
    }
    const { data: rmeta, error: rErr } = await supabase
      .from("restaurants")
      .select("demo_expires_at")
      .eq("id", session.restaurantId)
      .maybeSingle();
    if (!rErr && rmeta?.demo_expires_at && new Date(rmeta.demo_expires_at).getTime() < Date.now()) {
      return { ok: false, reason: "demo_expired" };
    }
  }

  const dbUpdatedAt = normalizeSessionUpdatedAt(data.updated_at);
  const sessionUpdatedAt = normalizeSessionUpdatedAt(session.userUpdatedAt);
  if (!sessionUpdatedAt) {
    const nextSession = { ...session, userUpdatedAt: dbUpdatedAt };
    saveSession(nextSession);
    return { ok: true, session: nextSession };
  }
  if (dbUpdatedAt && dbUpdatedAt !== sessionUpdatedAt) {
    return { ok: false, reason: "user_updated" };
  }

  return { ok: true, session };
}

async function loginWithTableUser(username, password, tenantCtx = {}) {
  const { restaurantId = null, demoSlug = null } = tenantCtx;
  const norm = String(username || "")
    .trim()
    .toLowerCase();
  if (!norm) {
    return { ok: false, error: "Ingresá un usuario o usá la contraseña del rol sin completar usuario." };
  }

  const apiResult = await tryLoginDbUserViaBotApi(norm, password, restaurantId);
  if (apiResult?.json?.ok === true && apiResult.json.user?.id) {
    const u = apiResult.json.user;
    const session = {
      role: u.role,
      username: norm,
      userId: u.id,
      userUpdatedAt: normalizeSessionUpdatedAt(u.updated_at),
      loginSource: "db",
      loggedInAt: new Date().toISOString()
    };
    if (tenantCtx.restaurantId) session.restaurantId = tenantCtx.restaurantId;
    if (tenantCtx.demoSlug) session.demoSlug = tenantCtx.demoSlug;
    saveSession(session);
    return { ok: true, session };
  }
  if (apiResult?.json && apiResult.json.ok === false && apiResult.json.error) {
    return { ok: false, error: apiResult.json.error };
  }

  let q = supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, password_hash, role, is_active, delivery_work_weekdays, updated_at, restaurant_id")
    .eq("username", norm);
  if (restaurantId) {
    q = q.eq("restaurant_id", restaurantId);
  }
  const { data, error } = await q.maybeSingle();

  if (error) {
    if (error.code === "42P01" || (error.message || "").includes("does not exist")) {
      return {
        ok: false,
        error: "Acceso de usuarios no disponible. Contactá al administrador."
      };
    }
    if (error.code === "42703" || (error.message || "").includes("restaurant_id")) {
      return {
        ok: false,
        error:
          "La base no tiene restaurant_id en dashboard_users. Ejecutá dashboard/sql/demo_multi_tenant.sql en Supabase."
      };
    }
    return { ok: false, error: `Error de acceso: ${error.message}` };
  }
  if (!data || !data.is_active) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (!DB_USER_ROLES.includes(data.role)) {
    return { ok: false, error: "Rol inválido en la base de datos." };
  }
  if (restaurantId && data.restaurant_id && data.restaurant_id !== restaurantId) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  const ok = verifyPasswordLocal(String(password || ""), data.password_hash);
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
    userUpdatedAt: normalizeSessionUpdatedAt(data.updated_at),
    loginSource: "db",
    loggedInAt: new Date().toISOString()
  };
  if (tenantCtx.restaurantId) session.restaurantId = tenantCtx.restaurantId;
  if (tenantCtx.demoSlug) session.demoSlug = tenantCtx.demoSlug;
  saveSession(session);
  return { ok: true, session };
}

function loginWithEnvPassword(role, password, tenantCtx = {}) {
  if (!SESSION_ROLES.includes(role)) {
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
  if (tenantCtx.restaurantId) session.restaurantId = tenantCtx.restaurantId;
  if (tenantCtx.demoSlug) session.demoSlug = tenantCtx.demoSlug;
  saveSession(session);
  return { ok: true, session };
}

/**
 * Sin usuario: prueba la contraseña contra cada VITE_*_PASSWORD definida; el rol queda en el que coincida.
 * (Si dos roles comparten la misma clave, gana el primero en `SESSION_ROLES`.)
 */
function loginWithEnvPasswordMatchAnyRole(password, tenantCtx = {}) {
  const pw = String(password || "");
  for (const role of SESSION_ROLES) {
    const expected = envPasswords()[role];
    if (!expected) continue;
    if (pw !== expected) continue;
    return loginWithEnvPassword(role, password, tenantCtx);
  }
  return { ok: false, error: "Contraseña incorrecta." };
}

/**
 * @param {{ username?: string, password: string, role?: string, demoSlug?: string | null }} p
 * - Con `demoSlug` (ruta `/d/:slug/login`): valida tenant y ata usuarios DB a ese `restaurant_id`.
 */
export async function login(p) {
  const demoSlugInput = p?.demoSlug;
  let tenantCtx = {};
  if (demoSlugInput != null && String(demoSlugInput).trim() !== "") {
    const { data: rest, error } = await fetchRestaurantByDemoSlug(supabase, demoSlugInput);
    if (error) {
      return { ok: false, error: error.message || "No se pudo validar el demo." };
    }
    if (!rest) {
      return { ok: false, error: "Demo no encontrado." };
    }
    tenantCtx = { restaurantId: rest.id, demoSlug: normalizeDemoSlug(demoSlugInput) };
  }

  const username = String(p?.username || "").trim();
  if (username) {
    return loginWithTableUser(username, p.password, tenantCtx);
  }
  if (p?.role) {
    return loginWithEnvPassword(p.role, p.password, tenantCtx);
  }
  return loginWithEnvPasswordMatchAnyRole(p.password, tenantCtx);
}

export function logout() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
  }
}
