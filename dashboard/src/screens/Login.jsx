import { useState } from "react";
import { useParams } from "react-router-dom";
import { login } from "../lib/auth";

/**
 * @param {{ onLoggedIn?: (s: object) => void, sessionNotice?: string, demoSlugFromRoute?: boolean }} props
 * Si `demoSlugFromRoute`, toma el slug de `/d/:demoSlug/login`.
 */
export default function Login({ onLoggedIn, sessionNotice = "", demoSlugFromRoute = false }) {
  const { demoSlug: slugFromUrl } = useParams();
  const effectiveSlug = demoSlugFromRoute ? String(slugFromUrl || "").trim() : "";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const usernameTrim = username.trim();

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await login({
        password,
        username: usernameTrim || undefined,
        demoSlug: effectiveSlug || undefined
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
          <p className="mt-1 text-sm text-slate-400">
            {effectiveSlug ? (
              <>
                Demo <span className="font-mono text-emerald-400/90">{effectiveSlug}</span> — usuario y contraseña,
                o solo contraseña de acceso
              </>
            ) : (
              <>
                Usuario y contraseña, o solo contraseña de acceso
                {String(import.meta.env.VITE_DEMO_HOST_STRICT_LOGIN || "").trim() === "1" ? (
                  <span className="block mt-2 text-amber-200/90 text-xs font-normal">
                    En este sitio hace falta <strong>usuario</strong> en esta pantalla. Para un demo usá el enlace{" "}
                    <span className="font-mono text-emerald-400/90">/d/…/login</span> que te compartieron.
                  </span>
                ) : null}
              </>
            )}
          </p>
          {(effectiveSlug ||
            String(import.meta.env.VITE_DEMO_LEGAL_BANNER || "").trim() === "1") && (
            <p className="mt-4 max-w-md mx-auto rounded-lg border border-slate-700/80 bg-slate-900/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
              Entorno de demostración: datos de prueba, sin SLA; pueden borrase o resetearse en cualquier momento.
            </p>
          )}
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
              autoFocus
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          {sessionNotice ? (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {sessionNotice}
            </div>
          ) : null}

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
      </div>
    </div>
  );
}
