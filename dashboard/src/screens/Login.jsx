import { useState } from "react";
import { login, ROLE_LABELS } from "../lib/auth";

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const usernameTrim = username.trim();
  const useEnvLogin = usernameTrim.length === 0;

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await login({
        role,
        password,
        username: usernameTrim || undefined
      });
      if (!result.ok) {
        setError(result.error || "No se pudo iniciar sesión.");
        return;
      }
      setPassword("");
      onLoggedIn?.(result.session);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight">RestoBot</h1>
          <p className="mt-1 text-sm text-slate-400">Ingresá según tu rol para continuar</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur"
        >
          <div className="mb-4">
            <label
              htmlFor="login-username"
              className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-400"
            >
              Usuario (opcional)
            </label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setError("");
              }}
              placeholder="ej: cocina1"
              className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="mb-5">
            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Rol
            </label>
            <div
              className={`grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-950 p-1 ${
                !useEnvLogin ? "opacity-50 pointer-events-none" : ""
              }`}
            >
              {Object.entries(ROLE_LABELS).map(([key, label]) => {
                const active = role === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setRole(key);
                      setError("");
                    }}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                      active
                        ? "bg-emerald-500 text-slate-950 shadow"
                        : "text-slate-300 hover:bg-slate-800/60"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {!useEnvLogin ? (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Con usuario, el rol no se elige aquí: viene de la base de datos.
              </p>
            ) : null}
          </div>

          <div className="mb-4">
            <label
              htmlFor="login-password"
              className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-400"
            >
              Contraseña
            </label>
            <input
              id="login-password"
              type="password"
              autoFocus={useEnvLogin}
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          {error ? (
            <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="h-11 w-full rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {submitting ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
        <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-500">
          No hace falta una URL distinta por repartidor: cada uno entra con su usuario. Para abrir{" "}
          <span className="text-slate-400">dos repartidores a la vez</span> usá otro navegador o una ventana de
          incógnito (la sesión se guarda por navegador, no por pestaña). Enlaces directos:{" "}
          <span className="text-slate-400">/delivery</span> y <span className="text-slate-400">/admin</span>.
        </p>
      </div>
    </div>
  );
}
