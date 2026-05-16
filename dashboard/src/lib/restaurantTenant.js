/** Igual que `database.js`: solo dígitos para comparar WhatsApp. */
export function whatsappDigits(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Variantes del número del bot (misma lógica que getPossibleIncomingNumbers en database.js). */
export function botNumberMatchCandidates(rawNumber) {
  const normalized = whatsappDigits(rawNumber);
  if (!normalized) return [];

  const variants = new Set([normalized]);

  if (normalized.startsWith("569") && normalized.length === 11) {
    variants.add(`56${normalized.slice(3)}`);
  } else if (normalized.startsWith("56") && normalized.length === 10) {
    variants.add(`569${normalized.slice(2)}`);
  }

  return [...variants];
}

function rowMatchesCandidates(row, candidateSet) {
  const d = whatsappDigits(row?.whatsapp_number);
  if (!d) return false;
  if (candidateSet.has(d)) return true;
  return botNumberMatchCandidates(d).some((v) => candidateSet.has(v));
}

/** Slug de URL para demos: minúsculas, sin espacios laterales. */
export function normalizeDemoSlug(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Carga un restaurante por `demo_slug` (columna en `restaurants`).
 * Requiere haber ejecutado `dashboard/sql/demo_multi_tenant.sql` en Supabase.
 */
export async function fetchRestaurantByDemoSlug(supabase, rawSlug) {
  const slug = normalizeDemoSlug(rawSlug);
  if (!slug) {
    return { data: null, error: { message: "Falta el identificador del demo en la URL.", code: "missing_slug" } };
  }

  const { data, error } = await supabase
    .from("restaurants")
    .select(
      "id, name, whatsapp_number, demo_slug, demo_expires_at, is_demo, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
    )
    .eq("demo_slug", slug)
    .maybeSingle();

  if (error) {
    const msg = error.message || "";
    if (msg.includes("demo_slug") || msg.includes("column") || error.code === "42703") {
      return {
        data: null,
        error: {
          message:
            "La base todavía no tiene la columna demo_slug. Ejecutá dashboard/sql/demo_multi_tenant.sql en Supabase.",
          code: "schema"
        }
      };
    }
    return { data: null, error };
  }
  if (!data) {
    return { data: null, error: { message: "No existe un demo con ese enlace.", code: "not_found" } };
  }
  if (data.demo_expires_at && new Date(data.demo_expires_at).getTime() < Date.now()) {
    return {
      data: null,
      error: { message: "Este demo venció. Pedí un nuevo acceso al equipo.", code: "demo_expired" }
    };
  }
  return { data, error: null };
}

/**
 * Demo por slug en la URL (`/d/:demoSlug/...`) o modo legado (un solo tenant).
 */
export async function resolveRestaurantForDashboard(supabase, { demoSlug } = {}) {
  const s = String(demoSlug || "").trim();
  if (s) {
    return fetchRestaurantByDemoSlug(supabase, s);
  }
  return fetchRestaurantForDashboard(supabase);
}

/**
 * Resuelve la fila `restaurants` para el panel (anon).
 * - Con `VITE_BOT_WHATSAPP_NUMBER`: coincide con backend (.in + fallback por dígitos si la columna tiene + / espacios).
 * - Sin número: primera fila por `id` (un solo tenant).
 */
export async function fetchRestaurantForDashboard(supabase) {
  const configuredRaw = import.meta.env.VITE_BOT_WHATSAPP_NUMBER ?? "";
  const candidates = botNumberMatchCandidates(configuredRaw);

  if (candidates.length > 0) {
    const candidateSet = new Set(candidates);

    const { data: rowsIn, error: errIn } = await supabase
      .from("restaurants")
      .select(
        "id, name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
      )
      .in("whatsapp_number", candidates);

    if (errIn) return { data: null, error: errIn };

    const firstExact = (rowsIn || [])[0];
    if (firstExact) return { data: firstExact, error: null };

    const { data: rowsScan, error: errScan } = await supabase
      .from("restaurants")
      .select(
        "id, name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
      )
      .order("id", { ascending: true })
      .limit(200);

    if (errScan) return { data: null, error: errScan };

    const fallback = (rowsScan || []).find((row) => rowMatchesCandidates(row, candidateSet));
    return { data: fallback || null, error: null };
  }

  const { data, error } = await supabase
    .from("restaurants")
    .select(
      "id, name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
    )
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  return { data: data || null, error: error || null };
}
