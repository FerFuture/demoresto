/**
 * Pantalla inicial cuando no hay VITE_DEFAULT_DEMO_SLUG:
 * los demos se abren con /d/{slug}/login (slug = columna restaurants.demo_slug).
 */
export default function DemoHome() {
  const example = "mi-restaurante";
  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-lg space-y-4 text-center">
        <h1 className="text-2xl font-bold tracking-tight">RestoBot · demos</h1>
        <p className="text-sm text-slate-400">
          Cada cliente recibe un enlace con su identificador. Pedí al equipo tu acceso o usá el que tenés
          asignado.
        </p>
        <p className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 font-mono text-xs text-slate-300">
          {typeof window !== "undefined" ? window.location.origin : ""}
          <span className="text-emerald-400">/d/{example}/login</span>
        </p>
        <p className="text-xs text-slate-500">
          El valor <span className="text-slate-400">{example}</span> se reemplaza por el slug de tu demo en la base
          de datos.
        </p>
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-100/90">
          Entorno de demostración: datos de prueba, sin SLA; pueden borrase o resetearse en cualquier momento.
        </p>
      </div>
    </div>
  );
}
