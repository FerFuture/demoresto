import { useCallback, useEffect, useState } from "react";
import bcrypt from "bcryptjs";
import { supabase } from "../supabaseClient";
import { ROLE_LABELS } from "../lib/auth";
import {
  ALL_WEEKDAY_VALUES,
  WEEKDAY_OPTIONS,
  deliveryWeekdaysFromDb,
  deliveryWeekdaysToDb
} from "../lib/deliverySchedule";

const TABLE = "dashboard_users";
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

function WeekdayToggle({ value, onChange, disabled }) {
  function toggle(day) {
    const set = new Set(value);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    onChange(Array.from(set).sort((a, b) => a - b));
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAY_OPTIONS.map(({ value: v, label }) => {
        const on = value.includes(v);
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => toggle(v)}
            className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
              on
                ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                : "border-slate-700 bg-slate-950 text-slate-500 hover:border-slate-600"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function DashboardUsersPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  const [newUser, setNewUser] = useState({
    username: "",
    password: "",
    role: "delivery",
    label: "",
    deliveryWeekdays: [...ALL_WEEKDAY_VALUES]
  });

  const loadUsers = useCallback(async () => {
    setError("");
    setLoading(true);
    const { data, error: qErr } = await supabase
      .from(TABLE)
      .select(
        "id, username, role, label, is_active, delivery_work_weekdays, created_at, updated_at"
      )
      .order("created_at", { ascending: false });
    setLoading(false);
    if (qErr) {
      setError(
        qErr.message.includes("does not exist") || qErr.code === "42P01"
          ? "No se pudo cargar la lista de usuarios. Contactá al administrador."
          : `Error cargando usuarios: ${qErr.message}`
      );
      setRows([]);
      return;
    }
    setRows(data || []);
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function handleCreate(event) {
    event.preventDefault();
    setError("");
    const u = newUser.username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
      setError("Usuario: 3–40 caracteres, solo minúsculas, números, . _ -");
      return;
    }
    const pw = String(newUser.password || "");
    if (pw.length < 6) {
      setError("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    if (newUser.role === "delivery") {
      const wDb = deliveryWeekdaysToDb("delivery", newUser.deliveryWeekdays);
      if (Array.isArray(wDb) && wDb.length === 0) {
        setError("Elegí al menos un día de trabajo para la cuenta de reparto.");
        return;
      }
    }
    const hash = bcrypt.hashSync(pw, 10);
    setSavingId("__new__");
    const { error: insErr } = await supabase.from(TABLE).insert({
      username: u,
      password_hash: hash,
      role: newUser.role,
      label: newUser.label.trim() || null,
      is_active: true,
      delivery_work_weekdays:
        newUser.role === "delivery"
          ? deliveryWeekdaysToDb("delivery", newUser.deliveryWeekdays)
          : null,
      updated_at: new Date().toISOString()
    });
    setSavingId(null);
    if (insErr) {
      setError(
        insErr.code === "23505"
          ? "Ese nombre de usuario ya existe."
          : `No se pudo crear: ${insErr.message}`
      );
      return;
    }
    setNewUser({
      username: "",
      password: "",
      role: "delivery",
      label: "",
      deliveryWeekdays: [...ALL_WEEKDAY_VALUES]
    });
    await loadUsers();
  }

  async function toggleActive(row) {
    setError("");
    setSavingId(row.id);
    const { error: upErr } = await supabase
      .from(TABLE)
      .update({
        is_active: !row.is_active,
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id);
    setSavingId(null);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await loadUsers();
  }

  async function saveRowEdit(row, draft) {
    setError("");
    const u = draft.username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
      setError("Usuario inválido.");
      return;
    }
    if (draft.role === "delivery") {
      const wDb = deliveryWeekdaysToDb("delivery", draft.deliveryWeekdays);
      if (Array.isArray(wDb) && wDb.length === 0) {
        setError("Elegí al menos un día de trabajo para la cuenta de reparto.");
        return;
      }
    }
    const patch = {
      username: u,
      role: draft.role,
      label: draft.label.trim() || null,
      delivery_work_weekdays: deliveryWeekdaysToDb(draft.role, draft.deliveryWeekdays),
      updated_at: new Date().toISOString()
    };
    const pw = String(draft.password || "").trim();
    if (pw.length > 0) {
      if (pw.length < 6) {
        setError("La contraseña debe tener al menos 6 caracteres.");
        return;
      }
      patch.password_hash = bcrypt.hashSync(pw, 10);
    }
    setSavingId(row.id);
    const { error: upErr } = await supabase.from(TABLE).update(patch).eq("id", row.id);
    setSavingId(null);
    if (upErr) {
      setError(upErr.code === "23505" ? "Ese nombre de usuario ya existe." : upErr.message);
      return;
    }
    await loadUsers();
  }

  async function removeRow(row) {
    if (
      !window.confirm(
        `¿Eliminar definitivamente el usuario "${row.username}"? Esta acción no se puede deshacer.`
      )
    ) {
      return;
    }
    setError("");
    setSavingId(row.id);
    const { error: delErr } = await supabase.from(TABLE).delete().eq("id", row.id);
    setSavingId(null);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadUsers();
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Usuarios del panel</h2>
        <p className="mt-1 text-xs text-slate-400">
          Altas de cuentas para admin o reparto. Para reparto, elegí los días en que puede iniciar sesión cada usuario.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      <form
        onSubmit={handleCreate}
        className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-5 md:grid-cols-2"
      >
        <h3 className="md:col-span-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Nuevo usuario
        </h3>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Usuario</span>
          <input
            value={newUser.username}
            onChange={(e) => setNewUser((p) => ({ ...p, username: e.target.value }))}
            placeholder="ej: reparto1"
            className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
            autoComplete="off"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Contraseña inicial</span>
          <input
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
            placeholder="mínimo 6 caracteres"
            className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
            autoComplete="new-password"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Rol</span>
          <select
            value={newUser.role}
            onChange={(e) => setNewUser((p) => ({ ...p, role: e.target.value }))}
            className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
          >
            <option value="admin">{ROLE_LABELS.admin}</option>
            <option value="delivery">{ROLE_LABELS.delivery}</option>
          </select>
        </label>
        {newUser.role === "delivery" ? (
          <div className="md:col-span-2 space-y-2">
            <span className="text-xs text-slate-400">Días en que puede entrar al panel de reparto</span>
            <WeekdayToggle
              value={newUser.deliveryWeekdays}
              onChange={(next) => setNewUser((p) => ({ ...p, deliveryWeekdays: next }))}
            />
          </div>
        ) : null}
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Etiqueta (opcional)</span>
          <input
            value={newUser.label}
            onChange={(e) => setNewUser((p) => ({ ...p, label: e.target.value }))}
            placeholder="Ej: Juan — turno noche"
            className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
          />
        </label>
        <div className="md:col-span-2 flex justify-end">
          <button
            type="submit"
            disabled={savingId === "__new__"}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {savingId === "__new__" ? "Guardando…" : "Crear usuario"}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
          Cargando usuarios…
        </div>
      ) : (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Usuarios ({rows.length})
          </h3>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">Todavía no hay usuarios en la base.</p>
          ) : (
            rows.map((row) => (
              <UserRowCard
                key={row.id}
                row={row}
                saving={savingId === row.id}
                onSave={saveRowEdit}
                onToggleActive={toggleActive}
                onDelete={removeRow}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function UserRowCard({ row, saving, onSave, onToggleActive, onDelete }) {
  const [draft, setDraft] = useState({
    username: row.username,
    role: row.role,
    label: row.label || "",
    password: "",
    deliveryWeekdays: deliveryWeekdaysFromDb(row.delivery_work_weekdays)
  });

  useEffect(() => {
    setDraft({
      username: row.username,
      role: row.role,
      label: row.label || "",
      password: "",
      deliveryWeekdays: deliveryWeekdaysFromDb(row.delivery_work_weekdays)
    });
  }, [row.id, row.username, row.role, row.label, row.delivery_work_weekdays]);

  return (
    <article className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2 text-sm">
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Usuario</span>
            <input
              value={draft.username}
              onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
              className="h-9 w-full max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Rol</span>
            <select
              value={draft.role}
              onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
              className="h-9 w-full max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm"
            >
              <option value="admin">{ROLE_LABELS.admin}</option>
              <option value="delivery">{ROLE_LABELS.delivery}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Etiqueta</span>
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              className="h-9 w-full max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm"
            />
          </label>
          {draft.role === "delivery" ? (
            <div className="space-y-1">
              <span className="text-xs text-slate-500">Días de acceso al panel</span>
              <WeekdayToggle
                value={draft.deliveryWeekdays}
                disabled={saving}
                onChange={(next) => setDraft((d) => ({ ...d, deliveryWeekdays: next }))}
              />
            </div>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Nueva contraseña (opcional)</span>
            <input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
              placeholder="dejar vacío para no cambiar"
              className="h-9 w-full max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm"
              autoComplete="new-password"
            />
          </label>
          <p className="text-[11px] text-slate-500">
            Creado: {row.created_at ? new Date(row.created_at).toLocaleString("es-AR") : "—"}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-center text-[11px] font-medium ${
              row.is_active
                ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border border-slate-600 bg-slate-800 text-slate-400"
            }`}
          >
            {row.is_active ? "Activo" : "Desactivado"}
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave(row, draft)}
            className="rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {saving ? "…" : "Guardar cambios"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onToggleActive(row)}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {row.is_active ? "Desactivar" : "Reactivar"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onDelete(row)}
            className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
          >
            Eliminar
          </button>
        </div>
      </div>
    </article>
  );
}
