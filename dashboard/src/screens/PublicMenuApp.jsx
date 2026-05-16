import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import { resolveRestaurantForDashboard } from "../lib/restaurantTenant";
import { useDemoTenant } from "../lib/DemoTenantContext";
import { currency } from "../lib/format";

function groupMenuByCategory(menuItems) {
  const byCat = new Map();
  for (const it of menuItems || []) {
    const cat = String(it.category || "Otros").trim() || "Otros";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(it);
  }
  const entries = Array.from(byCat.entries()).map(([cat, items]) => [
    cat,
    [...items].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "es", {
        sensitivity: "base",
        numeric: true
      })
    )
  ]);
  entries.sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]), "es", { sensitivity: "base", numeric: true })
  );
  return entries;
}

/**
 * Menú público solo lectura (ruta /menu). Sin carrito ni pedidos.
 */
export default function PublicMenuApp() {
  const { demoSlug } = useDemoTenant();
  const [restaurantName, setRestaurantName] = useState("");
  const [menuEnabled, setMenuEnabled] = useState(true);
  const [menuItems, setMenuItems] = useState([]);
  const [menuSearchQuery, setMenuSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const { data, error: queryError } = await resolveRestaurantForDashboard(supabase, { demoSlug });
        if (cancelled) return;
        if (queryError) throw queryError;
        if (!data) {
          setError("No se encontró el restaurante.");
          return;
        }
        setRestaurantName(data.public_name || data.name || "Restaurante");
        const metadataObj =
          data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
            ? data.metadata
            : {};
        setMenuEnabled(metadataObj.qr_menu_enabled !== false);

        const { data: items, error: menuError } = await supabase
          .from("menu_items")
          .select("id, name, price, category, description")
          .eq("restaurant_id", data.id)
          .eq("available", true)
          .order("name", { ascending: true });
        if (cancelled) return;
        if (menuError) throw menuError;
        setMenuItems(items || []);
      } catch (e) {
        if (!cancelled) setError(`Error cargando menú: ${e?.message || e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demoSlug]);

  const menuItemsFiltered = useMemo(() => {
    const raw = String(menuSearchQuery || "").trim().toLowerCase();
    if (!raw) return menuItems;
    const words = raw.split(/\s+/).filter(Boolean);
    return menuItems.filter((item) => {
      const haystack = [item.name, item.category, item.description, item.price != null ? String(item.price) : ""]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [menuSearchQuery, menuItems]);

  const groupedMenu = useMemo(() => groupMenuByCategory(menuItemsFiltered), [menuItemsFiltered]);

  if (loading) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <p className="text-sm text-slate-300">Cargando menú…</p>
      </div>
    );
  }

  if (!menuEnabled) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <p className="text-lg font-semibold text-slate-100">Menú no disponible</p>
          <p className="mt-2 text-sm text-slate-400">Consultá con el personal del local.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <h1 className="text-lg font-semibold text-white">{restaurantName}</h1>
          <p className="mt-0.5 text-xs text-slate-400">Menú · solo consulta</p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-5 space-y-5 pb-10">
        {error ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
            {error}
          </div>
        ) : null}

        {menuItems.length > 0 ? (
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <label className="block">
              <span className="sr-only">Buscar en el menú</span>
              <input
                type="search"
                value={menuSearchQuery}
                onChange={(e) => setMenuSearchQuery(e.target.value)}
                placeholder="Buscar producto…"
                autoComplete="off"
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
              />
            </label>
          </section>
        ) : null}

        {menuItems.length === 0 && !error ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center text-slate-300">
            No hay productos disponibles en el menú.
          </div>
        ) : null}

        {menuItems.length > 0 && menuItemsFiltered.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-center text-slate-300">
            No hay productos que coincidan con &quot;{menuSearchQuery.trim()}&quot;.
          </div>
        ) : null}

        <section className="space-y-5">
          {groupedMenu.map(([category, items]) => (
            <div key={category} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-300/90">{category}</h2>
              <ul className="space-y-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-xl border border-slate-700/80 bg-slate-900/40 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-100">{item.name}</p>
                        {item.description ? (
                          <p className="mt-1 text-sm text-slate-400">{item.description}</p>
                        ) : null}
                      </div>
                      <p className="shrink-0 text-sm font-semibold tabular-nums text-emerald-300/90">
                        {currency(item.price)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
